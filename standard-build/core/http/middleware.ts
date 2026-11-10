// core/http/middleware.ts
// 鉴权中间件(★默认拒绝:/api/* 除 login 外全部要求 Bearer token)+ 权限中间件。
// 契约测试:未带 token → 401;带 token 无权限 → 403(core/http/tests)。
import type { MiddlewareHandler } from 'hono'
import type { Ctx, Db } from '../db/client'
import { ctxFromToken } from '../auth/login'
import { AuthError } from '../auth/errors'
import { assertAccountingEntityAccess, hasPermission, resolveAccountingEntity } from '../org/api'
import { recordAuditSafe, resolveActorName } from '../audit/api'
import { clientIpOf } from './client-ip'
import { isAskAiExcludedPermCode, isAskAiSessionScopes, recordAskAiCapabilityBlock } from './askai-capability-gate'

/**
 * 审计覆写:路由 handler 里 c.set('auditOverride', …) 声明本次写操作的审计口径。
 * - skip: true → 本次不记审计(如 messenger 的已读游标上报:高频状态同步,不是业务写操作);
 * - detail 有值 → 用它替代请求体入库(如聊天正文只记 {textLength} —— audit_logs 的 detail
 *   管理端能看到,私聊内容不该在那里再存一份)。
 */
export type AuditOverride = { skip?: boolean; detail?: unknown }

/** Hono 环境类型:认证后 ctx 挂在 Variables 上,handler 用 c.get('ctx') 取 */
export type AppEnv = { Variables: { ctx: Ctx; auditOverride?: AuditOverride } }

/**
 * 认证:解析 Authorization: Bearer <token>,复查员工/租户状态,挂 ctx。失败 401。
 *
 * ★返回的中间件**必须保持具名 `requireAuthHandler`**:公开面护栏
 * (core/http/tests/public-surface.test.ts)靠这个名字在 `app.routes` 里定位
 * 「默认拒绝」那条分界线,进而断言分界线之前的路由集合等于已批准的白名单。
 * 改成匿名箭头函数会让那道护栏静默失效 —— 它会找不到分界线而不是报错。
 */
export function requireAuth(db: Db, secret: string): MiddlewareHandler<AppEnv> {
  return async function requireAuthHandler(c, next) {
    const header = c.req.header('Authorization') ?? ''
    if (!header.startsWith('Bearer ')) {
      throw new AuthError('TOKEN_INVALID', 'missing bearer token')
    }
    const ctx = await ctxFromToken(db, header.slice('Bearer '.length), secret)
    // 解析当前账套实体(财务多组织):X-Accounting-Entity 头指定要操作的独立核算部门,
    // 校验是本租户合法实体,否则回退根部门。仅 finance 消费,其余模块忽略 ctx.entityId。
    //
    // ★这里必须是 fallbackToRoot,不能抛。这个头的值来自浏览器 localStorage
    // (src/composables/useAccountingEntity.ts),是**上次选的**、会一直发,不是用户这次的指令。
    // 而「关闭某部门的独立核算」是编辑部门就能做的正常操作 —— 一旦关掉,所有把它选为当前账套的人
    // 会在 requireAuth 这一层、**每一个**请求上拿到 400,包括那条「列出可选账套」的请求:
    // 界面全空、连切回去都做不到,只能手动清 localStorage。
    // 退回根账套不是静默:响应里的 currentEntityId 会如实回报实际生效的账套,前端据此纠正选择。
    // 明确指名账套的财务操作仍拦得住 —— 那是 assertAccountingEntityAccess 的活,不是这一层的。
    const requested = c.req.header('X-Accounting-Entity') ?? null
    ctx.entityId = (await resolveAccountingEntity(db, ctx.tenantId, requested, { onInvalid: 'fallbackToRoot' })) ?? undefined
    c.set('ctx', ctx)
    await next()
  }
}

/**
 * ★审计基线:挂在 requireAuth 之后,自动记每个写操作(非 GET)。
 * 一次请求一行:操作人(ctx)+ 姓名快照 + 动作(method+路由模式)+ 目标(:id)+ 脱敏入参 + 结果。
 * best-effort:审计写失败不影响业务响应。审计本身无写接口(append-only)。
 */
