import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../../core/db/client'
import type { AppEnv } from '../../core/http/middleware'
import { getUnreadCount, listMyNotifications, markAllRead, markRead } from './logic'
import { limitField } from '../../core/http/pagination'

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: limitField(),
  // ★别用 z.coerce.boolean():查询串里的 'false' 经 Boolean('false') 得到 **true**,
  //   表现是「切到未读」正常、「切回全部」也只剩未读。全仓 boolean 查询参数都走这个枚举写法。
  unreadOnly: z.enum(['true', 'false']).optional(),
})

export function inappNotifyRoutes(db: Db) {
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    // 未读数（轮询铃铛角标用）
    .get('/count', async (c) => {
      const count = await getUnreadCount(db, ctxOf(c))
      return c.json({ count })
    })
    // 我的通知列表（游标分页）
    .get('/', async (c) => {
      const q = ListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
      const result = await listMyNotifications(db, ctxOf(c), {
        cursor: q.cursor,
        limit: q.limit,
        unreadOnly: q.unreadOnly === 'true',
      })
      return c.json(result)
    })
    // 标记单条已读
    .patch('/:id/read', async (c) => {
      await markRead(db, ctxOf(c), c.req.param('id'))
      return c.json({ ok: true })
    })
    // 全部标记已读
    .patch('/read-all', async (c) => {
      const result = await markAllRead(db, ctxOf(c))
      return c.json(result)
    })
}
