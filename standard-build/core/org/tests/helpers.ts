// org 测试共用工具:建 PGlite + 跑生产迁移 + 同步测试权限点 + 引导租户。
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Ctx, Db } from '../../db/client'
import { bootstrapTenant } from '../logic/bootstrap'
import { syncPermissions } from '../logic/role'

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations')

export type OrgTestDb = { db: Db; raw: PGlite; close: () => Promise<void> }

export async function createOrgTestDb(): Promise<OrgTestDb> {
  const raw = new PGlite()
  const db = drizzle(raw) as unknown as Db
  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS })
  // 测试用权限点(权限是代码定义的系统级清单)
  await syncPermissions(db, [
    { code: 'partner:view', name: '查看伙伴', module: 'partner', type: 'action' },
    { code: 'partner:edit', name: '编辑伙伴', module: 'partner', type: 'action' },
    { code: 'finance:view', name: '查看财务', module: 'finance', type: 'action' },
  ])
  return { db, raw, close: () => raw.close() }
}

let seq = 0
/** 引导一个测试租户,返回老板 ctx(老板是超管,建测试数据用) */
export async function seedTenant(db: Db, name = '测试公司') {
  seq += 1
  const { tenant, rootDept, owner } = await bootstrapTenant(db, {
    tenantName: name,
    owner: { name: '老板', empNo: `BOSS-${seq}`, phone: `1380000${String(seq).padStart(4, '0')}`, password: 'boss-pass-123' },
  })
  // entityId 默认=根部门(根部门恒为「财务独立核算」账套):让 finance 测试天然落在根账套
  const ownerCtx: Ctx = { tenantId: tenant.id, employeeId: owner.id, entityId: rootDept.id }
  return { tenant, rootDept, owner, ownerCtx }
}
