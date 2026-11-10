// modules/notify/routes.ts — 通知渠道配置 HTTP 路由。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../../core/db/client'
import type { AppEnv } from '../../core/http/middleware'
import { requirePermission } from '../../core/http/middleware'
import {
  getEmailConfig, saveEmailConfig, sendTestEmail,
  getFeishuConfig, saveFeishuConfig, sendTestFeishu,
} from './logic'

const EmailBody = z.object({
  enabled: z.boolean(),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string(), // 可为占位符(沿用原密码)
  fromName: z.string().max(100),
  fromAddress: z.string().max(200),
})

const FeishuBody = z.object({
  enabled: z.boolean(),
  webhookUrl: z.string().max(500), // 可为占位符(沿用原地址)
  secret: z.string().max(200), // 可为占位符 / 空串(关闭加签)
})

export function notifyRoutes(db: Db) {
  const config = requirePermission(db, 'notify:config')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    .get('/config/email', config, async (c) => c.json(await getEmailConfig(db, ctxOf(c))))
    .patch('/config/email', config, async (c) =>
      c.json(await saveEmailConfig(db, ctxOf(c), EmailBody.parse(await c.req.json()))),
    )
    .post('/test/email', config, async (c) => {
      await sendTestEmail(db, ctxOf(c))
      return c.json({ ok: true })
    })
    .get('/config/feishu', config, async (c) => c.json(await getFeishuConfig(db, ctxOf(c))))
    .patch('/config/feishu', config, async (c) =>
      c.json(await saveFeishuConfig(db, ctxOf(c), FeishuBody.parse(await c.req.json()))),
    )
    .post('/test/feishu', config, async (c) => {
      await sendTestFeishu(db, ctxOf(c))
      return c.json({ ok: true })
    })
}
