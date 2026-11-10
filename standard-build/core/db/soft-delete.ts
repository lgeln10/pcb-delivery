// core/db/soft-delete.ts
// 软删除 + 租户隔离 + 审计更新的标准助手。所有模块的查询/写操作走这三个函数,
// 保证两条全局红线:① 每查询强制带 tenant_id ② 禁物理 DELETE。
// created_by/created_at 不可变由 auditedUpdate 强制剥离实现。
import { and, eq, type SQL } from 'drizzle-orm'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { Db } from './client'

// 带公共字段的表的最小形状(结构性类型,任何 spread 了 commonFields 的表都满足)
export type CommonTable = PgTable & {
  id: AnyPgColumn
  tenantId: AnyPgColumn
  isDeleted: AnyPgColumn
  deletedAt: AnyPgColumn
  updatedBy: AnyPgColumn
  updatedAt: AnyPgColumn
}

/** 标准查询条件前缀:tenant_id = ? AND is_deleted = false。所有默认查询的第一个 AND。 */
export function scope(table: { tenantId: AnyPgColumn; isDeleted: AnyPgColumn }, tenantId: string): SQL {
  // and() 的参数都非空,结果必然非空
  return and(eq(table.tenantId, tenantId), eq(table.isDeleted, false))!
}

/** 软删除:只置标记,绝不物理 DELETE。幂等(已删除的行不会被重复更新)。 */
export async function softDelete(db: Db, table: CommonTable, tenantId: string, id: string, by: string): Promise<void> {
  await db
    .update(table)
    // set 的键是列名的结构性匹配,这里的 cast 只是绕过 drizzle 对泛型表的 set 类型限制
    .set({ isDeleted: true, deletedAt: new Date(), updatedBy: by, updatedAt: new Date() } as Record<string, unknown>)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, id), eq(table.isDeleted, false)))
}

/**
 * 审计更新:自动写 updated_by/updated_at;无论 patch 传什么,
 * 强制剥离 id/tenant_id/created_by/created_at(这四个字段不可变)。
 */
export async function auditedUpdate(
  db: Db,
  table: CommonTable,
  tenantId: string,
  id: string,
  by: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { id: _id, tenantId: _t, createdBy: _cb, createdAt: _ca, ...safe } = patch
  await db
    .update(table)
    .set({ ...safe, updatedBy: by, updatedAt: new Date() } as Record<string, unknown>)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, id), eq(table.isDeleted, false)))
}
