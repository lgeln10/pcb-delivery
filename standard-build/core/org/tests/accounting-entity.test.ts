// 财务独立核算(accounting entity)标记 + 嵌套约束的不变量测试。
// 规则:① 根部门恒为独立核算 ② 非根独立核算节点的子树内不得再有独立核算节点
//       ③ 独立核算节点的真祖先(除根外)不得为独立核算节点 ④ 根不可关闭
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createDepartment, setDepartmentAccountingEntity } from '../logic/department-tree'
import { listAccountingEntities, resolveAccountingEntity, getRootEntityId } from '../api'
import { OrgError } from '../logic/errors'
import type { Ctx } from '../../db/client'
import { Hono } from 'hono'
import { requireAuth, type AppEnv } from '../../http/middleware'
import { mapError } from '../../http/errors'
import { signToken } from '../../auth/token'

/** 本租户里从来不存在的账套 id。 */
const BOGUS_ENTITY = '00000000-0000-0000-0000-000000000000'

let t: OrgTestDb
let ctx: Ctx
let rootId: string

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ctx = seeded.ownerCtx
  rootId = seeded.rootDept.id
})

afterAll(async () => {
  await t.close()
})

describe('accounting entity 标记与嵌套约束', () => {
  it('根部门默认即独立核算账套', async () => {
    expect((await getRootEntityId(t.db, ctx.tenantId))).toBe(rootId)
    const entities = await listAccountingEntities(t.db, ctx.tenantId)
    expect(entities.map((e) => e.id)).toContain(rootId)
  })

  it('非根部门可勾选独立核算 → 进入可切换账套', async () => {
    const sub = await createDepartment(t.db, ctx, { name: '子公司A', parentId: rootId, isAccountingEntity: true })
    expect(sub.isAccountingEntity).toBe(true)
    const ids = (await listAccountingEntities(t.db, ctx.tenantId)).map((e) => e.id)
    expect(ids).toContain(sub.id)
  })

  it('独立核算节点的子孙不可再独立核算(创建时拒绝)', async () => {
    const a = await createDepartment(t.db, ctx, { name: '独立A', parentId: rootId, isAccountingEntity: true })
    const mid = await createDepartment(t.db, ctx, { name: '中间层', parentId: a.id })
    await expect(
      createDepartment(t.db, ctx, { name: '孙独立', parentId: mid.id, isAccountingEntity: true }),
    ).rejects.toMatchObject({ code: 'NESTED_ACCOUNTING_ENTITY' })
  })

  it('开启时:祖先(非根)已是实体 → 拒绝', async () => {
    const a = await createDepartment(t.db, ctx, { name: '独立B', parentId: rootId, isAccountingEntity: true })
    const child = await createDepartment(t.db, ctx, { name: 'B子', parentId: a.id })
    await expect(setDepartmentAccountingEntity(t.db, ctx, child.id, true)).rejects.toMatchObject({
      code: 'NESTED_ACCOUNTING_ENTITY',
    })
  })

  it('开启时:子孙已是实体 → 拒绝', async () => {
    const parent = await createDepartment(t.db, ctx, { name: '待开启父', parentId: rootId })
    await createDepartment(t.db, ctx, { name: '已独立子', parentId: parent.id, isAccountingEntity: true })
    await expect(setDepartmentAccountingEntity(t.db, ctx, parent.id, true)).rejects.toMatchObject({
      code: 'NESTED_ACCOUNTING_ENTITY',
    })
  })

  it('根下两条并列子树各自独立核算 → 允许', async () => {
    const x = await createDepartment(t.db, ctx, { name: '并列X', parentId: rootId, isAccountingEntity: true })
    const y = await createDepartment(t.db, ctx, { name: '并列Y', parentId: rootId, isAccountingEntity: true })
    expect(x.isAccountingEntity && y.isAccountingEntity).toBe(true)
  })

  it('根部门不可关闭独立核算', async () => {
    await expect(setDepartmentAccountingEntity(t.db, ctx, rootId, false)).rejects.toBeInstanceOf(OrgError)
    await expect(setDepartmentAccountingEntity(t.db, ctx, rootId, false)).rejects.toMatchObject({
      code: 'ROOT_ENTITY_LOCKED',
    })
  })

  it('非根独立核算节点可在编辑时关闭独立核算', async () => {
    const dept = await createDepartment(t.db, ctx, { name: '可关闭账套', parentId: rootId, isAccountingEntity: true })
    expect((await listAccountingEntities(t.db, ctx.tenantId)).map((e) => e.id)).toContain(dept.id)
    await setDepartmentAccountingEntity(t.db, ctx, dept.id, false)
    expect((await listAccountingEntities(t.db, ctx.tenantId)).map((e) => e.id)).not.toContain(dept.id)
  })

  it('关闭独立核算后:其子节点可重新设为独立核算', async () => {
    const parent = await createDepartment(t.db, ctx, { name: '父账套', parentId: rootId, isAccountingEntity: true })
    const child = await createDepartment(t.db, ctx, { name: '父账套子', parentId: parent.id })
    // 父仍是实体时,子不可独立核算
    await expect(setDepartmentAccountingEntity(t.db, ctx, child.id, true)).rejects.toMatchObject({
      code: 'NESTED_ACCOUNTING_ENTITY',
    })
    // 关闭父的独立核算后,子即可设为独立核算
    await setDepartmentAccountingEntity(t.db, ctx, parent.id, false)
    await setDepartmentAccountingEntity(t.db, ctx, child.id, true)
    expect((await listAccountingEntities(t.db, ctx.tenantId)).map((e) => e.id)).toContain(child.id)
  })

  it('resolveAccountingEntity:没给 → 根账套;明确指名一个非法账套 → 抛错', async () => {
    expect(await resolveAccountingEntity(t.db, ctx.tenantId, null)).toBe(rootId)
    // 默认口径 = 'throw':用户明确要 A 账套,默默返回根账套等于「你要 A,我给你根的数字」。
    await expect(resolveAccountingEntity(t.db, ctx.tenantId, BOGUS_ENTITY)).rejects.toBeInstanceOf(OrgError)
  })

  it('★同一个非法 id,onInvalid=fallbackToRoot 时回退而不抛(供中间件用)', async () => {
    expect(await resolveAccountingEntity(t.db, ctx.tenantId, BOGUS_ENTITY, { onInvalid: 'fallbackToRoot' })).toBe(rootId)
  })
})

