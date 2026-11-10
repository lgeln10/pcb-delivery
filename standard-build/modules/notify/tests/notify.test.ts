// modules/notify/tests/notify.test.ts
// 通知渠道(邮件):配置读写、密文不明文存储、密码占位符沿用、租户隔离、未启用静默跳过。
// 不真连 SMTP —— notifyByEmail 只在"已配置且启用"时才会发送,测试只验证到"是否触发发送"边界。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import type { Ctx } from '../../../core/db/client'
import { getEmailConfig, saveEmailConfig, notifyByEmail, SECRET_PLACEHOLDER } from '../logic'
import { notifyChannelConfigs } from '../model'

let t: OrgTestDb
let ctxA: Ctx
let ctxB: Ctx

beforeAll(async () => {
  // 加密主密钥就绪,才能保存邮件配置(crypto 走 env)
  process.env.CONFIG_ENC_KEY = 'test-notify-master-key-1234567890'
  t = await createOrgTestDb()
  ctxA = (await seedTenant(t.db, 'A 公司')).ownerCtx
  ctxB = (await seedTenant(t.db, 'B 公司')).ownerCtx
})
afterAll(async () => t.close())

const baseInput = {
  enabled: true,
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  user: 'notify@example.com',
  pass: 'super-secret-pass',
  fromName: '测试平台',
  fromAddress: 'notify@example.com',
}

describe('通知渠道:邮件配置', () => {
  it('未配置时返回 configured=false,且 DTO 不含明文密码字段', async () => {
    const dto = await getEmailConfig(t.db, ctxA)
    expect(dto.configured).toBe(false)
    expect(dto.passSet).toBe(false)
    expect((dto as Record<string, unknown>).pass).toBeUndefined()
  })

  it('保存后:DTO 回脱敏配置(passSet=true,无明文),库内 config_enc 为密文不含明文', async () => {
    const dto = await saveEmailConfig(t.db, ctxA, baseInput)
    expect(dto.configured).toBe(true)
    expect(dto.passSet).toBe(true)
    expect(dto.host).toBe('smtp.example.com')
    expect((dto as Record<string, unknown>).pass).toBeUndefined()

    // ★密钥红线:库里绝不出现明文密码
    const rows = await t.db.select().from(notifyChannelConfigs).where(eq(notifyChannelConfigs.tenantId, ctxA.tenantId))
    expect(rows[0]!.configEnc).toBeTruthy()
    expect(rows[0]!.configEnc!).not.toContain('super-secret-pass')
    expect(rows[0]!.configEnc!).not.toContain('notify@example.com')
  })

  it('密码占位符:传 SECRET_PLACEHOLDER 时沿用原密码、改其它字段不丢密码', async () => {
    await saveEmailConfig(t.db, ctxA, baseInput)
    const dto = await saveEmailConfig(t.db, ctxA, { ...baseInput, pass: SECRET_PLACEHOLDER, host: 'smtp.new.com' })
    expect(dto.host).toBe('smtp.new.com')
    expect(dto.passSet).toBe(true) // 密码仍在(未被占位符清空)
  })

  it('每租户每渠道唯一:重复保存是 upsert,只有一行', async () => {
    await saveEmailConfig(t.db, ctxA, baseInput)
    await saveEmailConfig(t.db, ctxA, { ...baseInput, host: 'smtp.again.com' })
    const rows = await t.db.select().from(notifyChannelConfigs).where(eq(notifyChannelConfigs.tenantId, ctxA.tenantId))
    expect(rows.length).toBe(1)
  })

  it('租户隔离:A 的配置 B 读不到', async () => {
    await saveEmailConfig(t.db, ctxA, baseInput)
    const bDto = await getEmailConfig(t.db, ctxB)
    expect(bDto.configured).toBe(false)
  })

  it('notifyByEmail:未配置/未启用时静默跳过(返回 false),不抛错', async () => {
    // B 租户未配置 → false
    expect(await notifyByEmail(t.db, ctxB, { to: 'x@y.com', subject: 's', text: 't' })).toBe(false)
    // A 配置但停用 → false
    await saveEmailConfig(t.db, ctxA, { ...baseInput, enabled: false })
    expect(await notifyByEmail(t.db, ctxA, { to: 'x@y.com', subject: 's', text: 't' })).toBe(false)
  })
})
