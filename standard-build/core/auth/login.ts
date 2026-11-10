// core/auth/login.ts
// 登录 + Ctx 构造。登录身份在 org.employee 上(单层身份,决策2),auth 不建新表。
// core 内依赖方向:auth → org(读 employees/tenants 表)。org 仍是根,不依赖 auth。
//
// 安全约定:
// - 密码校验只走 bcrypt.compare,永不比对明文
// - INVALID_CREDENTIALS 不区分"账号不存在/密码错"(防枚举)
// - phone 租户内唯一非全局:同号存在于多租户时必须显式传 tenantId
// - ctxFromToken 每次复查员工在职 + 租户未停用(离职/停用立即失效,不等 token 过期)
import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { employees, tenants, type Employee } from '../org/model'
import { AuthError } from './errors'
import { resolveServiceToken } from './service-token'
import { signToken, verifyToken } from './token'
import { isBeforeRevocationWatermark, isTokenRevoked } from './token-revocation'

async function assertTenantActive(db: Db, tenantId: string): Promise<void> {
  const rows = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.isDeleted, false)))
    .limit(1)
  if (!rows[0] || rows[0].status !== 'active') {
    throw new AuthError('TENANT_SUSPENDED', 'tenant suspended or not found')
  }
}

export async function login(
  db: Db,
  input: { phone: string; password: string; tenantId?: string },
  opts: { secret: string; ttlSeconds?: number },
): Promise<{ token: string; employee: Employee }> {
  const conds = [eq(employees.phone, input.phone), eq(employees.isDeleted, false)]
  if (input.tenantId) conds.push(eq(employees.tenantId, input.tenantId))
  const candidates = await db
    .select()
    .from(employees)
    .where(and(...conds))
    .limit(2) // 只需知道是否多于一个

  if (candidates.length === 0) throw new AuthError('INVALID_CREDENTIALS', 'invalid phone or password')
  if (candidates.length > 1) throw new AuthError('AMBIGUOUS_TENANT', 'phone exists in multiple tenants, specify tenantId')

  const emp = candidates[0]!
  if (!emp.passwordHash) throw new AuthError('INVALID_CREDENTIALS', 'invalid phone or password') // 未开通登录
  const ok = await bcrypt.compare(input.password, emp.passwordHash)
  if (!ok) throw new AuthError('INVALID_CREDENTIALS', 'invalid phone or password')
  if (emp.status !== 'active') throw new AuthError('EMPLOYEE_NOT_ACTIVE', 'employee has left')
  await assertTenantActive(db, emp.tenantId)

  const token = signToken({ employeeId: emp.id, tenantId: emp.tenantId }, opts.secret, opts.ttlSeconds)
  return { token, employee: emp }
}

/**
 * 免密签发会话:调用方已用别的方式证明了身份(当前唯一用例=飞书内免登,凭飞书 OAuth 换到的
 * 用户身份查 im_user_bindings 命中员工)。★与 login() 共用同一套准入校验 —— 员工在职 + 租户启用,
 * 二者缺一不可,离职/停用的人不能从任何旁路进来。调用方自己负责「证明身份」那一步。
 */
export async function issueTokenForEmployee(
  db: Db,
  input: { employeeId: string; tenantId: string },
  opts: { secret: string; ttlSeconds?: number },
): Promise<{ token: string; employee: Employee }> {
  const rows = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, input.employeeId), eq(employees.tenantId, input.tenantId), eq(employees.isDeleted, false)))
    .limit(1)
  const emp = rows[0]
  if (!emp) throw new AuthError('INVALID_CREDENTIALS', 'employee not found')
  if (emp.status !== 'active') throw new AuthError('EMPLOYEE_NOT_ACTIVE', 'employee has left')
  await assertTenantActive(db, emp.tenantId)

  const token = signToken({ employeeId: emp.id, tenantId: emp.tenantId }, opts.secret, opts.ttlSeconds)
  return { token, employee: emp }
}

/** 从 token 构造 Ctx(HTTP 中间件用)。验签 + 复查员工/租户状态,任何一步不过 = 拒绝。 */
export async function ctxFromToken(db: Db, token: string, secret: string): Promise<Ctx> {
  // 服务令牌(svc_…)：非交互调用方(外部 agent/工具)。背靠真实员工以复用数据权限，
  // 但能做什么由 scopes 封顶(见 requirePermission)。无员工在职校验(令牌即身份，可吊销)。
  if (token.startsWith('svc_')) {
    const svc = await resolveServiceToken(db, token)
    if (!svc) throw new AuthError('TOKEN_INVALID', 'invalid service token')
    await assertTenantActive(db, svc.tenantId)
    return { tenantId: svc.tenantId, employeeId: svc.employeeId, scopes: svc.scopes }
  }
  const payload = verifyToken(token, secret)
  // ★两次查询并发发出:员工行那次本来就要做(复核在职),黑名单那次是新增的一次主键查找。
  //   串行会让每个请求多一个 RTT;并发下总延迟≈不变。
  const [rows, revoked] = await Promise.all([
    db
      .select({ status: employees.status, sessionsRevokedAt: employees.sessionsRevokedAt })
      .from(employees)
      .where(
        and(
          eq(employees.id, payload.employeeId),
          eq(employees.tenantId, payload.tenantId), // ★租户隔离:token 内 tenantId 必须与员工一致
          eq(employees.isDeleted, false),
        ),
      )
      .limit(1),
    isTokenRevoked(db, payload),
  ])
  if (!rows[0] || rows[0].status !== 'active') {
    throw new AuthError('EMPLOYEE_NOT_ACTIVE', 'employee not active')
  }
  // ★吊销判定放在「员工在职」之后、「租户启用」之前,顺序无所谓 —— 三者都是拒绝条件。
  //   两条都回 TOKEN_EXPIRED 而不是新错误码:前端见到它就清 localStorage 跳登录页,
  //   这正是被吊销后该有的行为;新造一个码等于要求所有客户端同步升级。
  if (revoked || isBeforeRevocationWatermark(payload, rows[0].sessionsRevokedAt ?? null)) {
    throw new AuthError('TOKEN_EXPIRED', 'token revoked')
  }
  await assertTenantActive(db, payload.tenantId)
  return { tenantId: payload.tenantId, employeeId: payload.employeeId }
}
