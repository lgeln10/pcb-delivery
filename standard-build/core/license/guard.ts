// core/license/guard.ts
// 只读强制中间件:授权过期(过宽限)时,拦掉所有写操作(非 GET)。仅在启用强制时生效。
// 放行登录与「查看授权状态」本身,否则续费后无法操作。
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/middleware'
import { isWriteBlocked, licenseHasFeature } from './state'

// 本仓不再单独售卖智能体工作台。前缀留空,授权中间件不再拦截业务路由。
const AI_PREFIXES: string[] = []

/** 功能特性门控:未采购智能体工作台 → AI 板块接口一律 403(与前端隐藏导航配合)。 */
export function licenseFeatureGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.req.path
    if (AI_PREFIXES.some((x) => p.startsWith(x)) && !licenseHasFeature('ai')) {
      const err = new Error('未采购「智能体工作台」功能') as Error & { code: string }
      err.code = 'LICENSE_FEATURE'
      throw err
    }
    await next()
  }
}

export function licenseWriteGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET' && isWriteBlocked()) {
      const p = c.req.path
      if (!p.startsWith('/api/auth') && !p.startsWith('/api/license')) {
        const err = new Error('授权已过期，系统进入只读状态，请联系续费') as Error & { code: string }
        err.code = 'LICENSE_EXPIRED'
        throw err
      }
    }
    await next()
  }
}
