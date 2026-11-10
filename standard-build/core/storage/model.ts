// core/storage/model.ts
// 平台级文件存储配置(每租户一行,镜像 core/llm):生效的对象存储 provider + 各 provider 的连接参数。
// ★密钥红线:access_key_secret 明文不进库,只存 access_key_secret_enc(AES-256-GCM 密文,主密钥走 env)。
// active_provider = 'local' 走本地磁盘(经 /uploads/*);'oss' 阿里云 OSS;'tos' 火山引擎 TOS。
import { sql } from 'drizzle-orm'
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { commonFields } from '../db/common-fields'

export const storageConfigs = pgTable(
  'storage_configs',
  {
    ...commonFields,
    activeProvider: text('active_provider').notNull().default('local'), // 'local' | 'oss' | 'tos'
  },
  (t) => [uniqueIndex('storage_configs_tenant_idx').on(t.tenantId).where(sql`is_deleted = false`)],
)
export type StorageConfig = typeof storageConfigs.$inferSelect

export const storageProviderConfigs = pgTable(
  'storage_provider_configs',
  {
    ...commonFields,
    provider: text('provider').notNull(), // 'oss' | 'tos'
    region: text('region').notNull().default(''),
    bucket: text('bucket').notNull().default(''),
    endpoint: text('endpoint').notNull().default(''), // 可选:内网/自定义;TOS 必填
    publicBase: text('public_base').notNull().default(''), // 可选:CDN/自定义访问域名
    accessKeyId: text('access_key_id').notNull().default(''),
    accessKeySecretEnc: text('access_key_secret_enc').notNull().default(''), // AES-256-GCM 密文
  },
  (t) => [
    uniqueIndex('storage_provider_configs_tenant_provider_uq')
      .on(t.tenantId, t.provider)
      .where(sql`is_deleted = false`),
  ],
)
export type StorageProviderConfig = typeof storageProviderConfigs.$inferSelect
