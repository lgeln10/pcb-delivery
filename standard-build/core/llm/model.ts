// core/llm/model.ts
// 平台级 LLM 配置(每租户一行):生效的 provider/model + 各供应商加密 API Key。
// ★密钥红线:明文 key 不进库。api_key_enc 存 AES-256-GCM 密文,加密主密钥走 env。
// (从原 feedback_configs / feedback_provider_keys 迁出;devtool 密钥仍留在 feedback_configs。)
import { sql } from 'drizzle-orm'
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { commonFields } from '../db/common-fields'

export const llmConfigs = pgTable(
  'llm_configs',
  {
    ...commonFields,
    provider: text('provider').notNull().default('bailian'),
    model: text('model').notNull().default(''), // 空串 → 回落 provider 默认模型
    // 主模型的「备用模型」:主选返回可重试异常(429/5xx/超时)时自动切到它再试一次。
    // 空 = 无备用。各场景未单独配备用时也继承这两列。
    fallbackProvider: text('fallback_provider'), // null = 无备用 provider
    fallbackModel: text('fallback_model'), // null = 无备用 model(无备用模型)
    // 深度思考总开关(仅方舟吃这个字段,见 core/llm/thinking.ts)。**默认关**:交互式场景开着会慢
    // 10–50 倍(实测 234s vs 4.3s)且不提升正确性。各场景未单独配时继承这一列。
    thinkingEnabled: boolean('thinking_enabled').notNull().default(false),
  },
  (t) => [uniqueIndex('llm_configs_tenant_idx').on(t.tenantId).where(sql`is_deleted = false`)],
)
export type LlmConfig = typeof llmConfigs.$inferSelect

// 每场景一行的模型覆盖:5 个覆盖列全部可空 = 字段级继承主模型(llm_configs)。
// scene 取 core/llm/scenes.ts 的 LlmSceneKey(不含 default —— default 即主模型,不落此表)。
export const llmSceneConfigs = pgTable(
  'llm_scene_configs',
  {
    ...commonFields,
    scene: text('scene').notNull(),
    provider: text('provider'), // null = 继承主模型 provider
    model: text('model'), // null = 继承主模型 model(chat)/能力默认模型(vision/embedding)
    fallbackProvider: text('fallback_provider'), // null = 继承主模型备用 provider
    fallbackModel: text('fallback_model'), // null = 继承主模型备用 model
    thinkingEnabled: boolean('thinking_enabled'), // null = 继承主模型开关(不是「关」——三态)
  },
  (t) => [
    uniqueIndex('llm_scene_configs_tenant_scene_uq')
      .on(t.tenantId, t.scene)
      .where(sql`is_deleted = false`),
  ],
)
export type LlmSceneConfig = typeof llmSceneConfigs.$inferSelect

export const llmProviderKeys = pgTable(
  'llm_provider_keys',
  {
    ...commonFields,
    provider: text('provider').notNull(),
    apiKeyEnc: text('api_key_enc').notNull(), // AES-256-GCM 密文(非明文)
  },
  (t) => [
    uniqueIndex('llm_provider_keys_tenant_provider_uq')
      .on(t.tenantId, t.provider)
      .where(sql`is_deleted = false`),
  ],
)
export type LlmProviderKey = typeof llmProviderKeys.$inferSelect
