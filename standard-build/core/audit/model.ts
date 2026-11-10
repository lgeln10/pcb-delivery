// core/audit/model.ts
// 系统审计日志:谁、何时、对什么、做了什么、结果。★append-only —— 不软删、不更新。
// 故不 spread commonFields(它含 updated_*/is_deleted);只取审计需要的列。
import { sql } from 'drizzle-orm'
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    actorEmployeeId: uuid('actor_employee_id'), // 操作人;登录失败/系统任务可空
    actorName: text('actor_name'), // ★姓名快照:员工改名/删除后仍可追溯
    action: text('action').notNull(), // 'METHOD /api/路由模式'(基线)或语义码(富化)
    targetType: text('target_type'), // 目标实体类型(富化时填)
    targetId: uuid('target_id'), // 目标 id(基线取路径 :id)
    summary: text('summary'), // 人类可读摘要(富化时填)
    detail: jsonb('detail'), // 脱敏入参 / 前后值
    source: text('source').notNull(), // http / system / login
    result: text('result').notNull(), // success / failed
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_tenant_time_idx').on(t.tenantId, t.createdAt),
    index('audit_logs_tenant_actor_idx').on(t.tenantId, t.actorEmployeeId, t.createdAt),
    index('audit_logs_tenant_target_idx').on(t.tenantId, t.targetType, t.targetId),
    index('audit_logs_tenant_action_idx').on(t.tenantId, t.action),
    check('audit_logs_source_check', sql`${t.source} in ('http', 'system', 'login')`),
    check('audit_logs_result_check', sql`${t.result} in ('success', 'failed')`),
  ],
)

export type AuditLog = typeof auditLogs.$inferSelect
