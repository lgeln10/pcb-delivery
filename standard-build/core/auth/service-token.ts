// core/auth/service-token.ts
// 受限 svc_… API 令牌的签发/解析/列举/吊销。原文一次性返回，只存 sha256。
// 解析成功返回 { tenantId, employeeId, scopes }；中间件据此挂 ctx 并用 scopes 封顶权限。
//
// 安全约定（见 codex review）：
// - 令牌背靠一个真实 employee 以复用数据权限，但该员工必须是「最小权限的服务账号」：
//   签发时校验在职 + 拒绝背靠租户 owner / 超管（否则 requireAuth-only 路由会越权）。
// - 解析时复查背靠员工仍在职（离职/停用立即令牌失效，不等吊销）。
//
// 自助会话令牌(purpose='ai_session')是上面那条护栏的**正交例外**，不是放宽——见 mintServiceToken 内注释。
// core 内依赖方向 auth → org（与 login.ts 一致）。
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { decryptSecret, encryptSecret, isKeyStoreAvailable } from '../crypto/secret-box'
import { scope } from '../db/soft-delete'
import { employeeRoles, employees, permissions, roles, tenants } from '../org/model'
import { SUPERADMIN_ROLE_CODE } from '../org/logic/role'
import { serviceTokens, type ServiceTokenPurpose } from './model'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
// 生成器是 'svc_' + randomBytes(24).hex(48 个十六进制字符)。
const RAW_KEY_RE = /^svc_[0-9a-f]{48}$/

export type ServiceTokenContext = { tenantId: string; employeeId: string; scopes: string[] }

/** 背靠员工是否「特权」(租户 owner 或内置 superadmin 角色)。服务令牌禁止背靠这类账号。 */
async function isPrivileged(db: Db, tenantId: string, empId: string): Promise<boolean> {
  const t = await db
    .select({ owner: tenants.ownerEmployeeId })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.isDeleted, false)))
    .limit(1)
  if (t[0]?.owner === empId) return true
  const admin = await db
    .select({ roleId: roles.id })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(
      and(
        eq(employeeRoles.tenantId, tenantId),
        eq(employeeRoles.employeeId, empId),
        scope(roles, tenantId),
        eq(roles.isBuiltin, true),
        eq(roles.code, SUPERADMIN_ROLE_CODE),
      ),
    )
    .limit(1)
  return admin.length > 0
}

/** 背靠员工在该租户内是否在职(active 且未删除)。 */
async function backingEmployeeActive(db: Db, tenantId: string, empId: string): Promise<boolean> {
  const rows = await db
    .select({ status: employees.status })
    .from(employees)
    .where(and(eq(employees.id, empId), eq(employees.tenantId, tenantId), eq(employees.isDeleted, false)))
    .limit(1)
  return rows[0]?.status === 'active'
}

/**
 * 治理面模块:agent 永远不得取得这几个模块的权限,否则它能改账号、抹审计、自我增殖
 * (建更多数字员工),或者**改写自己的定义**(aiagent:改话术、换模型、放开工具白名单、
 * 摘掉审批标记 —— 等于自己给自己解除治理)。这是 `backingMayBePrivileged` 唯一放行的前提。
 */
export const GOVERNANCE_MODULES = ['org', 'audit', 'digitalemployee', 'aiagent'] as const

/** 某批权限码里属于治理面的那些(用于封顶校验)。 */
async function governanceCodesAmong(db: Db, codes: string[]): Promise<string[]> {
  if (codes.length === 0) return []
  const rows = await db
    .select({ code: permissions.code, module: permissions.module })
    .from(permissions)
    .where(inArray(permissions.code, codes))
  return rows.filter((r) => (GOVERNANCE_MODULES as readonly string[]).includes(r.module)).map((r) => r.code)
}

