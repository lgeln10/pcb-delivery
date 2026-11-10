// core/llm/usage-model.ts
// LLM 调用流水表。★不 spread commonFields:这是**只追加的观测流水**,
// 没有软删/更新人这些概念,硬塞进来只会让人以为它可以被编辑。
import { boolean, integer, pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core'

export const llmUsageLogs = pgTable(
  'llm_usage_logs',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    scene: text('scene').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    ok: boolean('ok').notNull().default(true),
    errorCode: text('error_code').notNull().default(''),
  },
  (t) => [index('llm_usage_logs_tenant_created_idx').on(t.tenantId, t.createdAt.desc())],
)
