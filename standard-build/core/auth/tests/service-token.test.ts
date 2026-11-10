// core/auth/tests/service-token.test.ts
// 受限服务令牌(svc_…)：签发(校验背靠最小权限账号)/解析(复查在职)/吊销 + HTTP 用 scopes 封顶。
// 用最小 Hono app(requireAuth + 受 requirePermission 把守的探针路由)直接验证中间件，
// 避免 createApp 牵连可选依赖(xlsx 等)的导入链。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { createEmployee } from '../../org/logic/employee'
import { employees } from '../../org/model'
import { decryptSecret } from '../../crypto/secret-box'
import { mapError } from '../../http/errors'
import { requireAuth, requirePermission, type AppEnv } from '../../http/middleware'
import { serviceTokens } from '../model'
import { getOrMintAiSessionToken, mintServiceToken, resolveServiceToken, revokeServiceToken } from '../service-token'
import type { Ctx } from '../../db/client'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

let t: OrgTestDb
let app: Hono<AppEnv>
let ownerCtx: Ctx
let rootDeptId: string
let svcEmpId: string // 最小权限的服务账号(非 owner/超管)，令牌背靠它
let svcCtx: Ctx // 上面那个服务账号自己的 ctx(演示「普通员工想签一枚背靠 owner 的令牌」)
let aiEmpA: string // 各 ai_session 用例各用一名员工 —— 部分唯一索引限制每人只能有一枚活的
let aiEmpB: string
let cacheCtx: Ctx // 缓存/轮换用例专用

async function api(method: string, path: string, key?: string) {
  const res = await app.request(path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}) } })
  return { status: res.status }
}

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ownerCtx = seeded.ownerCtx
  rootDeptId = seeded.rootDept.id
  // 专用服务账号：普通员工，非 owner/超管。
  const svcEmp = await createEmployee(t.db, ownerCtx, { name: 'getdeployed-svc', empNo: 'SVC001', phone: '13900000001', departmentId: rootDeptId })
  svcEmpId = svcEmp.id
  svcCtx = { ...ownerCtx, employeeId: svcEmpId }
  const mk = async (n: string, no: string, phone: string) =>
    (await createEmployee(t.db, ownerCtx, { name: n, empNo: no, phone, departmentId: rootDeptId })).id
  aiEmpA = await mk('ai-a', 'AI001', '13900000011')
  aiEmpB = await mk('ai-b', 'AI002', '13900000012')
  cacheCtx = { ...ownerCtx, employeeId: await mk('ai-cache', 'AI003', '13900000013') }
  // 令牌缓存要能取回原文 → secret-box 需要主密钥。测试进程里显式给一个。
  process.env.CONFIG_ENC_KEY ??= 'svc-token-test-master-key'

  const secret = 'svc-test-secret'
  app = new Hono<AppEnv>()
  app.onError((err, c) => {
    const { status, body } = mapError(err)
    return c.json(body, status)
  })
  app.use('/api/*', requireAuth(t.db, secret))
  app.get('/api/probe-view', requirePermission(t.db, 'org:view'), (c) => c.json({ ok: true }))
  app.post('/api/probe-manage', requirePermission(t.db, 'org:manage'), (c) => c.json({ ok: true }))
})
afterAll(() => t.close())

describe('service-token logic', () => {
  it('mint(背靠服务账号) → resolve 返回 ctx + scopes；原文不入库；未知/坏格式/吊销 → null', async () => {
    const { id, rawKey } = await mintServiceToken(t.db, ownerCtx, { name: 'agent', scopes: ['org:view'], employeeId: svcEmpId })
    expect(rawKey.startsWith('svc_')).toBe(true)
    const resolved = await resolveServiceToken(t.db, rawKey)
    expect(resolved).toMatchObject({ tenantId: ownerCtx.tenantId, employeeId: svcEmpId, scopes: ['org:view'] })
    // 原文不入库：库里存的是 sha256，不等于原文
    const rows = await t.db.select().from(serviceTokens)
    expect(rows.every((r) => r.tokenHash !== rawKey)).toBe(true)
    // 坏格式/未知/非 svc_ → null
    expect(await resolveServiceToken(t.db, 'svc_deadbeef')).toBeNull() // 长度不符
    expect(await resolveServiceToken(t.db, 'not-a-svc-token')).toBeNull()
    // 吊销后失效
    await revokeServiceToken(t.db, ownerCtx, id)
    expect(await resolveServiceToken(t.db, rawKey)).toBeNull()
  })

  it('拒绝背靠 owner/超管', async () => {
    await expect(
      mintServiceToken(t.db, ownerCtx, { name: 'bad', scopes: ['org:view'], employeeId: ownerCtx.employeeId }),
    ).rejects.toThrow()
    // 缺省背靠 ctx.employeeId(=owner) 也应拒绝
    await expect(mintServiceToken(t.db, ownerCtx, { name: 'bad2', scopes: ['org:view'] })).rejects.toThrow()
  })

  it('背靠员工离职/停用 → resolve 失效', async () => {
    const tmp = await createEmployee(t.db, ownerCtx, { name: 'svc-temp', empNo: 'SVC002', phone: '13900000002', departmentId: rootDeptId })
    const { rawKey } = await mintServiceToken(t.db, ownerCtx, { name: 'temp', scopes: ['org:view'], employeeId: tmp.id })
    expect(await resolveServiceToken(t.db, rawKey)).not.toBeNull() // 在职可用
    await t.db.update(employees).set({ status: 'left' }).where(eq(employees.id, tmp.id))
    expect(await resolveServiceToken(t.db, rawKey)).toBeNull() // 停用后即时失效
  })
})

