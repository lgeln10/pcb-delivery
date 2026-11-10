// core/db/templates/polymorphic-link/polymorphic-link-template.ts
// ★标准实现模板:多态关联 (doc_type, doc_id) + 孤儿检查。带完整测试。
//
// 【用法】拷贝到你的模块(document 的附件/日志/关联、finance 的凭证来源),
// 把 demoAttachments 换成你的链接表,按你的业务注册 docType → 目标表。**不要 import 本文件**。
//
// 【设计】(doc_type, doc_id) 弱关联业务单据,**库层有意不建外键**(目标表是运行时才确定的多张表)。
// 代价:完整性靠"孤儿检查"测试/巡检兜底——链接必须指向存在且未软删的单据(全局不变量)。
import { sql } from 'drizzle-orm'
import { index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core'
import { commonFields } from '../../common-fields'
import type { Db } from '../../client'

/** 多态引用列组:拷贝进你的链接表定义 */
export const polymorphicRefColumns = {
  docType: varchar('doc_type', { length: 32 }).notNull(),
  docId: uuid('doc_id').notNull(),
}

// ── demo 链接表(仅测试时建表;拷贝时换成你的附件/日志/关联表)──────────────
export const demoAttachments = pgTable(
  'demo_attachments',
  {
    ...commonFields,
    ...polymorphicRefColumns,
    filename: text('filename').notNull(),
  },
  (t) => [index('demo_att_doc_idx').on(t.tenantId, t.docType, t.docId)],
)

/**
 * docType 注册表:声明每种 doc_type 对应哪张物理表。
 * 拷贝后按你的模块填(如 { sales_order: 'sales_orders', voucher: 'vouchers' })。
 */
export type DocTypeRegistry = Record<string, { tableName: string }>

export type OrphanLink = {
  linkId: string
  docType: string
  docId: string
  reason: 'unknown_doc_type' | 'target_missing_or_deleted'
}

/**
 * ★孤儿检查:扫描链接表,找出指向"未注册类型 / 不存在 / 已软删"目标的行。
 * 不变量测试断言其返回空数组。每种 docType 一条 SQL(O(类型数),不是 O(行数),无 N+1)。
 * 注:tableName 来自代码内注册表(白名单),不是用户输入,拼接表名安全;id 列表走参数化。
 */
export async function findOrphans(
  db: Db,
  linkTableName: string,
  tenantId: string,
  registry: DocTypeRegistry,
): Promise<OrphanLink[]> {
  const links = (await db.execute(sql`
    select id, doc_type, doc_id from ${sql.identifier(linkTableName)}
    where tenant_id = ${tenantId} and is_deleted = false
  `)) as { rows: { id: string; doc_type: string; doc_id: string }[] }

  const orphans: OrphanLink[] = []
  const byType = new Map<string, { id: string; doc_id: string }[]>()
  for (const row of links.rows) {
    if (!registry[row.doc_type]) {
      orphans.push({ linkId: row.id, docType: row.doc_type, docId: row.doc_id, reason: 'unknown_doc_type' })
      continue
    }
    const list = byType.get(row.doc_type) ?? []
    list.push({ id: row.id, doc_id: row.doc_id })
    byType.set(row.doc_type, list)
  }

  for (const [docType, rows] of byType) {
    const target = registry[docType]!
    const ids = [...new Set(rows.map((r) => r.doc_id))]
    const existing = (await db.execute(sql`
      select id from ${sql.identifier(target.tableName)}
      where tenant_id = ${tenantId} and is_deleted = false
        and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `)) as { rows: { id: string }[] }
    const ok = new Set(existing.rows.map((r) => r.id))
    for (const r of rows) {
      if (!ok.has(r.doc_id)) {
        orphans.push({ linkId: r.id, docType, docId: r.doc_id, reason: 'target_missing_or_deleted' })
      }
    }
  }
  return orphans
}
