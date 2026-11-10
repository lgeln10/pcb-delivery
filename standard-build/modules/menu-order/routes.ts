// modules/menu-order/routes.ts — 菜单排序 HTTP 路由。
// GET 仅需登录:壳层(src/App.vue)每次渲染侧边栏都要读它,给读加权限码等于让没有该码的员工
//     看到一个乱序/空的导航。写操作叠 menu-order:manage。
// ★整份覆盖(PUT)而不是增量补丁:顺序本来就是一个整体,一次给全量前端最不容易写错,
//   也不用处理「补丁乱序到达」这种没人测得到的情况。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../../core/db/client'
import type { AppEnv } from '../../core/http/middleware'
import { requirePermission } from '../../core/http/middleware'
import { getMenuOrder, saveMenuOrder } from './logic'

// zod 只挡住明显不是这个形状的请求体;key 的字符集、条数上限、去重在 logic 里统一做
// (那份规则测试直接调 saveMenuOrder 就能覆盖,不必起 HTTP)。
const SaveBody = z.object({
  groups: z.array(z.string()),
  items: z.record(z.string(), z.array(z.string())),
})

export function menuOrderRoutes(db: Db) {
  const manage = requirePermission(db, 'menu-order:manage')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await getMenuOrder(db, ctxOf(c))))
    .put('/', manage, async (c) => {
      const body = SaveBody.parse(await c.req.json())
      return c.json(await saveMenuOrder(db, ctxOf(c), body))
    })
}
