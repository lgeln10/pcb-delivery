// modules/notify/logic.ts
// 通知渠道配置的读/写 + 对外发送入口。
// ★密钥红线:整份配置 JSON 加密后存 config_enc;DTO 永不回明文密码(只回"是否已设置")。
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../../core/db/client'
import { auditedUpdate, scope } from '../../core/db/soft-delete'
import { decryptSecret, encryptSecret, isKeyStoreAvailable } from './crypto'
import { sendEmail as smtpSend, sendTestEmail as smtpTest, type EmailMessage } from './email'
import { sendFeishu as feishuSend, sendTestFeishu as feishuTest, type FeishuMessage } from './feishu'
import { NotifyError } from './errors'
import { notifyChannelConfigs, type EmailConfig, type FeishuConfig, type NotifyChannel, type NotifyChannelConfig } from './model'

// 占位符:DTO 中已设置但不外泄的密码字段。保存时若收到该占位符表示"沿用原密码,不改"。
export const SECRET_PLACEHOLDER = '__SAVED__'

// ── 邮件配置 DTO(脱敏:pass 不回明文,只回 passSet 布尔)──────────────────────
export type EmailConfigDTO = {
  enabled: boolean
  configured: boolean // 是否已存过配置
  keyStoreReady: boolean // 加密主密钥是否就绪(否则无法保存)
  host: string
  port: number
  secure: boolean
  user: string
  passSet: boolean // 库里是否已存密码(永不回明文)
  fromName: string
  fromAddress: string
}

const EMAIL_DEFAULTS: EmailConfig = {
  host: '', port: 465, secure: true, user: '', pass: '', fromName: '', fromAddress: '',
}

async function getRow(db: Db, ctx: Ctx, channel: NotifyChannel): Promise<NotifyChannelConfig | undefined> {
  const rows = await db
    .select()
    .from(notifyChannelConfigs)
    .where(and(scope(notifyChannelConfigs, ctx.tenantId), eq(notifyChannelConfigs.channelType, channel)))
    .limit(1)
  return rows[0]
}

/** 解密某行的邮件配置;主密钥变更/密文损坏时抛 NOT_CONFIGURED(不泄露明文)。 */
function decodeEmail(row: NotifyChannelConfig): EmailConfig {
  if (!row.configEnc) throw new NotifyError('NOT_CONFIGURED', '邮件渠道尚未配置')
  try {
    return { ...EMAIL_DEFAULTS, ...(JSON.parse(decryptSecret(row.configEnc)) as Partial<EmailConfig>) }
  } catch {
    throw new NotifyError('NOT_CONFIGURED', '邮件配置无法解密(加密主密钥可能已变更),请重新保存配置')
  }
}

export async function getEmailConfig(db: Db, ctx: Ctx): Promise<EmailConfigDTO> {
  const row = await getRow(db, ctx, 'email')
  const keyStoreReady = isKeyStoreAvailable()
  if (!row || !row.configEnc) {
    return {
      enabled: row?.enabled ?? false, configured: false, keyStoreReady,
      ...EMAIL_DEFAULTS, pass: undefined as never, passSet: false,
    } as EmailConfigDTO
  }
  let cfg: EmailConfig
  try {
    cfg = decodeEmail(row)
  } catch {
    cfg = EMAIL_DEFAULTS
  }
  return {
    enabled: row.enabled, configured: true, keyStoreReady,
    host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user,
    passSet: !!cfg.pass, fromName: cfg.fromName, fromAddress: cfg.fromAddress,
  }
}

export type SaveEmailInput = {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  pass: string // 传 SECRET_PLACEHOLDER 表示沿用原密码
  fromName: string
  fromAddress: string
}

/** 保存邮件配置:加密整份 JSON 后 upsert。明文密码只进不出。 */
export async function saveEmailConfig(db: Db, ctx: Ctx, input: SaveEmailInput): Promise<EmailConfigDTO> {
  if (!isKeyStoreAvailable()) {
    throw new NotifyError('KEY_STORE_UNAVAILABLE', '未配置加密主密钥(CONFIG_ENC_KEY/AUTH_SECRET),无法保存邮件配置')
  }
  const existing = await getRow(db, ctx, 'email')

  // 密码:占位符 → 沿用原密码;否则用新值。
  let pass = input.pass
  if (pass === SECRET_PLACEHOLDER) {
    pass = existing?.configEnc ? decodeEmail(existing).pass : ''
  }

  const cfg: EmailConfig = {
    host: input.host.trim(), port: input.port, secure: input.secure,
    user: input.user.trim(), pass,
    fromName: input.fromName.trim(), fromAddress: input.fromAddress.trim(),
  }
  const configEnc = encryptSecret(JSON.stringify(cfg))

  if (existing) {
    await auditedUpdate(db, notifyChannelConfigs, ctx.tenantId, existing.id, ctx.employeeId, {
      enabled: input.enabled, configEnc,
    })
  } else {
    await db.insert(notifyChannelConfigs).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      channelType: 'email',
      enabled: input.enabled,
      configEnc,
    })
  }
  return getEmailConfig(db, ctx)
}

/** 发送测试邮件:读取并解密配置,发到账号自身。 */
export async function sendTestEmail(db: Db, ctx: Ctx): Promise<void> {
  const row = await getRow(db, ctx, 'email')
  if (!row) throw new NotifyError('NOT_CONFIGURED', '邮件渠道尚未配置')
  await smtpTest(decodeEmail(row))
}

/**
 * 对外发送入口(供后续业务模块调用):按本租户邮件配置发信。
 * 未配置或未启用时静默跳过(返回 false),不阻断业务主流程;真正发送失败才抛 NotifyError。
 */
