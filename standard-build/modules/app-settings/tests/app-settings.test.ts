// 系统设置:默认值 / upsert 持久化 / 名称超长校验 / logo 空串归一为 null / 系统时区。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { getSettings, getTenantTimezone, saveSettings } from '../logic'
import { appSettings } from '../model'
import { AppSettingsError } from '../errors'
import type { Ctx } from '../../../core/db/client'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db)).ownerCtx
})
afterAll(async () => t.close())

describe('系统设置', () => {
  it('无记录时返回默认值(空名称 / 无 logo / 东八区)', async () => {
    const s = await getSettings(t.db, ctx)
    expect(s.systemName).toBe('')
    expect(s.logoUrl).toBeNull()
    expect(s.timezone).toBe('Asia/Shanghai') // 默认东八区北京时间
  })

  it('系统时区:可改、可读回;无设置行/写坏值时 getTenantTimezone 回落东八区', async () => {
    expect(await getTenantTimezone(t.db, ctx.tenantId)).toBe('Asia/Shanghai') // 还没有设置行
    await saveSettings(t.db, ctx, { systemName: '', logoUrl: null, timezone: 'America/New_York' })
    expect((await getSettings(t.db, ctx)).timezone).toBe('America/New_York')
    expect(await getTenantTimezone(t.db, ctx.tenantId)).toBe('America/New_York')
    // 直接写坏库(绕过校验)→ 取时回落默认,绝不让「几点」判定崩在一个不认识的时区上
    await t.db.update(appSettings).set({ timezone: 'GMT+8' }).where(eq(appSettings.tenantId, ctx.tenantId))
    expect(await getTenantTimezone(t.db, ctx.tenantId)).toBe('Asia/Shanghai')
    await saveSettings(t.db, ctx, { systemName: '', logoUrl: null, timezone: 'Asia/Shanghai' }) // 复原,免串扰后续用例
  })

  it('非法时区名 → INVALID_INPUT(写坏了所有定时提醒的「几点」都会错)', async () => {
    await expect(
      saveSettings(t.db, ctx, { systemName: '', logoUrl: null, timezone: 'GMT+8' }),
    ).rejects.toBeInstanceOf(AppSettingsError)
  })

  it('保存后可读回(insert),再次保存为更新(update,不新增行)', async () => {
    await saveSettings(t.db, ctx, { systemName: '示范企业OS', logoUrl: 'https://cdn.example.com/a.png', timezone: 'Asia/Shanghai' })
    let s = await getSettings(t.db, ctx)
    expect(s.systemName).toBe('示范企业OS')
    expect(s.logoUrl).toBe('https://cdn.example.com/a.png')

    await saveSettings(t.db, ctx, { systemName: '示范企业OS·改', logoUrl: null, timezone: 'Asia/Shanghai' })
    s = await getSettings(t.db, ctx)
    expect(s.systemName).toBe('示范企业OS·改')
    expect(s.logoUrl).toBeNull()
  })

  it('名称两端空白被裁剪;logo 空串归一为 null', async () => {
    const r = await saveSettings(t.db, ctx, { systemName: '  名称  ', logoUrl: '   ', timezone: 'Asia/Shanghai' })
    expect(r.systemName).toBe('名称')
    expect(r.logoUrl).toBeNull()
  })

  it('名称超过 60 字符 → INVALID_INPUT', async () => {
    await expect(
      saveSettings(t.db, ctx, { systemName: 'x'.repeat(61), logoUrl: null, timezone: 'Asia/Shanghai' }),
    ).rejects.toBeInstanceOf(AppSettingsError)
  })
})
