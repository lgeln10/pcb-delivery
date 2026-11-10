// modules/feature-toggle/model.ts
// 功能开关:每租户对「菜单组 / 菜单 / 功能(权限码)」的启用状态。
// 缺省(无行)= 启用;显式关闭写一行 enabled=false。feature_key 三类前缀:
//   group:<组key>(如 group:finance-mgmt) / menu:<菜单key>(如 menu:finance-budget) / perm:<权限码>(如 perm:finance:asset)
// ★纯前端口径:本表只做「存储 + 读取」,不参与后端鉴权;导航/权限页/按钮的隐藏都在前端据此判定。
import { sql } from 'drizzle-orm'
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { commonFields } from '../../core/db/common-fields'

export const featureToggles = pgTable(
  'feature_toggles',
  {
    ...commonFields,
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [uniqueIndex('feature_toggles_tenant_key_idx').on(t.tenantId, t.featureKey).where(sql`is_deleted = false`)],
)
export type FeatureToggle = typeof featureToggles.$inferSelect