// ───────── Ask AI 自助会话令牌(Phase 0 地基)─────────
// 这一组的核心不变量:自助分支是「背靠本人 + 有期限」的**正交**口子,不是把 owner 护栏放宽。
// 上面那条「拒绝背靠 owner/超管」必须一直绿 —— 它是这组测试的对照面。
describe('ai_session 自助会话令牌', () => {
  const activeAiRows = () =>
    t.db
      .select()
      .from(serviceTokens)
      .where(and(eq(serviceTokens.purpose, 'ai_session'), isNull(serviceTokens.revokedAt)))

  it('背靠 owner + 自助 + 有期限 → 铸得出(老板本人也能开 Ask AI)', async () => {
    const { rawKey } = await mintServiceToken(t.db, ownerCtx, {
      name: 'ask-ai', scopes: ['org:view'], employeeId: ownerCtx.employeeId,
      purpose: 'ai_session', expiresAt: new Date(Date.now() + 60_000), selfService: true,
    })
    const resolved = await resolveServiceToken(t.db, rawKey)
    expect(resolved).toMatchObject({ employeeId: ownerCtx.employeeId, scopes: ['org:view'] })
  })

  it('豁免要四条同时成立 —— 缺任一条都退回原护栏', async () => {
    const base = { name: 'x', scopes: ['org:view'], employeeId: ownerCtx.employeeId }
    const exp = new Date(Date.now() + 60_000)
    // 缺 selfService
    await expect(mintServiceToken(t.db, ownerCtx, { ...base, purpose: 'ai_session', expiresAt: exp })).rejects.toThrow()
    // 缺 expiresAt(长期令牌背靠 owner —— 正是原护栏要防的那种)
    await expect(mintServiceToken(t.db, ownerCtx, { ...base, purpose: 'ai_session', selfService: true })).rejects.toThrow()
    // purpose 不是 ai_session
    await expect(mintServiceToken(t.db, ownerCtx, { ...base, expiresAt: exp, selfService: true })).rejects.toThrow()
    // 背靠的不是本人(拿别人的身份签 —— 这就是提权)
    await expect(
      mintServiceToken(t.db, ownerCtx, { ...base, employeeId: aiEmpA, purpose: 'ai_session', expiresAt: exp, selfService: true }),
    ).resolves.toBeTruthy() // svcEmp 非特权，走的是原路径而非豁免：能过，但不是靠 selfService
    await expect(
      mintServiceToken(t.db, svcCtx, { name: 'y', scopes: [], employeeId: ownerCtx.employeeId, purpose: 'ai_session', expiresAt: exp, selfService: true }),
    ).rejects.toThrow() // 普通员工想签一枚背靠 owner 的令牌 → 仍然拒绝
  })

  it('过期令牌 resolve 返回 null(存量 expires_at=NULL 的不受影响)', async () => {
    // 自己一名员工:上面那条已经给 owner 铸过一枚活的，每人只能有一枚
    const emp = await createEmployee(t.db, ownerCtx, { name: 'ai-exp', empNo: 'AI004', phone: '13900000014', departmentId: rootDeptId })
    const expCtx: Ctx = { ...ownerCtx, employeeId: emp.id }
    const { rawKey } = await mintServiceToken(t.db, expCtx, {
      name: 'expired', scopes: ['org:view'], employeeId: emp.id,
      purpose: 'ai_session', expiresAt: new Date(Date.now() - 1_000), selfService: true,
    })
    expect(await resolveServiceToken(t.db, rawKey)).toBeNull()
    // 对照:不带 expiresAt 的普通令牌照旧有效
    const legacy = await mintServiceToken(t.db, ownerCtx, { name: 'legacy', scopes: ['org:view'], employeeId: svcEmpId })
    expect(await resolveServiceToken(t.db, legacy.rawKey)).not.toBeNull()
    await revokeServiceToken(t.db, ownerCtx, legacy.id)
  })

  it('明文不入库:secret_enc 解得回原文，库里搜不到 svc_ 明文', async () => {
    const { rawKey } = await mintServiceToken(t.db, ownerCtx, {
      name: 'enc', scopes: ['org:view'], employeeId: aiEmpB,
      purpose: 'ai_session', expiresAt: new Date(Date.now() + 60_000), selfService: true,
    })
    const row = (await t.db.select().from(serviceTokens).where(eq(serviceTokens.tokenHash, sha256(rawKey))))[0]!
    expect(row.secretEnc).toBeTruthy()
    expect(row.secretEnc).not.toContain(rawKey) // 密文里不含明文
    expect(decryptSecret(row.secretEnc!)).toBe(rawKey) // 但解得回来 —— 这正是缓存的前提
    await t.db.update(serviceTokens).set({ revokedAt: new Date() }).where(eq(serviceTokens.id, row.id))
  })

  it('取两次命中缓存:不新增行，返回同一枚', async () => {
    const a = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view'] })
    const b = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view'] })
    expect(a).toMatchObject({ reused: false })
    expect(b).toMatchObject({ rawKey: a.rawKey, reused: true })
    expect((await activeAiRows()).filter((r) => r.employeeId === cacheCtx.employeeId)).toHaveLength(1)
  })

  it('过期后轮换:旧行吊销、只剩一枚活的，且拿到的是新 key', async () => {
    const first = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view'] })
    // 把这枚提前判死
    await t.db
      .update(serviceTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(and(eq(serviceTokens.employeeId, cacheCtx.employeeId), eq(serviceTokens.purpose, 'ai_session'), isNull(serviceTokens.revokedAt)))
    const second = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view'] })
    expect(second.rawKey).not.toBe(first.rawKey)
    expect(second).toMatchObject({ reused: false })
    expect((await activeAiRows()).filter((r) => r.employeeId === cacheCtx.employeeId)).toHaveLength(1) // 部分唯一索引:只剩一枚活的
    expect(await resolveServiceToken(t.db, first.rawKey!)).toBeNull() // 旧的确实死了
  })

  it('本人权限变了 → 轮换，不等 7 天', async () => {
    const before = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view'] })
    const after = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view', 'finance:view'] })
    expect(after.rawKey).not.toBe(before.rawKey)
    expect(await resolveServiceToken(t.db, after.rawKey!)).toMatchObject({ scopes: ['org:view', 'finance:view'] })
  })

  it('主密钥缺失 → fail-soft:不签发、不注入，也不留下半枚令牌', async () => {
    const keep = { cfg: process.env.CONFIG_ENC_KEY, auth: process.env.AUTH_SECRET }
    delete process.env.CONFIG_ENC_KEY
    delete process.env.AUTH_SECRET
    try {
      const before = (await activeAiRows()).length
      const res = await getOrMintAiSessionToken(t.db, cacheCtx, { scopes: ['org:view'] })
      expect(res).toEqual({ rawKey: null, reason: 'KEY_STORE_UNAVAILABLE' })
      expect((await activeAiRows()).length).toBe(before) // 没有新增行
    } finally {
      if (keep.cfg !== undefined) process.env.CONFIG_ENC_KEY = keep.cfg
      if (keep.auth !== undefined) process.env.AUTH_SECRET = keep.auth
    }
  })
})

describe('service-token over HTTP — scopes 封顶', () => {
  it('in-scope 200；越界 403；坏 key/缺 token 401', async () => {
    const { rawKey } = await mintServiceToken(t.db, ownerCtx, { name: 'readonly', scopes: ['org:view'], employeeId: svcEmpId })
    expect((await api('GET', '/api/probe-view', rawKey)).status).toBe(200) // 在 scope
    expect((await api('POST', '/api/probe-manage', rawKey)).status).toBe(403) // 越界
    expect((await api('GET', '/api/probe-view', 'svc_nope')).status).toBe(401) // 未知/坏格式
    expect((await api('GET', '/api/probe-view')).status).toBe(401) // 缺 token
  })

  it("'*' scope 放开全部", async () => {
    const { rawKey } = await mintServiceToken(t.db, ownerCtx, { name: 'star', scopes: ['*'], employeeId: svcEmpId })
    expect((await api('GET', '/api/probe-view', rawKey)).status).toBe(200)
    expect((await api('POST', '/api/probe-manage', rawKey)).status).toBe(200)
  })
})
