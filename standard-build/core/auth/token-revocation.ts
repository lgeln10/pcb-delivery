// core/auth/token-revocation.ts
// 登录令牌的吊销。core/auth/token.ts 是 HMAC 无状态的 —— 签发出去就收不回来;
// 这个文件是把「收回」补上的那一层。
//
// ★两个手柄,别混:
//
// | 手柄 | 作用范围 | 用在哪 |
// |---|---|---|
// | `employees.sessions_revoked_at` 水位 | 该员工**全部**令牌 | 改密码、疑似被盗、「退出所有设备」、离职回收 |
// | `revoked_tokens` 黑名单(按 jti) | **单枚**令牌 | 正常「退出登录」 |
//
// 为什么不是只做黑名单:令牌被 XSS 偷走时,**受害者并不知道被偷的那枚 jti 是什么**。
// 能止血的只有「把我名下的全部令牌作废」,所以水位才是主手柄,黑名单是补充。
//
// ★性能:两次查询都发生在鉴权热路径上,所以
//   - 水位那次是**零额外成本**的 —— ctxFromToken 本来就要查 employees 行复核在职状态,多取一列而已;
//   - 黑名单那次是新增的一次主键查找,与员工那次 `Promise.all` 并发发出,延迟≈不变。
import { and, eq, lt } from 'drizzle-orm'
import type { Db } from '../db/client'
import { revokedTokens } from './model'
import { employees } from '../org/model'
import { registerJob } from '../scheduler'
import type { TokenPayload } from './token'

/** 吊销原因。只用于排障与管理端展示,不参与判定。 */
export type RevokeReason = 'logout' | 'password_change' | 'admin' | 'suspected_compromise'

/**
 * 令牌是否已被单枚吊销。
 * ★老令牌(0198 之前签发)没有 jti —— 无从查起,直接返回 false 由水位那条兜。
 */
export async function isTokenRevoked(db: Db, payload: TokenPayload): Promise<boolean> {
  if (!payload.jti) return false
  const rows = await db.select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, payload.jti)).limit(1)
  return rows.length > 0
}

/**
 * 令牌签发时刻是否早于该员工的吊销水位。
 *
 * ★两边都是毫秒。曾经 iat 是秒、水位是毫秒,结果「退出所有设备之后立刻重新登录」
 *   拿到的新令牌被自己的水位判早 —— 用户被弹回登录页,再登再弹。**实测撞到过**,
 *   见 TokenPayload.iatMs 的注释。别把 iatMs 改回秒。
 *
 * ★老令牌没有 iatMs,当 0 处理:水位为 NULL(从没吊销过)时照常放行;
 *   一旦吊过一次,0 必然早于水位 → 老令牌全部失效。这正是我们要的方向。
 */
export function isBeforeRevocationWatermark(payload: TokenPayload, sessionsRevokedAt: Date | null): boolean {
  if (!sessionsRevokedAt) return false
  return (payload.iatMs ?? 0) < sessionsRevokedAt.getTime()
}

/** 吊销单枚令牌(退出登录)。幂等:同一枚重复吊销不报错。 */
export async function revokeToken(db: Db, payload: TokenPayload, reason: RevokeReason = 'logout'): Promise<void> {
  // 没有 jti 的老令牌吊销不了单枚。★不静默成功 —— 调用方(登出接口)据此改走「吊销全部」,
  //   否则用户点了退出、界面说成功、令牌其实还活着,那是最坏的一种失败。
  if (!payload.jti) throw new Error('TOKEN_WITHOUT_JTI')
  await db
    .insert(revokedTokens)
    .values({
      jti: payload.jti,
      tenantId: payload.tenantId,
      employeeId: payload.employeeId,
      expiresAt: new Date(payload.exp * 1000),
      reason,
    })
    .onConflictDoNothing()
}

/**
 * 抬高某员工的吊销水位 = 他名下**全部**令牌立即失效(含此刻正在用的那一枚)。
 *
 * ★水位取 now() 而不是调用方传时刻:传进来的时刻若比某枚令牌的 iatMs 早,那枚就漏网了。
 * ★调用之后签发的令牌一定晚于水位(两边同为毫秒),所以「吊销完立刻重新登录」是通的 ——
 *   这条不是理所当然的,秒级 iat 时它是坏的,见 isBeforeRevocationWatermark。
 */
export async function revokeAllSessions(db: Db, tenantId: string, employeeId: string): Promise<void> {
  await db
    .update(employees)
    .set({ sessionsRevokedAt: new Date() })
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
}

/**
 * 清理已过期的吊销记录。令牌自己都过期了,黑名单里那一行就没有意义。
 * ★这张表**必须**被清理:不清的话每次退出登录留一行,长期堆在鉴权热路径旁边。
 * 返回删除行数,便于调度日志。
 */
export async function purgeExpiredRevocations(db: Db, now = new Date()): Promise<number> {
  const deleted = await db.delete(revokedTokens).where(lt(revokedTokens.expiresAt, now)).returning({ jti: revokedTokens.jti })
  return deleted.length
}

/**
 * 注册清理任务。★不注册的话这张表只增不减 —— 「加了个表但没人管它」是这类设计最常见的下场,
 * 所以清理与建表在同一个文件里,读到一个就看得见另一个。
 * 每 6 小时一次:令牌 7 天有效,过期行多留几小时毫无影响,没必要跑得勤。
 */
export function registerTokenRevocationJobs(): void {
  registerJob({
    name: 'auth:purge-expired-revocations',
    intervalMs: 6 * 3600 * 1000,
    run: async (db) => {
      await purgeExpiredRevocations(db)
    },
  })
}