export async function notifyByEmail(db: Db, ctx: Ctx, msg: EmailMessage): Promise<boolean> {
  const row = await getRow(db, ctx, 'email')
  if (!row || !row.enabled || !row.configEnc) return false
  await smtpSend(decodeEmail(row), msg)
  return true
}

// ════════════════════════════════════════════════════════════════════════════
// 飞书(群自定义机器人 webhook)渠道 —— 与邮件同结构(单租户单行,整份配置加密)。
// ════════════════════════════════════════════════════════════════════════════

const FEISHU_DEFAULTS: FeishuConfig = { webhookUrl: '', secret: '' }

// 脱敏 DTO:webhook 地址本身即凭证 → 不回完整地址,只回「是否已设置」+ 末尾片段用于辨识。
export type FeishuConfigDTO = {
  enabled: boolean
  configured: boolean
  keyStoreReady: boolean
  webhookSet: boolean
  webhookHint: string // webhook hook id 末 6 位(仅用于辨识,非完整凭证)
  secretSet: boolean // 是否开启了加签
}

function decodeFeishu(row: NotifyChannelConfig): FeishuConfig {
  if (!row.configEnc) throw new NotifyError('NOT_CONFIGURED', '飞书渠道尚未配置')
  try {
    return { ...FEISHU_DEFAULTS, ...(JSON.parse(decryptSecret(row.configEnc)) as Partial<FeishuConfig>) }
  } catch {
    throw new NotifyError('NOT_CONFIGURED', '飞书配置无法解密(加密主密钥可能已变更),请重新保存配置')
  }
}

function webhookHint(url: string): string {
  const trimmed = url.trim()
  return trimmed.length > 6 ? `…${trimmed.slice(-6)}` : ''
}

export async function getFeishuConfig(db: Db, ctx: Ctx): Promise<FeishuConfigDTO> {
  const row = await getRow(db, ctx, 'feishu')
  const keyStoreReady = isKeyStoreAvailable()
  if (!row || !row.configEnc) {
    return {
      enabled: row?.enabled ?? false, configured: false, keyStoreReady,
      webhookSet: false, webhookHint: '', secretSet: false,
    }
  }
  let cfg: FeishuConfig
  try {
    cfg = decodeFeishu(row)
  } catch {
    cfg = FEISHU_DEFAULTS
  }
  return {
    enabled: row.enabled, configured: true, keyStoreReady,
    webhookSet: !!cfg.webhookUrl, webhookHint: webhookHint(cfg.webhookUrl), secretSet: !!cfg.secret,
  }
}

export type SaveFeishuInput = {
  enabled: boolean
  webhookUrl: string // 传 SECRET_PLACEHOLDER 表示沿用原地址
  secret: string // 传 SECRET_PLACEHOLDER 表示沿用原密钥;空串表示关闭加签
}

/** 保存飞书配置:加密整份 JSON 后 upsert。webhook/密钥只进不出。 */
export async function saveFeishuConfig(db: Db, ctx: Ctx, input: SaveFeishuInput): Promise<FeishuConfigDTO> {
  if (!isKeyStoreAvailable()) {
    throw new NotifyError('KEY_STORE_UNAVAILABLE', '未配置加密主密钥(CONFIG_ENC_KEY/AUTH_SECRET),无法保存飞书配置')
  }
  const existing = await getRow(db, ctx, 'feishu')

  let webhookUrl = input.webhookUrl
  if (webhookUrl === SECRET_PLACEHOLDER) {
    webhookUrl = existing?.configEnc ? decodeFeishu(existing).webhookUrl : ''
  }
  let secret = input.secret
  if (secret === SECRET_PLACEHOLDER) {
    secret = existing?.configEnc ? decodeFeishu(existing).secret : ''
  }

  webhookUrl = webhookUrl.trim()
  if (input.enabled && !webhookUrl) {
    throw new NotifyError('INVALID_INPUT', '启用飞书渠道前必须填写群机器人 webhook 地址')
  }
  if (webhookUrl && !/^https:\/\/(open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\//.test(webhookUrl)) {
    throw new NotifyError('INVALID_INPUT', 'webhook 地址格式不正确,应形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx')
  }

  const cfg: FeishuConfig = { webhookUrl, secret: secret.trim() }
  const configEnc = encryptSecret(JSON.stringify(cfg))

  if (existing) {
    await auditedUpdate(db, notifyChannelConfigs, ctx.tenantId, existing.id, ctx.employeeId, {
      enabled: input.enabled, configEnc,
    })
  } else {
    await db.insert(notifyChannelConfigs).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      channelType: 'feishu',
      enabled: input.enabled,
      configEnc,
    })
  }
  return getFeishuConfig(db, ctx)
}

/** 发送测试飞书群消息。 */
export async function sendTestFeishu(db: Db, ctx: Ctx): Promise<void> {
  const row = await getRow(db, ctx, 'feishu')
  if (!row) throw new NotifyError('NOT_CONFIGURED', '飞书渠道尚未配置')
  await feishuTest(decodeFeishu(row))
}

/**
 * 对外发送入口(供业务模块调用):按本租户飞书配置推送群消息。
 * 未配置或未启用时静默跳过(返回 false),不阻断业务主流程;真正发送失败才抛 NotifyError。
 */
export async function notifyByFeishu(db: Db, ctx: Ctx, msg: FeishuMessage): Promise<boolean> {
  const row = await getRow(db, ctx, 'feishu')
  if (!row || !row.enabled || !row.configEnc) return false
  await feishuSend(decodeFeishu(row), msg)
  return true
}
