// modules/menu-order/model.ts
// 菜单排序:每租户**唯一一行**,存全系统统一的侧边栏顺序。
//   group_order  string[]                    一级菜单(导航分组)key 顺序
//   item_order   Record<string, string[]>    每个分组下二级菜单 key 顺序
//
// ★为什么不按人/按角色存:菜单顺序是「这家公司怎么摆」,不是「我喜欢怎么摆」——
//   做成个性化会让同事之间没法互相指路(「点左边第三个」变成一句废话),
//   而且培训材料、手册截图立刻失效。要个性化是重改动,先确认真需要。
// ★只存顺序,不存可见性:隐藏菜单是功能开关(feature-toggle)的事,两者正交。
import { sql } from 'drizzle-orm'
import { jsonb, pgTable, uniqueIndex } from 'drizzle-orm/pg-core'
import { commonFields } from '../../core/db/common-fields'

export const menuOrders = pgTable(
  'menu_orders',
  {
    ...commonFields,
    groupOrder: jsonb('group_order').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    itemOrder: jsonb('item_order').$type<Record<string, string[]>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [uniqueIndex('menu_orders_tenant_uq').on(t.tenantId).where(sql`is_deleted = false`)],
)

export type MenuOrderRow = typeof menuOrders.$inferSelect