/**
 * 签发令牌。原文 `svc_…` 仅此一次返回(只持久化其 sha256)。背靠员工必须在职。
 *
 * 默认**拒绝**背靠 owner/超管:背靠超管又不封顶 = 一把全权钥匙,正是这套机制要消灭的东西。
 *
 * `backingMayBePrivileged` 是数字员工那条路径的正当例外 —— 数字员工归某个人所有,
 * 用主人的身份跑才符合「委托不得超过委托人」,而主人常常就是老板。但它**不是一个
 * 由调用方声称安全的开关**:开了这个标志,mint 会自己去验证那个让它安全的性质 ——
 * scopes 里不含任何治理面权限码。验不过照样抛。
 *
 * `selfService` 是唯一豁免 owner/超管护栏的路径,且必须**四条同时成立**才生效:
 * `selfService === true` + 背靠的就是调用者本人 + `purpose === 'ai_session'` + 带 `expiresAt`。
 * 任一不成立就退回原护栏(所以「背靠 owner 的普通令牌」照旧抛错,那条回归测试必须一直绿)。
 *
 * 为什么这不是放宽护栏:原护栏防的是**提权** —— 一枚背靠超管的**长期**令牌发给**低权限第三方**使用。
 * 自助会话令牌的权限 ≡ 调用者本人权限,一模一样,拿它做不到本人做不到的事,而且有到期时间。
 * 两者正交。若把这条豁免去掉,老板(通常正是 owner)一开 Ask AI 就抛错。
 */
export async function mintServiceToken(
  db: Db,
  ctx: Ctx,
  input: {
    name: string
    scopes: string[]
    employeeId?: string
    purpose?: ServiceTokenPurpose
    expiresAt?: Date
    /** 自助:背靠调用者本人的短期会话令牌。需同时满足四条才豁免 owner/超管护栏。 */
    selfService?: boolean
    /** 数字员工:背靠主人(常常就是老板)。放行前提由 mint 自己验 —— scopes 不含治理面。 */
    backingMayBePrivileged?: boolean
  },
): Promise<{ id: string; rawKey: string }> {
  const backing = input.employeeId ?? ctx.employeeId
  const purpose: ServiceTokenPurpose = input.purpose ?? 'manual'
  const selfService =
    input.selfService === true && backing === ctx.employeeId && purpose === 'ai_session' && !!input.expiresAt

  if (!(await backingEmployeeActive(db, ctx.tenantId, backing))) {
    throw new Error('服务令牌背靠的员工不存在或已离职')
  }
  // 背靠特权员工有两条正当豁免,前提不同,各自验各自的:
  //   selfService —— 权限 ≡ 调用者本人 + 短期,天然不提权(Ask AI 会话)
  //   backingMayBePrivileged —— 数字员工用主人身份跑,前提是这批 scopes 不含治理面
  if (!selfService && (await isPrivileged(db, ctx.tenantId, backing))) {
    if (!input.backingMayBePrivileged) {
      throw new Error('服务令牌必须背靠最小权限的服务账号，不能是租户 owner 或超管')
    }
    // 放行的前提不是调用方说了算,是这批 scopes 确实不含治理面。
    const governance = await governanceCodesAmong(db, input.scopes)
    if (governance.length > 0) {
      throw new Error(`背靠特权员工的服务令牌不得包含治理面权限:${governance.join('、')}`)
    }
  }
  const rawKey = 'svc_' + randomBytes(24).toString('hex')
  // 密文只给 ai_session 存(缓存要取回原文注入)。主密钥缺失时 fail-soft:不存密文,
  // 该枚令牌就是一次性的 —— 调用方据此不做缓存,见 getOrMintAiSessionToken。
  const secretEnc = purpose === 'ai_session' && isKeyStoreAvailable() ? encryptSecret(rawKey) : null
  const rows = await db
    .insert(serviceTokens)
    .values({
      tenantId: ctx.tenantId,
      employeeId: backing,
      name: input.name,
      tokenHash: sha256(rawKey),
      scopes: input.scopes,
      createdBy: ctx.employeeId,
      purpose,
      expiresAt: input.expiresAt ?? null,
      secretEnc,
    } as typeof serviceTokens.$inferInsert)
    .returning()
  return { id: rows[0]!.id, rawKey }
}

/** 解析原文 `svc_` → 上下文(未吊销 + 背靠员工仍在职才有效)。顺带最佳努力更新 last_used。 */
export async function resolveServiceToken(db: Db, rawKey: string): Promise<ServiceTokenContext | null> {
  if (!RAW_KEY_RE.test(rawKey)) return null
  const rows = await db
    .select()
    .from(serviceTokens)
    .where(and(eq(serviceTokens.tokenHash, sha256(rawKey)), isNull(serviceTokens.revokedAt), eq(serviceTokens.isDeleted, false)))
    .limit(1)
  const tok = rows[0]
  if (!tok) return null
  // 过期即失效(expires_at 为 NULL 表示永不过期 —— 存量令牌全是这种,行为不变)
  if (tok.expiresAt && tok.expiresAt.getTime() <= Date.now()) return null
  // 背靠员工离职/停用 → 令牌即时失效
  if (!(await backingEmployeeActive(db, tok.tenantId, tok.employeeId))) return null
  try {
    await db.update(serviceTokens).set({ lastUsedAt: new Date() } as Record<string, unknown>).where(eq(serviceTokens.id, tok.id))
  } catch {
    /* last-used 更新仅最佳努力 */
  }
  return { tenantId: tok.tenantId, employeeId: tok.employeeId, scopes: (tok.scopes as string[]) ?? [] }
}

