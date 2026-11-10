// modules/notify/model.ts
// 通知渠道配置:每租户每渠道一行。第一期只有 email(SMTP),结构预留多渠道(channel_type)。
// ★密钥红线:SMTP 密码等敏感配置不明文进库 —— 整份配置 JSON 经 AES-256-GCM 加密存 config_enc。
import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { commonFields } from '../../core/db/common-fields'

// 渠道类型:email(SMTP) + feishu(群自定义机器人 webhook)。再加渠道时同步放开下方 CHECK + 迁移。
export const NOTIFY_CHANNELS = ['email', 'feishu'] as const
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number]

export const notifyChannelConfigs = pgTable(
  'notify_channel_configs',
  {
    ...commonFields,
    channelType: text('channel_type').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    configEnc: text('config_enc'), // AES-256-GCM 密文(加密前是配置 JSON);未配置时为 null
  },
  (t) => [
    uniqueIndex('notify_channel_configs_tenant_channel_uq')
      .on(t.tenantId, t.channelType)
      .where(sql`is_deleted = false`),
    check('notify_channel_configs_channel_check', sql`${t.channelType} in ('email', 'feishu')`),
  ],
)
export type NotifyChannelConfig = typeof notifyChannelConfigs.$inferSelect

// ── 邮件(SMTP)配置明文结构(加密前 JSON / 解密后对象)─────────────────────────
export type EmailConfig = {
  host: string
  port: number
  secure: boolean // true=SSL(465);false=STARTTLS(587/25)
  user: string
  pass: string
  fromName: string
  fromAddress: string
}

// ── 飞书(群自定义机器人 webhook)配置明文结构 ───────────────────────────────
// webhookUrl 本身即凭证(谁有谁能往群里发),secret 为可选的「加签」密钥。两者均加密入库。
export type FeishuConfig = {
  webhookUrl: string // https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
  secret: string // 群机器人「加签」密钥;留空表示未开启加签
}
