import { sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { commonFields } from '../../core/db/common-fields'

// 可扩展：future modules can add their own source_type values
// ★source_type 在库层**没有 CHECK**(只有 type 有),所以加一个值只改这个数组即可、不需要迁移 ——
//   但**必须同时在 notification-target.ts 配落点**,否则 tests/notification-link.test.ts 会红
//   (那条不变量是「每种 sourceType 都点得开」,没落点的通知等于一条死消息)。
// ★全集。新增一种**必须**同时:① 加进这里 ② 在 notification-target.ts 配点击后果
//   ③ 加进迁移 0295 的 CHECK。漏 ② 的表现是「点了没反应且不报错」——
//   'partner'(客户移交)当年就是这么漏的,三处都没登记,死链在线上活了很久。
export const INAPP_NOTIFY_SOURCE_TYPES = ['db_backup'] as const
export type InappNotifySourceType = (typeof INAPP_NOTIFY_SOURCE_TYPES)[number]

// 通知分类（铃铛分组/图标/筛选用）。可扩展：future modules can add their own types.
export const INAPP_NOTIFY_TYPES = ['system', 'reminder'] as const
export type InappNotifyType = (typeof INAPP_NOTIFY_TYPES)[number]

export const inappNotifications = pgTable(
  'inapp_notifications',
  {
    ...commonFields,
    recipientId: uuid('recipient_id').notNull(),   // 收信人 employee_id
    type: text('type').notNull().default('system'),// 分类：system|approval|reminder|feature_request
    title: text('title').notNull(),
    body: text('body').notNull(),
    sourceType: text('source_type').notNull(),     // 'feature_request' | ...（来源单据类型）
    sourceId: uuid('source_id').notNull(),          // 关联原始单据 id
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    // 核心查询：我的未读列表，时间倒序
    index('inapp_notifications_recipient_idx').on(t.tenantId, t.recipientId, t.isRead, t.createdAt),
    check(
      'inapp_notifications_type_check',
      sql`${t.type} in ('system','reminder')`,
    ),
    // ★source_type 原先没有任何库层约束,于是没登记的类型(如 'partner')写得进去、
    //   前端点了没反应,两边都不报错。约束以 NOT VALID 加(见迁移 0295):只管新写入,
    //   不回扫存量行 —— 存量里可能有早已废弃的类型,让迁移在客户机上炸掉不值得。
    check(
      'inapp_notifications_source_type_check',
      sql`${t.sourceType} in ('db_backup')`,
    ),
  ],
)

export type InappNotification = typeof inappNotifications.$inferSelect
