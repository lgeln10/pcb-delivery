// polymorphic-link-template 的孤儿检查测试。模块拷贝模板后,这份测试一起拷走改造。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { COMMON_FIELDS_DDL, createTestDb, type TestDb } from '../../test-helpers'
import { findOrphans, type DocTypeRegistry } from './polymorphic-link-template'

let t: TestDb
const tenantId = randomUUID()
const registry: DocTypeRegistry = { fake_order: { tableName: 'fake_orders' } }

beforeAll(async () => {
  t = await createTestDb()
  await t.raw.exec(`
    create table fake_orders ( ${COMMON_FIELDS_DDL}, title text not null );
    create table demo_attachments (
      ${COMMON_FIELDS_DDL},
      doc_type varchar(32) not null,
      doc_id uuid not null,
      filename text not null
    );
    create index demo_att_doc_idx on demo_attachments (tenant_id, doc_type, doc_id);
  `)
})
afterAll(async () => t.close())

async function insertOrder(): Promise<string> {
  const id = randomUUID()
  await t.db.execute(sql`insert into fake_orders (id, tenant_id, title) values (${id}, ${tenantId}, 'o')`)
  return id
}
async function insertLink(docType: string, docId: string): Promise<string> {
  const id = randomUUID()
  await t.db.execute(
    sql`insert into demo_attachments (id, tenant_id, doc_type, doc_id, filename) values (${id}, ${tenantId}, ${docType}, ${docId}, 'f.pdf')`,
  )
  return id
}

describe('polymorphic-link-template 孤儿检查', () => {
  it('链接指向存在且未删的单据 → 无孤儿', async () => {
    const orderId = await insertOrder()
    await insertLink('fake_order', orderId)
    expect(await findOrphans(t.db, 'demo_attachments', tenantId, registry)).toEqual([])
  })

  it('目标被软删 → 检出孤儿', async () => {
    const orderId = await insertOrder()
    const linkId = await insertLink('fake_order', orderId)
    await t.db.execute(sql`update fake_orders set is_deleted = true, deleted_at = now() where id = ${orderId}`)
    const orphans = await findOrphans(t.db, 'demo_attachments', tenantId, registry)
    expect(orphans).toContainEqual({
      linkId,
      docType: 'fake_order',
      docId: orderId,
      reason: 'target_missing_or_deleted',
    })
  })

  it('目标不存在 → 检出孤儿', async () => {
    const ghost = randomUUID()
    const linkId = await insertLink('fake_order', ghost)
    const orphans = await findOrphans(t.db, 'demo_attachments', tenantId, registry)
    expect(orphans.some((o) => o.linkId === linkId && o.reason === 'target_missing_or_deleted')).toBe(true)
  })

  it('未注册的 doc_type → 检出孤儿', async () => {
    const linkId = await insertLink('unknown_type', randomUUID())
    const orphans = await findOrphans(t.db, 'demo_attachments', tenantId, registry)
    expect(orphans.some((o) => o.linkId === linkId && o.reason === 'unknown_doc_type')).toBe(true)
  })
})
