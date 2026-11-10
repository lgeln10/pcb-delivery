// core/http/tests/qr-login-http.test.ts
// 扫码登录**走真 HTTP 树**的一整趟。领域逻辑的用例在 core/auth/tests/qr-login.test.ts;
// 这一份只钉住那一层容易静默错、而领域测试永远看不见的东西:
//
//   ① 路由挂没挂上、挂在鉴权闸的哪一侧(挂错一侧不是 404 就是整个公开);
//   ② 手机那两个口**不带令牌也能打通**(带了闸就等于手机永远进不来);
//   ③ 电脑那几个口**不带令牌一律 401**(漏了就是任何人都能替别人批准扫码登录);
//   ④ 换出来的令牌拿去打别的受保护接口是真的好使 —— 这才叫「登录成功」。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { employees } from '../../org/model'
import { hashPassword } from '../../org/logic/employee'
import { and, eq } from 'drizzle-orm'
import { _resetQrRateLimit } from '../../auth/qr-login'

const SECRET = 'test-secret-qr-http'
const PHONE = '13900001111'
const PASSWORD = 'pc-password-123'

let t: OrgTestDb
let app: ReturnType<typeof createApp>
let pcToken: string

const J = { 'content-type': 'application/json' }
const post = (path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    headers: token ? { ...J, authorization: `Bearer ${token}` } : J,
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  t = await createOrgTestDb()
  const { tenant, owner } = await seedTenant(t.db)
  await t.db
    .update(employees)
    .set({ phone: PHONE, passwordHash: await hashPassword(PASSWORD), status: 'active' })
    .where(and(eq(employees.tenantId, tenant.id), eq(employees.id, owner.id)))
  app = createApp(t.db, { secret: SECRET })
  const res = await post('/api/auth/login', { phone: PHONE, password: PASSWORD })
  pcToken = ((await res.json()) as { token: string }).token
})
afterAll(() => t.close())

beforeAll(() => _resetQrRateLimit())

describe('★鉴权闸落在哪一侧', () => {
  it('电脑那几个口:不带令牌一律 401(否则任何人都能替别人批准扫码登录)', async () => {
    for (const [path, body] of [
      ['/api/session/qr/tickets', {}],
      ['/api/session/qr/status', { ticket: 'x'.repeat(43) }],
      ['/api/session/qr/decide', { ticket: 'x'.repeat(43), approve: true }],
    ] as const) {
      expect((await post(path, body)).status, `${path} 没过 requireAuth`).toBe(401)
    }
    expect((await app.request('/api/session/devices')).status).toBe(401)
  })

  it('手机那两个口:不带令牌也打得通(带闸就等于手机永远进不来)', async () => {
    // 票是假的,所以业务上会拒 —— 但**不能是 401**,那说明它被挡在鉴权闸外面了
    for (const path of ['/api/qr-login/scan', '/api/qr-login/redeem']) {
      const res = await post(path, { ticket: 'y'.repeat(43) })
      expect(res.status, `${path} 被 requireAuth 挡住了,手机根本进不来`).not.toBe(401)
      expect(res.status).toBe(404) // QR_TICKET_INVALID
    }
  })
})

describe('★完整一趟:电脑出码 → 手机扫 → 电脑确认 → 手机换到令牌', () => {
  it('走通,并且换来的令牌真的能用', async () => {
    // ① 电脑出码
    const made = await post('/api/session/qr/tickets', {}, pcToken)
    expect(made.status).toBe(200)
    const { ticket, rotateAfterMs } = (await made.json()) as { ticket: string; rotateAfterMs: number }
    expect(ticket.length).toBeGreaterThan(30)
    expect(rotateAfterMs).toBeGreaterThan(0)

    // ② 手机扫(**不带任何令牌**)
    const scanned = await post('/api/qr-login/scan', {
      ticket,
      device: { label: 'Pixel 9 · Android 16', platform: 'android', appVersion: '0.1.0' },
    })
    expect(scanned.status).toBe(200)
    expect(((await scanned.json()) as { loginAs: string }).loginAs).toBe('老板')

    // ③ 电脑看到是谁在扫
    const st = await post('/api/session/qr/status', { ticket }, pcToken)
    const stBody = (await st.json()) as { status: string; device: { label: string; platform: string } | null }
    expect(stBody.status).toBe('scanned')
    expect(stBody.device?.label).toBe('Pixel 9 · Android 16')
    expect(stBody.device?.platform).toBe('android')

    // ★确认之前手机拿不到令牌
    const early = await post('/api/qr-login/redeem', { ticket })
    expect(((await early.json()) as { status: string }).status).toBe('scanned')

    // ④ 电脑确认
    const decided = await post('/api/session/qr/decide', { ticket, approve: true }, pcToken)
    expect(((await decided.json()) as { ok: boolean }).ok).toBe(true)

    // ⑤ 手机兑换
    const got = await post('/api/qr-login/redeem', { ticket })
    const body = (await got.json()) as { status: string; token?: string; employee?: { name: string } }
    expect(body.status).toBe('approved')
    expect(body.token).toBeTruthy()
    expect(body.employee?.name).toBe('老板')

    // ⑥ ★真的算登录成功:拿它去打一个受保护接口
    const me = await app.request('/api/me', { headers: { authorization: `Bearer ${body.token}` } })
    expect(me.status, '换来的令牌打不通受保护接口 —— 那不叫登录成功').toBe(200)

    // ⑦ 出现在设备台账里,并且能单独下线
    const list = await app.request('/api/session/devices', { headers: { authorization: `Bearer ${pcToken}` } })
    const devices = ((await list.json()) as { devices: { jti: string; label: string }[] }).devices
    expect(devices.map((d) => d.label)).toContain('Pixel 9 · Android 16')

    const revoked = await post(`/api/session/devices/${devices[0]!.jti}/revoke`, {}, pcToken)
    expect(((await revoked.json()) as { ok: boolean }).ok).toBe(true)

    const after = await app.request('/api/me', { headers: { authorization: `Bearer ${body.token}` } })
    expect(after.status, '下线之后手机那枚令牌还能用').toBe(401)
    // ★电脑自己这一份不受影响 —— 这正是「设备台账」存在的全部理由
    const pcStill = await app.request('/api/me', { headers: { authorization: `Bearer ${pcToken}` } })
    expect(pcStill.status, '下线一台手机把电脑也踢下线了').toBe(200)
  })
})

describe('★别人的票', () => {
  it('另一个租户的登录用户既看不到也批不动(回 ok:false / expired,不泄露存在性)', async () => {
    const other = await seedTenant(t.db, '另一家公司')
    await t.db
      .update(employees)
      .set({ phone: '13900002222', passwordHash: await hashPassword(PASSWORD), status: 'active' })
      .where(and(eq(employees.tenantId, other.tenant.id), eq(employees.id, other.owner.id)))
    const otherToken = ((await (await post('/api/auth/login', { phone: '13900002222', password: PASSWORD })).json()) as {
      token: string
    }).token

    const { ticket } = (await (await post('/api/session/qr/tickets', {}, pcToken)).json()) as { ticket: string }
    await post('/api/qr-login/scan', { ticket, device: { label: '手机' } })

    const st = (await (await post('/api/session/qr/status', { ticket }, otherToken)).json()) as { status: string }
    expect(st.status).toBe('expired') // 看不到 = 当作不存在

    const dec = (await (await post('/api/session/qr/decide', { ticket, approve: true }, otherToken)).json()) as {
      ok: boolean
    }
    expect(dec.ok, '别的租户的人替我批准了扫码登录').toBe(false)
  })
})
