// 功能开关:setToggle upsert/幂等、listDisabledKeys、防自锁保护码拒绝、key 格式校验、租户隔离。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { listDisabledKeys, setToggle, PROTECTED_KEYS } from '../api'
import type { Ctx } from '../../../core/db/client'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db)).ownerCtx
})
afterAll(() => t.close())

describe('功能开关', () => {
  it('关闭一个菜单 → 进入禁用集;再启用 → 移出', async () => {
    await setToggle(t.db, ctx, { key: 'menu:finance-budget', enabled: false })
    expect(await listDisabledKeys(t.db, ctx)).toContain('menu:finance-budget')
    await setToggle(t.db, ctx, { key: 'menu:finance-budget', enabled: true })
    expect(await listDisabledKeys(t.db, ctx)).not.toContain('menu:finance-budget')
  })

  it('关闭幂等:重复关同一 key 不报错、禁用集不重复', async () => {
    await setToggle(t.db, ctx, { key: 'group:finance-mgmt', enabled: false })
    await setToggle(t.db, ctx, { key: 'group:finance-mgmt', enabled: false })
    const disabled = await listDisabledKeys(t.db, ctx)
    expect(disabled.filter((k) => k === 'group:finance-mgmt')).toHaveLength(1)
  })

  it('三类 key 都能存(group/menu/perm)', async () => {
    await setToggle(t.db, ctx, { key: 'perm:finance:asset', enabled: false })
    const disabled = await listDisabledKeys(t.db, ctx)
    expect(disabled).toEqual(expect.arrayContaining(['group:finance-mgmt', 'perm:finance:asset']))
  })

  it('保护码不可关闭(PROTECTED_KEY),但可显式启用', async () => {
    for (const key of PROTECTED_KEYS) {
      await expect(setToggle(t.db, ctx, { key, enabled: false })).rejects.toMatchObject({ code: 'PROTECTED_KEY' })
    }
    // 显式启用保护码不报错(no-op 语义)
    await expect(setToggle(t.db, ctx, { key: 'menu:app-settings', enabled: true })).resolves.toBeUndefined()
  })

  it('非法 key 格式被拒(INVALID_INPUT)', async () => {
    for (const bad of ['finance', 'foo:bar', 'menu-finance', 'perm', '']) {
      await expect(setToggle(t.db, ctx, { key: bad, enabled: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  it('租户隔离:别的租户禁用集互不可见', async () => {
    const other = (await seedTenant(t.db, '另一租户')).ownerCtx
    await setToggle(t.db, other, { key: 'menu:contract', enabled: false })
    expect(await listDisabledKeys(t.db, other)).toContain('menu:contract')
    expect(await listDisabledKeys(t.db, ctx)).not.toContain('menu:contract')
  })
})
