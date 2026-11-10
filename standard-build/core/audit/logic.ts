// core/audit/logic.ts
// 写入(append-only)、脱敏、查询。审计写入 best-effort:失败只记日志,绝不抛给业务。
import { and, count, desc, eq, gte, ilike, lt, lte, type SQL } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { employees } from '../org/model'
import { auditLogs, type AuditLog } from './model'

// 含这些子串的键一律不入库(密钥红线)
const SENSITIVE_HINTS = ['password', 'token', 'secret', 'authorization']

/** 递归剔除敏感字段;非对象原样返回 */
export function sanitizeDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDetail)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_HINTS.some((h) => k.toLowerCase().includes(h))) continue
      out[k] = sanitizeDetail(v)
    }
    return out
  }
  return value
}

export type AuditEntry = {
  tenantId: string
  actorEmployeeId?: string | null
  actorName?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  summary?: string | null
  detail?: unknown
  source: 'http' | 'system' | 'login'
  result: 'success' | 'failed'
  ip?: string | null
}

/** 写一条审计(detail 自动脱敏)。直接用于登录/系统任务。 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    tenantId: entry.tenantId,
    actorEmployeeId: entry.actorEmployeeId ?? null,
    actorName: entry.actorName ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    summary: entry.summary ?? null,
    detail: entry.detail === undefined ? null : sanitizeDetail(entry.detail),
    source: entry.source,
    result: entry.result,
    ip: entry.ip ?? null,
  })
}

/** best-effort:审计失败绝不阻断业务(中间件用)。 */
export async function recordAuditSafe(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(db, entry)
  } catch (err) {
    console.error('[audit] failed to record:', (err as Error).message)
  }
}

/** 操作人姓名快照:写入时解析一次(员工改名/删除后审计仍可读) */
export async function resolveActorName(db: Db, tenantId: string, employeeId: string): Promise<string | null> {
  const rows = await db
    .select({ name: employees.name })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1)
  return rows[0]?.name ?? null
}

export type AuditFilter = {
  actorId?: string
  action?: string
  targetType?: string
  targetId?: string
  result?: 'success' | 'failed'
  from?: string // ISO/日期
  to?: string
  cursor?: string // 上一页最后一条 createdAt 的 ISO
  limit?: number
}

/** 审计查询(租户隔离 + 按时间倒序游标分页) */
export async function listAudit(
  db: Db,
  ctx: Ctx,
  filter: AuditFilter = {},
): Promise<{ items: AuditLog[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(filter.limit ?? 20, 50)
  const conds: SQL[] = [eq(auditLogs.tenantId, ctx.tenantId)]
  if (filter.actorId) conds.push(eq(auditLogs.actorEmployeeId, filter.actorId))
  if (filter.action) conds.push(ilike(auditLogs.action, `%${filter.action}%`))
  if (filter.targetType) conds.push(eq(auditLogs.targetType, filter.targetType))
  if (filter.targetId) conds.push(eq(auditLogs.targetId, filter.targetId))
  if (filter.result) conds.push(eq(auditLogs.result, filter.result))
  if (filter.from) conds.push(gte(auditLogs.createdAt, new Date(filter.from)))
  if (filter.to) conds.push(lte(auditLogs.createdAt, new Date(filter.to)))
  const total = Number((await db.select({ v: count() }).from(auditLogs).where(and(...conds)))[0]!.v)
  if (filter.cursor) conds.push(lt(auditLogs.createdAt, new Date(filter.cursor)))

  const rows = await db
    .select()
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  return { items, nextCursor: hasMore ? items[items.length - 1]!.createdAt.toISOString() : null, total }
}
