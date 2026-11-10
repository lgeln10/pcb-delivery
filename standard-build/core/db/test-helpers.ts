// core/db/test-helpers.ts
// 测试专用:PGlite(进程内真 Postgres)+ drizzle。每个测试文件建独立实例,无共享状态。
// 真 PG 语义:CHECK 约束、部分唯一索引、advisory lock、事务回滚全部可测。
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import type { Db } from './client'

export type TestDb = { db: Db; raw: PGlite; close: () => Promise<void> }

export async function createTestDb(): Promise<TestDb> {
  const raw = new PGlite()
  const db = drizzle(raw) as unknown as Db
  return { db, raw, close: () => raw.close() }
}

/** 模板 demo 表的公共字段 DDL 片段(与 core/db/common-fields.ts 一致) */
export const COMMON_FIELDS_DDL = `
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_at timestamptz
`
