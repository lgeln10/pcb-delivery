// core/license/routes.ts
// GET /api/license — 授权状态(套餐/席位/到期/只读/是否已配置),供后台展示 + 激活引导。
// POST /api/license/activate — 界面上传授权文件激活(验签→落盘)。/api/license 已豁免只读拦截,故未激活也能调。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { getLicenseStatus, licenseEnforced, hasLicenseSource, licenseHasFeature, activateLicense } from './state'

const ActivateBody = z.object({ license: z.string().min(16).max(4000), server: z.string().max(300).optional() })

async function snapshot(db: Db) {
  return { enforced: licenseEnforced(), configured: hasLicenseSource(), aiEnabled: licenseHasFeature('ai'), ...(await getLicenseStatus(db)) }
}

export function licenseRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await snapshot(db)))
    .post('/activate', async (c) => {
      activateLicense(ActivateBody.parse(await c.req.json()))
      return c.json({ ok: true, ...(await snapshot(db)) })
    })
}