/**
 * ★这一组守的是一个会把人锁死的形状,不是一句返回值。
 *
 * 当前账套 id 存在浏览器 localStorage(src/composables/useAccountingEntity.ts),
 * API 客户端**每个请求**都带上 X-Accounting-Entity。而「关闭某部门的独立核算」是编辑部门
 * 就能做的正常操作(上面就有这条用例)。如果 requireAuth 那一层对陈旧的头抛错,那么
 * 所有把它选为当前账套的人,会在**每一个**请求上拿到 400 —— 包括那条「列出可选账套」的请求,
 * 于是界面全空、连切回去都做不到,只能手动清 localStorage。
 *
 * 所以这里经**真中间件**验:头指向一个已经不是账套的部门时,请求照常通过、entityId 落到根账套。
 * (只测 resolveAccountingEntity 本身不够 —— 会漏掉「中间件忘了传那个 option」这一种改法。)
 */
describe('requireAuth:陈旧的账套头不能把人锁死', () => {
  const SECRET = 'test-secret-accounting-entity'

  async function whoami(entityHeader: string | null) {
    const app = new Hono<AppEnv>()
    app.onError((err, c) => {
      const mapped = mapError(err)
      return c.json(mapped.body, mapped.status as 400)
    })
    app.use('/whoami', requireAuth(t.db, SECRET))
    app.get('/whoami', (c) => c.json({ entityId: c.get('ctx').entityId ?? null }))

    const token = signToken({ employeeId: ctx.employeeId, tenantId: ctx.tenantId }, SECRET)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (entityHeader) headers['X-Accounting-Entity'] = entityHeader
    const res = await app.request('/whoami', { headers })
    return { status: res.status, body: (await res.json()) as { entityId?: string | null } }
  }

  it('不带头 → 根账套', async () => {
    const r = await whoami(null)
    expect(r.status).toBe(200)
    expect(r.body.entityId).toBe(rootId)
  })

  it('头指向一个从来不存在的 id → 仍是 200,落到根账套', async () => {
    const r = await whoami(BOGUS_ENTITY)
    expect(r.status).toBe(200)
    expect(r.body.entityId).toBe(rootId)
  })

  it('★头指向的部门刚被管理员取消独立核算 → 仍是 200,落到根账套(而不是整站 400)', async () => {
    const dept = await createDepartment(t.db, ctx, { name: '待撤销账套', parentId: rootId, isAccountingEntity: true })
    expect((await whoami(dept.id)).body.entityId).toBe(dept.id) // 撤销前:正常生效

    await setDepartmentAccountingEntity(t.db, ctx, dept.id, false)

    const after = await whoami(dept.id)
    expect(after.status).toBe(200)
    expect(after.body.entityId).toBe(rootId)
  })
})
