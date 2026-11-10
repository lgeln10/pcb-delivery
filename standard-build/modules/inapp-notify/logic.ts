import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt, ne } from 'drizzle-orm'
import type { Ctx, Db } from '../../core/db/client'
import { scope } from '../../core/db/soft-delete'
import { InappNotifyError } from './errors'
import {
  inappNotifications,
  type InappNotification,
  type InappNotifySourceType,
  type InappNotifyType,
} from './model'
import { clampLimit } from '../../core/http/pagination'

export type CreateNotificationInput = {
  tenantId: string
  createdBy: string       // 操作人（发起通知方的 employee_id，用于 audit）
  recipientId: string     // 收信人 employee_id
  type?: InappNotifyType  // 分类，默认 'system'
  title: string
  body: string
  sourceType: InappNotifySourceType
  sourceId: string
  // 可选结构化表格:不落库(站内信仍读 body 文本),只透传给 sink——支持卡片表格的 IM 平台(飞书)渲染成规整表格。
  imTable?: { columns: string[]; rows: string[][]; widths?: number[] }
}

// 通知汇聚点(sink):其它渠道(企业 IM 外发等)在启动时注册,每写一条站内信就 fire-and-forget 收到一份。
// ★与调用方解耦(同 registerJob/registerApprovalCompletionHook 范式):inapp-notify 不 import 任何外发模块;
//   由组合根 server.ts 注册 sink 并在闭包里捕获顶层 db(★绝不用调用方的事务 tx——sink 是异步、不进事务)。
export type NotificationSink = (input: CreateNotificationInput) => void | Promise<void>
const sinks: NotificationSink[] = []
export function registerNotificationSink(fn: NotificationSink): void {
  sinks.push(fn)
}

/** 创建一条站内信。最佳努力：调用方 catch 后静默，不阻断业务主流程。 */
export async function createNotification(db: Db, input: CreateNotificationInput): Promise<void> {
  await db.insert(inappNotifications).values({
    id: randomUUID(),
    tenantId: input.tenantId,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    recipientId: input.recipientId,
    type: input.type ?? 'system',
    title: input.title,
    body: input.body,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  })
  // fire-and-forget 广播给各 sink：不 await、不进调用方事务、异常吞掉，绝不阻断/拖慢主流程。
  for (const sink of sinks) {
    void Promise.resolve()
      .then(() => sink(input))
      .catch(() => {})
  }
}

/**
 * 把某个来源单据**尚未读**的通知一次性收口:标已读 + 改写标题/正文。
 *
 * ★为什么需要:发通知的那一刻是对的,但事后状态会变。典型场景是审批的**任一签**——
 *   角色级审批会通知该角色全部持有者,其中一人批了单子就走了,其余人手里那条
 *   「需要您处理」永远留着:角标不减、点进去待办列表还是空的,看着像系统坏了
 *   (2026-08-04 线上实测:第二级配「系统管理员」角色,批完后其余管理员正是这个现象)。
 *
 * 语义:
 * - **只动未读**。已读的不再改写 —— 那是用户已经看过的历史,改它等于篡改他读到的内容。
 * - 幂等:重复调用第二次匹配不到未读行,0 更新。
 * - `exceptRecipientId` 用来跳过「真正处理了它的那个人」:他那条是有效历史,不该被改成「已由他人处理」。
 * - 返回受影响条数,供调用方记日志/测试断言。
 */
export async function resolveNotificationsBySource(
  db: Db,
  input: {
    tenantId: string
    sourceType: InappNotifySourceType
    sourceId: string
    title: string
    body: string
    exceptRecipientId?: string
    actorId: string // 写进 updated_by,留下「谁的动作导致收口」
  },
): Promise<number> {
  const conds = [
    scope(inappNotifications, input.tenantId),
    eq(inappNotifications.sourceType, input.sourceType),
    eq(inappNotifications.sourceId, input.sourceId),
    eq(inappNotifications.isRead, false),
  ]
  if (input.exceptRecipientId) conds.push(ne(inappNotifications.recipientId, input.exceptRecipientId))
  const rows = await db
    .update(inappNotifications)
    .set({
      title: input.title,
      body: input.body,
      isRead: true,
      readAt: new Date(),
      updatedBy: input.actorId,
      updatedAt: new Date(),
    })
    .where(and(...conds))
    .returning({ id: inappNotifications.id })
  return rows.length
}

export type ListMyNotificationsOpts = {
  cursor?: string   // ISO 时间串（createdAt 倒序游标）
  limit?: number
  /**
   * 只看未读。★必须在 SQL 里过滤,不能让前端拿整页回去自己筛 —— 游标分页下
   * 「一页 20 条恰好全是已读」会让未读页显示成空,而下面其实还有未读。
   */
  unreadOnly?: boolean
}

export type NotificationItem = InappNotification

/** 我的站内信列表，倒序，游标分页，上限 50。 */
export async function listMyNotifications(
  db: Db,
  ctx: Ctx,
  opts: ListMyNotificationsOpts = {},
): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit)
  const conds = [
    scope(inappNotifications, ctx.tenantId),
    eq(inappNotifications.recipientId, ctx.employeeId),
  ]
  if (opts.unreadOnly) {
    conds.push(eq(inappNotifications.isRead, false))
  }
  if (opts.cursor) {
    conds.push(lt(inappNotifications.createdAt, new Date(opts.cursor)))
  }
  const rows = await db
    .select()
    .from(inappNotifications)
    .where(and(...conds))
    .orderBy(desc(inappNotifications.createdAt))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.createdAt.toISOString() : null,
  }
}

/** 我的未读数（上限 99，防止数字太大）。 */
export async function getUnreadCount(db: Db, ctx: Ctx): Promise<number> {
  const rows = await db
    .select({ id: inappNotifications.id })
    .from(inappNotifications)
    .where(
      and(
        scope(inappNotifications, ctx.tenantId),
        eq(inappNotifications.recipientId, ctx.employeeId),
        eq(inappNotifications.isRead, false),
      ),
    )
    .limit(99)
  return rows.length
}

/** 标记单条已读。操作人必须是收信人本人。 */
export async function markRead(db: Db, ctx: Ctx, id: string): Promise<void> {
  const rows = await db
    .select()
    .from(inappNotifications)
    .where(and(scope(inappNotifications, ctx.tenantId), eq(inappNotifications.id, id)))
    .limit(1)
  const row = rows[0]
  if (!row) throw new InappNotifyError('NOT_FOUND', '通知不存在')
  if (row.recipientId !== ctx.employeeId) throw new InappNotifyError('FORBIDDEN', '只能标记自己的通知')
  if (row.isRead) return // 幂等
  await db
    .update(inappNotifications)
    .set({ isRead: true, readAt: new Date(), updatedBy: ctx.employeeId, updatedAt: new Date() })
    .where(and(eq(inappNotifications.tenantId, ctx.tenantId), eq(inappNotifications.id, id)))
}

/** 全部标记已读。 */
export async function markAllRead(db: Db, ctx: Ctx): Promise<{ updated: number }> {
  const result = await db
    .update(inappNotifications)
    .set({ isRead: true, readAt: new Date(), updatedBy: ctx.employeeId, updatedAt: new Date() })
    .where(
      and(
        scope(inappNotifications, ctx.tenantId),
        eq(inappNotifications.recipientId, ctx.employeeId),
        eq(inappNotifications.isRead, false),
      ),
    )
  return { updated: result.rowCount ?? 0 }
}