export function auditWrites(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
    const ctx = c.get('ctx')
    if (!ctx) return // 仅审计已鉴权写操作(挂在 requireAuth 之后,正常必有 ctx)
    const override = c.get('auditOverride')
    if (override?.skip) return
    let detail: unknown
    if (override && 'detail' in override) {
      detail = override.detail
    } else {
      try {
        detail = await c.req.json()
      } catch {
        detail = undefined
      }
    }
    const actorName = await resolveActorName(db, ctx.tenantId, ctx.employeeId).catch(() => null)
    await recordAuditSafe(db, {
      tenantId: ctx.tenantId,
      actorEmployeeId: ctx.employeeId,
      actorName,
      action: `${method} ${c.req.routePath}`,
      targetId: c.req.param('id') ?? null,
      detail,
      source: 'http',
      result: c.res.status < 400 ? 'success' : 'failed',
      ip: clientIpOf(c), // 审计存的是可信的最后一跳,不是调用方自称的整串(见 client-ip.ts)
    })
  }
}

/** 功能权限:无该权限码 → 403(超管短路在 hasPermission 内处理) */
export function requirePermission(db: Db, permCode: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = c.get('ctx')
    // 服务令牌(svc_…)：权限只由 scopes 封顶——即使背靠超管，越出 scopes 一律 403；
    // '*' 表示放开全部。不走 hasPermission(svc 无独立角色，scopes 即授权清单)。
    // 仅 requireAuth(无 requirePermission)的路由上，svc 的残余权限 = 背靠员工自身数据；
    // 而背靠员工在签发时已被强制为最小权限服务账号(非 owner/超管，见 service-token.ts)，故可控。
    if (ctx.scopes) {
      if (!(ctx.scopes.includes('*') || ctx.scopes.includes(permCode))) {
        // ★AM-107:Ask AI 会话令牌命中「对助手全局关闭的能力」(EXCLUDED_MODULES),要和
        //   「你个人缺某业务权限」的普通 403 分开:前者返回可区分的 ASKAI_CAPABILITY_DISABLED
        //   (仍是 403,闸不变),并在服务端记一笔,供 SSE 代理据此追加一条不经过大模型的如实 notice。
        //   闸本身零改动:无论走哪条,结果都是拒绝、库里 0→0。误报防护由此天然成立 ——
        //   普通业务 403(非排除面)与非 Ask AI 的服务令牌都不会走进这个分支。
        if (isAskAiSessionScopes(ctx.scopes) && isAskAiExcludedPermCode(permCode)) {
          recordAskAiCapabilityBlock(ctx.tenantId, ctx.employeeId)
          const err = new Error(`capability disabled for assistant: ${permCode}`) as Error & { code: string }
          err.code = 'ASKAI_CAPABILITY_DISABLED'
          throw err
        }
        const err = new Error(`missing scope ${permCode}`) as Error & { code: string }
        err.code = 'FORBIDDEN'
        throw err
      }
      if (permCode.startsWith('finance:')) await assertAccountingEntityAccess(db, ctx, permCode)
      await next()
      return
    }
    if (!(await hasPermission(db, ctx.tenantId, ctx.employeeId, permCode))) {
      // 用统一错误通道(core/http/errors.ts 映射 FORBIDDEN → 403)
      const err = new Error(`missing permission ${permCode}`) as Error & { code: string }
      err.code = 'FORBIDDEN'
      throw err
    }
    if (permCode.startsWith('finance:')) await assertAccountingEntityAccess(db, ctx, permCode)
    await next()
  }
}

/** 任一功能权限:适合页面入口与其只读依赖使用不同权限码的兼容场景。 */
export function requireAnyPermission(db: Db, permCodes: readonly string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = c.get('ctx')
    if (ctx.scopes) {
      if (!(ctx.scopes.includes('*') || permCodes.some((code) => ctx.scopes!.includes(code)))) {
        const err = new Error(`missing one of scopes ${permCodes.join(', ')}`) as Error & { code: string }
        err.code = 'FORBIDDEN'
        throw err
      }
      await next()
      return
    }
    const granted = await Promise.all(
      permCodes.map((code) => hasPermission(db, ctx.tenantId, ctx.employeeId, code)),
    )
    if (!granted.some(Boolean)) {
      const err = new Error(`missing one of permissions ${permCodes.join(', ')}`) as Error & { code: string }
      err.code = 'FORBIDDEN'
      throw err
    }
    await next()
  }
}
