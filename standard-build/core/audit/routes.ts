// core/audit/routes.ts — 审计查询路由(仅 audit:view)。审计只读,无写接口(append-only)。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { requirePermission } from '../http/middleware'
import { listAudit } from './logic'
import { limitField } from '../../core/http/pagination'

const ListQuery = z.object({
  actorId: z.uuid().optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.uuid().optional(),
  result: z.enum(['success', 'failed']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().optional(),
  limit: limitField(),
})

export function auditRoutes(db: Db) {
  const view = requirePermission(db, 'audit:view')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')
  return new Hono<AppEnv>().get('/', view, async (c) => c.json(await listAudit(db, ctxOf(c), ListQuery.parse(c.req.query()))))
}
