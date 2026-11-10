// modules/feature-toggle/routes.ts — 功能开关 HTTP 路由。
// GET 仅需登录(所有用户拿禁用集来隐藏导航/按钮);写操作叠 feature-toggle:manage。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../../core/db/client'
import type { AppEnv } from '../../core/http/middleware'
import { requirePermission } from '../../core/http/middleware'
import { listDisabledKeys, setToggle } from './logic'

const SetBody = z.object({ key: z.string().min(1).max(120), enabled: z.boolean() })

export function featureToggleRoutes(db: Db) {
  const manage = requirePermission(db, 'feature-toggle:manage')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    .get('/', async (c) => c.json({ disabledKeys: await listDisabledKeys(db, ctxOf(c)) }))
    .put('/', manage, async (c) => {
      const body = SetBody.parse(await c.req.json())
      await setToggle(db, ctxOf(c), body)
      return c.json({ ok: true })
    })
}
