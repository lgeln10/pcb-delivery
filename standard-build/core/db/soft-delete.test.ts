// 软删除/审计机制的全局不变量测试:
// ① 删除只置标记不物理 DELETE ② scope() 默认过滤已删 ③ created_by/created_at 不可变
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { COMMON_FIELDS_DDL, createTestDb, type TestDb } from './test-helpers'
import { auditedUpdate, softDelete, type CommonTable } from './soft-delete'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { commonFields } from './common-fields'

const demoThings = pgTable('demo_things', { ...commonFields, name: text('name').notNull() })

let t: TestDb
const tenantId = randomUUID()
const operator = randomUUID()

beforeAll(async () => {
  t = await createTestDb()
  await t.raw.exec(`create table demo_things ( ${COMMON_FIELDS_DDL}, name text not null );`)
})
afterAll(async () => t.close())

async function insertThing(creator: string): Promise<string> {
  const id = randomUUID()
  await t.db.execute(
    sql`insert into demo_things (id, tenant_id, created_by, name) values (${id}, ${tenantId}, ${creator}, 'x')`,
  )
  return id
}
async function fetchRow(id: string) {
  const r = (await t.db.execute(sql`select * from demo_things where id = ${id}`)) as { rows: any[] }
  return r.rows[0]
}

describe('core/db 软删除 + 审计', () => {
  it('softDelete 只置 is_deleted/deleted_at,行仍物理存在', async () => {
    const id = await insertThing(operator)
    await softDelete(t.db, demoThings as unknown as CommonTable, tenantId, id, operator)
    const row = await fetchRow(id)
    expect(row).toBeDefined() // 没有被物理删除
    expect(row.is_deleted).toBe(true)
    expect(row.deleted_at).not.toBeNull()
    expect(row.updated_by).toBe(operator)
  })

  it('auditedUpdate 强制剥离 created_by/created_at(不可变),并写 updated_by/updated_at', async () => {
    const creator = randomUUID()
    const id = await insertThing(creator)
    const before = await fetchRow(id)
    await auditedUpdate(t.db, demoThings as unknown as CommonTable, tenantId, id, operator, {
      name: 'renamed',
      createdBy: randomUUID(), // 恶意尝试改 created_by
      createdAt: new Date(0),
      id: randomUUID(),
      tenantId: randomUUID(),
    })
    const after = await fetchRow(id)
    expect(after.name).toBe('renamed')
    expect(after.created_by).toBe(creator) // created_by 不可变
    expect(after.created_at).toEqual(before.created_at)
    expect(after.tenant_id).toBe(tenantId)
    expect(after.updated_by).toBe(operator)
  })

  it('auditedUpdate 不会更新已软删的行', async () => {
    const id = await insertThing(operator)
    await softDelete(t.db, demoThings as unknown as CommonTable, tenantId, id, operator)
    await auditedUpdate(t.db, demoThings as unknown as CommonTable, tenantId, id, operator, { name: 'zombie' })
    expect((await fetchRow(id)).name).toBe('x')
  })
})
