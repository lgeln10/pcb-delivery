// core/db/common-fields.ts
// ★全局公共字段(DATA_MODEL_org §0):每张业务实体表 spread 这组列,只在此定义一次。
// 这是"列定义"级复用,不是行为基类——spread 之后各表完全自包含,符合"模板不是基类"原则。
// 例外:tenant 是隔离根,只用 id/created_at/is_deleted/deleted_at;permission 是系统级清单,不带公共字段。
//
// 配套全局不变量(写成测试,见 core/db/soft-delete.test.ts 与各模块不变量测试):
// - 删除只置 is_deleted=true + deleted_at,禁物理 DELETE
// - 默认查询过滤 is_deleted=false
// - created_by 一经写入不可变
// - 每个查询强制带 tenant_id
import { boolean, timestamp, uuid } from 'drizzle-orm/pg-core'

export const commonFields = {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  // 创建人 employee_id。可空仅用于系统引导期之外的极端场景;业务写入必须填。
  // data_scope=SELF 靠它判断"本人创建"。
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  isDeleted: boolean('is_deleted').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}
