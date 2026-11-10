// core/llm/routes.ts — 平台 LLM 配置 HTTP 路由(挂在「系统设置 → AI 大模型」)。
// 读/写都需 app-settings:manage(LLM 是平台级基础设施,归系统设置管理员维护)。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { requirePermission } from '../http/middleware'
import { deleteProviderKey, deleteSceneConfig, getConfig, saveProviderKey, updateConfig, upsertSceneConfig } from './config'
import { billingAccount, billingBill, billingBillCsv, billingLedger, billingUsage } from './billing'

// 主模型:provider/model + 备用 provider/model(备用可空,传空串=清除)+ 深度思考总开关。
const ConfigBody = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  fallbackProvider: z.string().nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  thinkingEnabled: z.boolean().optional(),
})
// 场景覆盖:scene 必填,其余可空(空=清除该列继承主模型)。
// thinkingEnabled 是三态:null=继承主模型,true/false=本场景显式覆盖。
const SceneBody = z.object({
  scene: z.string().min(1),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  fallbackProvider: z.string().nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  thinkingEnabled: z.boolean().nullable().optional(),
})
const ProviderKeyBody = z.object({ provider: z.string().min(1), apiKey: z.string().min(1) })

export function llmRoutes(db: Db) {
  const manage = requirePermission(db, 'app-settings:manage')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    .get('/config', manage, async (c) => c.json(await getConfig(db, ctxOf(c))))
    .patch('/config', manage, async (c) => c.json(await updateConfig(db, ctxOf(c), ConfigBody.parse(await c.req.json()))))
    // 场景模型覆盖:upsert / 清除(回到继承主模型)
    .put('/config/scene', manage, async (c) => c.json(await upsertSceneConfig(db, ctxOf(c), SceneBody.parse(await c.req.json()))))
    .delete('/config/scene/:scene', manage, async (c) => c.json(await deleteSceneConfig(db, ctxOf(c), c.req.param('scene'))))
    // 各供应商 api-key:存(加密入库)/清除(回退 env)。明文只进不出。
    .put('/config/provider-key', manage, async (c) => {
      const body = ProviderKeyBody.parse(await c.req.json())
      await saveProviderKey(db, ctxOf(c), body.provider, body.apiKey)
      return c.json({ ok: true })
    })
    .delete('/config/provider-key/:provider', manage, async (c) => {
      await deleteProviderKey(db, ctxOf(c), c.req.param('provider'))
      return c.json({ ok: true })
    })
    // ── SixAM 智能云账户(余额/充值记录/用量/对账单;只读代理,见 core/llm/billing.ts)──
    .get('/billing/account', manage, async (c) => c.json(await billingAccount(db, ctxOf(c))))
    .get('/billing/usage', manage, async (c) => c.json(await billingUsage(db, ctxOf(c), Number(c.req.query('days') ?? 30))))
    .get('/billing/ledger', manage, async (c) =>
      c.json(await billingLedger(db, ctxOf(c), Number(c.req.query('limit') ?? 20), Number(c.req.query('offset') ?? 0))))
    .get('/billing/bill', manage, async (c) => {
      const month = c.req.query('month') ?? ''
      if (c.req.query('format') === 'csv') {
        const res = await billingBillCsv(db, ctxOf(c), month)
        return c.newResponse(res.body, 200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': res.headers.get('content-disposition') ?? `attachment; filename="bill-${month}.csv"`,
        })
      }
      return c.json(await billingBill(db, ctxOf(c), month))
    })
}
