// 菜单排序:getMenuOrder 缺省空、saveMenuOrder upsert/幂等、结构与格式校验、去重、租户隔离。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { getMenuOrder, saveMenuOrder } from '../api'
import type { Ctx } from '../../../core/db/client'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db)).ownerCtx
})
afterAll(() => t.close())

describe('菜单排序', () => {
  it('缺省无行 → 返回空顺序', async () => {
    const other = (await seedTenant(t.db, '缺省租户')).ownerCtx
    expect(await getMenuOrder(t.db, other)).toEqual({ groups: [], items: {} })
  })

  it('保存后可读回;二级顺序按分组存', async () => {
    await saveMenuOrder(t.db, ctx, {
      groups: ['biz', 'si', 'crm'],
      items: { crm: ['opportunity', 'lead'], si: ['si-workspace', 'si-askai'] },
    })
    const got = await getMenuOrder(t.db, ctx)
    expect(got.groups).toEqual(['biz', 'si', 'crm'])
    expect(got.items.crm).toEqual(['opportunity', 'lead'])
    expect(got.items.si).toEqual(['si-workspace', 'si-askai'])
  })

  it('再次保存 = upsert 覆盖,不新增行', async () => {
    await saveMenuOrder(t.db, ctx, { groups: ['sys', 'hr'], items: {} })
    const got = await getMenuOrder(t.db, ctx)
    expect(got.groups).toEqual(['sys', 'hr'])
    expect(got.items).toEqual({})
  })

  it('去重(保序):重复 key 只留首次位置', async () => {
    const saved = await saveMenuOrder(t.db, ctx, {
      groups: ['si', 'biz', 'si'],
      items: { crm: ['lead', 'lead', 'opportunity'] },
    })
    expect(saved.groups).toEqual(['si', 'biz'])
    expect(saved.items.crm).toEqual(['lead', 'opportunity'])
  })

  it('非法结构被拒(INVALID_INPUT)', async () => {
    // groups 非数组
    await expect(saveMenuOrder(t.db, ctx, { groups: 'x' as unknown as string[], items: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // items 非对象
    await expect(saveMenuOrder(t.db, ctx, { groups: [], items: [] as unknown as Record<string, string[]> })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 含非法 key(空格)
    await expect(saveMenuOrder(t.db, ctx, { groups: ['a b'], items: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 某分组的二级顺序非数组
    await expect(saveMenuOrder(t.db, ctx, { groups: [], items: { crm: 'x' as unknown as string[] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('租户隔离:各租户顺序互不可见', async () => {
    const other = (await seedTenant(t.db, '隔离租户')).ownerCtx
    await saveMenuOrder(t.db, other, { groups: ['crm'], items: {} })
    expect((await getMenuOrder(t.db, other)).groups).toEqual(['crm'])
    // ctx 的顺序不受影响(仍是上一条用例保存的值)
    expect((await getMenuOrder(t.db, ctx)).groups).not.toEqual(['crm'])
  })
})