/** Ask AI 会话令牌的 TTL。7 天:短到泄漏一周内自愈,长到活跃用户感觉不到每条消息都在铸令牌。 */
export const AI_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type AiSessionToken =
  | { rawKey: string; reused: boolean }
  /** 主密钥缺失 → 无法缓存原文。不签发、不注入,由 agent 的 instructions 把这件事说出来。 */
  | { rawKey: null; reason: 'KEY_STORE_UNAVAILABLE' }

/**
 * 取(或铸)调用者本人的 Ask AI 会话令牌 —— **每人一枚,缓存复用**。
 *
 * 为什么必须缓存而不是每次会话铸一枚:不缓存的话每条聊天消息都烧一枚令牌,`service_tokens` 表无界增长
 * (getdeployed `builder_token.go` 踩过并写在注释里)。缓存要求能**取回原文**注入给 agent,而 token_hash
 * 不可逆,所以另存 `secret_enc`(AES-256-GCM)。
 *
 * 轮换的三种触发:过期 / 密文取不回(主密钥换过、密文损坏)/ **本人权限变了**。
 * 最后一条不能省 —— 否则给某人加了 `finance:view`,他的 Ask AI 还要等最多 7 天才认。
 */
export async function getOrMintAiSessionToken(
  db: Db,
  ctx: Ctx,
  input: { scopes: string[]; name?: string },
): Promise<AiSessionToken> {
  if (!isKeyStoreAvailable()) return { rawKey: null, reason: 'KEY_STORE_UNAVAILABLE' }

  const rows = await db
    .select()
    .from(serviceTokens)
    .where(
      and(
        eq(serviceTokens.tenantId, ctx.tenantId),
        eq(serviceTokens.employeeId, ctx.employeeId),
        eq(serviceTokens.purpose, 'ai_session'),
        isNull(serviceTokens.revokedAt),
        eq(serviceTokens.isDeleted, false),
      ),
    )
    .limit(1)

  const cached = rows[0]
  if (cached) {
    const expired = !cached.expiresAt || cached.expiresAt.getTime() <= Date.now()
    const sameScopes = sameScopeSet((cached.scopes as string[]) ?? [], input.scopes)
    if (!expired && sameScopes && cached.secretEnc) {
      try {
        return { rawKey: decryptSecret(cached.secretEnc), reused: true }
      } catch {
        /* 密文取不回(主密钥换过/损坏)→ 落到下面轮换 */
      }
    }
    // 轮换:先吊销旧行 —— 部分唯一索引只排除已吊销/已软删的行,不先吊销就插不进去。
    await db
      .update(serviceTokens)
      .set({ revokedAt: new Date() } as Record<string, unknown>)
      .where(eq(serviceTokens.id, cached.id))
  }

  const { rawKey } = await mintServiceToken(db, ctx, {
    name: input.name ?? 'Ask AI 会话令牌',
    scopes: input.scopes,
    employeeId: ctx.employeeId,
    purpose: 'ai_session',
    expiresAt: new Date(Date.now() + AI_SESSION_TTL_MS),
    selfService: true,
  })
  return { rawKey, reused: false }
}

const sameScopeSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

/**
 * 管理台的令牌清单。**只列 manual** —— ai_session 是每人一枚的运行时机制,
 * 不是人工签发的凭据,列出来只会让这一页变成员工名册。
 */
export async function listServiceTokens(db: Db, ctx: Ctx) {
  const rows = await db
    .select()
    .from(serviceTokens)
    .where(
      and(
        eq(serviceTokens.tenantId, ctx.tenantId),
        eq(serviceTokens.isDeleted, false),
        eq(serviceTokens.purpose, 'manual'),
      ),
    )
    .orderBy(desc(serviceTokens.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: r.scopes as string[],
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
  }))
}

export async function revokeServiceToken(db: Db, ctx: Ctx, id: string): Promise<void> {
  await db
    .update(serviceTokens)
    .set({ revokedAt: new Date() } as Record<string, unknown>)
    .where(and(eq(serviceTokens.tenantId, ctx.tenantId), eq(serviceTokens.id, id), eq(serviceTokens.isDeleted, false)))
}
