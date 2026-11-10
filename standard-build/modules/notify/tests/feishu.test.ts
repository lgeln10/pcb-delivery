// modules/notify/tests/feishu.test.ts
// 飞书群机器人渠道:配置读写、webhook 不明文存储、占位符沿用、地址校验、未启用静默跳过。
// 不真连飞书 —— notifyByFeishu 只在"已配置且启用"时才发送,测试只验证到"是否触发发送"边界。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import type { Ctx } from '../../../core/db/client'
import { getFeishuConfig, saveFeishuConfig, notifyByFeishu, SECRET_PLACEHOLDER } from '../logic'
import { notifyChannelConfigs } from '../model'

let t: OrgTestDb
let ctxA: Ctx
let ctxB: Ctx

beforeAll(async () => {
  process.env.CONFIG_ENC_KEY = 'test-notify-master-key-1234567890'
  t = await createOrgTestDb()
  ctxA = (await seedTenant(t.db, 'A 公司')).ownerCtx
  ctxB = (await seedTenant(t.db, 'B 公司')).ownerCtx
})
afterAll(async () => t.close())

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef-1234-5678-9012'
const baseInput = { enabled: true, webhookUrl: WEBHOOK, secret: 'sign-secret-xyz' }

describe('通知渠道:飞书群机器人配置', () => {
  it('未配置时返回 configured=false,且 DTO 不含完整 webhook', async () => {
    const dto = await getFeishuConfig(t.db, ctxA)
    expect(dto.configured).toBe(false)
    expect(dto.webhookSet).toBe(false)
    expect((dto as Record<string, unknown>).webhookUrl).toBeUndefined()
  })

  it('保存后:DTO 回脱敏配置(webhookSet=true + 末位 hint),库内 config_enc 不含明文 webhook/密钥', async () => {
    const dto = await saveFeishuConfig(t.db, ctxA, baseInput)
    expect(dto.configured).toBe(true)
    expect(dto.webhookSet).toBe(true)
    expect(dto.secretSet).toBe(true)
    expect(dto.webhookHint).toBe('…8-9012')
    expect((dto as Record<string, unknown>).webhookUrl).toBeUndefined()

    // ★密钥红线:库里绝不出现明文 webhook / 加签密钥
    const rows = await t.db.select().from(notifyChannelConfigs)
      .where(eq(notifyChannelConfigs.tenantId, ctxA.tenantId))
    const fs = rows.find((r) => r.channelType === 'feishu')!
    expect(fs.configEnc).toBeTruthy()
    expect(fs.configEnc!).not.toContain('hook/abcdef')
    expect(fs.configEnc!).not.toContain('sign-secret-xyz')
  })

  it('占位符:传 SECRET_PLACEHOLDER 时沿用原 webhook/密钥,改启用态不丢凭证', async () => {
    await saveFeishuConfig(t.db, ctxA, baseInput)
    const dto = await saveFeishuConfig(t.db, ctxA, {
      enabled: false, webhookUrl: SECRET_PLACEHOLDER, secret: SECRET_PLACEHOLDER,
    })
    expect(dto.enabled).toBe(false)
    expect(dto.webhookSet).toBe(true)
    expect(dto.secretSet).toBe(true)
  })

  it('地址校验:非飞书 hook 域名直接拒绝;启用却空地址拒绝', async () => {
    await expect(saveFeishuConfig(t.db, ctxB, { enabled: true, webhookUrl: 'https://evil.com/hook/x', secret: '' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(saveFeishuConfig(t.db, ctxB, { enabled: true, webhookUrl: '', secret: '' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('租户隔离:A 的配置 B 读不到', async () => {
    await saveFeishuConfig(t.db, ctxA, baseInput)
    const bDto = await getFeishuConfig(t.db, ctxB)
    expect(bDto.configured).toBe(false)
  })

  it('notifyByFeishu:未配置/未启用时静默跳过(返回 false),不抛错', async () => {
    expect(await notifyByFeishu(t.db, ctxB, { title: 't', text: 'x' })).toBe(false)
    await saveFeishuConfig(t.db, ctxA, { ...baseInput, enabled: false })
    expect(await notifyByFeishu(t.db, ctxA, { title: 't', text: 'x' })).toBe(false)
  })
})
