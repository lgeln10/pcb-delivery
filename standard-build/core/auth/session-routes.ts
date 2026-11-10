// core/auth/session-routes.ts — 本人的会话管理(退出登录 / 踢掉所有设备)。
// 挂在 requireAuth **之后**(/api/session):要先证明你是你,才能吊销你的东西。
//
// ★为什么不放进 core/org 的 /api/me:core 内依赖方向是 auth → org,
//   org 反过来 import auth 会成环。会话是 auth 的事,就放 auth。
import { Hono } from 'hono'
import type { Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { revokeAllSessions, revokeToken } from './token-revocation'
import { verifyToken } from './token'

/** 从请求头把本次用的令牌解析回来 —— requireAuth 只挂了 ctx,jti 在 payload 里。 */
function payloadOf(c: { req: { header: (k: string) => string | undefined } }, secret: string) {
  const header = c.req.header('Authorization') ?? ''
  return verifyToken(header.slice('Bearer '.length), secret)
}

export function sessionRoutes(db: Db, secret: string) {
  return (
    new Hono<AppEnv>()
      /**
       * 退出登录:只作废**当前这一枚**令牌。手机上那个会话不受影响 —— 这是用户的预期。
       *
       * ★服务令牌(svc_…)走不到这里:它们不是 HMAC 令牌,verifyToken 会抛,
       *   要吊销服务令牌走 service-token 那套(它本来就有 revokedAt)。
       */
      .post('/logout', async (c) => {
        const ctx = c.get('ctx')
        const payload = payloadOf(c, secret)
        try {
          await revokeToken(db, payload, 'logout')
          return c.json({ ok: true, scope: 'this_session' })
        } catch (e) {
          // 0198 之前签发的老令牌没有 jti,单枚吊销不了。★不能假装成功 ——
          //   退化成「吊销全部」并如实告诉前端 scope,让它能提示「其他设备也已退出」。
          //   宁可多退,不可假退。
          if (e instanceof Error && e.message === 'TOKEN_WITHOUT_JTI') {
            await revokeAllSessions(db, ctx.tenantId, ctx.employeeId)
            return c.json({ ok: true, scope: 'all_sessions', reason: 'legacy_token_without_jti' })
          }
          throw e
        }
      })
      /**
       * 退出所有设备:抬高本人吊销水位,名下全部令牌立即失效(**含当前这一枚**)。
       * 这是令牌疑似被盗时唯一真正能止血的动作 —— 因为受害者并不知道被偷的是哪一枚。
       */
      .post('/revoke-all', async (c) => {
        const ctx = c.get('ctx')
        await revokeAllSessions(db, ctx.tenantId, ctx.employeeId)
        return c.json({ ok: true, scope: 'all_sessions' })
      })
  )
}
