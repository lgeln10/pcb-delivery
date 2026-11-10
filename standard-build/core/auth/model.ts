// core/auth/model.ts
// 服务令牌(svc_…)：给非交互调用方(外部 agent/工具，如 getdeployed agent 反向回调)的受限 API token。
// 只存 token 的 sha256(原文一次性返回，绝不入库)；scopes 是权限码白名单(或 ['*'])。
// 解析后挂在 ctx.scopes，由 requirePermission 封顶（见 core/http/middleware.ts）。
// 令牌背靠一个真实 employee(employeeId)以复用数据权限(getDataScope 按该员工算范围)，
// 但能做什么由 scopes 封顶——即使背靠超管，越出 scopes 的操作一律 403。
import { and, eq, isNull, sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { commonFields } from '../db/common-fields'

/** 令牌用途。`ai_session` 是 Ask AI 的自助会话令牌(背靠调用者本人、有期限、密文可取回)。 */
export type ServiceTokenPurpose = 'manual' | 'ai_session'

export const serviceTokens = pgTable('service_tokens', {
  ...commonFields,
  // 背靠的真实员工 id：决定数据权限范围(getDataScope)。
  // ⚠️ 不是 owner/超管 —— mintServiceToken 明确拒绝背靠这两类(见 service-token.ts 的 isPrivileged)。
  // 唯一例外是 purpose='ai_session' 的自助令牌:它背靠调用者本人,权限≡本人,且必须带 expiresAt。
  employeeId: uuid('employee_id').notNull(),
  name: text('name').notNull(),
  // token 的 sha256 十六进制(O(1) 查找)。原文只返回一次。
  tokenHash: text('token_hash').notNull(),
  // 权限码白名单(或 ['*'])。
  scopes: jsonb('scopes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // NULL = 永不过期(存量令牌行为不变);非 NULL 且已过 → resolveServiceToken 返回 null。
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // 仅 ai_session 写:原文的 AES-256-GCM 密文(core/crypto/secret-box)。
  // 缓存必须能**取回原文**注入给 agent,而 token_hash 不可逆,所以另存一列。明文绝不入库。
  secretEnc: text('secret_enc'),
  purpose: text('purpose').$type<ServiceTokenPurpose>().notNull().default('manual'),
}, (t) => [
  uniqueIndex('service_tokens_hash_uq').on(t.tokenHash),
  index('service_tokens_tenant_idx').on(t.tenantId),
  // 每员工最多一枚「活」的 ai_session 令牌(未软删 + 未吊销)。轮换 = 吊销旧行 + 插新行。
  // 过期的行不参与该约束的排除条件(过期判定在读取时做),否则索引谓词会依赖 now() 而不可用。
  uniqueIndex('service_tokens_ai_session_uq')
    .on(t.tenantId, t.employeeId)
    .where(and(eq(t.purpose, 'ai_session'), isNull(t.revokedAt), eq(t.isDeleted, false))!),
])

/**
 * 被单枚吊销的登录令牌(黑名单)。见迁移 0198。
 *
 * ★与 employees.sessions_revoked_at 分工:那个是「该员工全部令牌一次作废」(改密码/疑似被盗),
 *   这张表是「只作废这一枚」—— 正常「退出登录」只该让当前这台设备失效,不该把手机也踢下线。
 *
 * ★刻意不带 commonFields:这是运维型表,不是业务实体。
 *   - **没有软删** —— 吊销记录被软删就等于没吊销,那是安全洞不是数据洁癖;
 *   - jti 是全局主键、不按租户分区 —— 校验发生在解析出租户**之前**;
 *   - 必须可清理:expires_at 过了就没意义,否则每次退出登录留一行,长期堆在鉴权热路径旁边。
 */
export const revokedTokens = pgTable('revoked_tokens', {
  jti: text('jti').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  /** 被吊销令牌自身的过期时刻(= payload.exp)。到点即可清理本行。 */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason').notNull().default('logout'),
}, (t) => [
  index('revoked_tokens_expires_idx').on(t.expiresAt),
  index('revoked_tokens_employee_idx').on(t.tenantId, t.employeeId),
])

// ── PC 扫码授权手机登录 ───────────────────────────────────────────────────────
// 见迁移 0301。领域逻辑在 core/auth/qr-login.ts,那里有完整的威胁模型说明。

/**
 * 票据状态。★与迁移 0301 的 CHECK 约束同源 —— 加值必须同时改这里、改 CHECK、写一条迁移。
 * 只改一边的表现是:类型全绿、测试全绿,只有真库那一次写入炸(本仓踩过,见 model.ts 的
 * status-convention 注释与 hotel 的 worklog)。`qr-login.test.ts` 有一条比对两边的断言。
 */
export const QR_LOGIN_STATUS = ['pending', 'scanned', 'approved', 'rejected', 'consumed'] as const
export type QrLoginStatus = (typeof QR_LOGIN_STATUS)[number]

/**
 * 扫码登录票据。**存 sha256(明文票),不存明文** —— 明文只出现在二维码里和手机内存中。
 *
 * ★刻意不带 commonFields(同 revokedTokens):没有软删(软删一条已作废的票 = 它又活了),
 *   且必须可清理 —— 票 60 秒就死,不清的话这张表只增不减。
 */
export const qrLoginTickets = pgTable('qr_login_tickets', {
  ticketHash: text('ticket_hash').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  status: text('status').$type<QrLoginStatus>().notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdIp: text('created_ip'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  /** 手机自报的机型/系统。★不可信输入,只用于给人看,长度在服务端截断(sanitizeDeviceLabel)。 */
  deviceLabel: text('device_label'),
  platform: text('platform'),
  appVersion: text('app_version'),
  scanIp: text('scan_ip'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** 一次性的判据。用这一列而不是 status —— 状态可能被并发写覆盖,这一列只从 NULL 变一次。 */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [
  index('qr_login_tickets_expires_idx').on(t.expiresAt),
  index('qr_login_tickets_employee_idx').on(t.tenantId, t.employeeId),
])

/**
 * 已签发的长效登录令牌台账(「我的登录设备」)。主键就是令牌的 jti。
 *
 * ★为什么必须有:扫码授的是 90 天的登录态,而在此之前**唯一**的吊销手段是
 *   `revoke-all`(抬水位),它会把本人 PC 上这一份也一起作废。手机丢了却要把自己
 *   也踢下线,人就不会去用它 —— 于是那 90 天实际上收不回来。
 *   下线一台 = 把它的 jti 写进 revokedTokens(既有黑名单),这张表只负责「有哪些」。
 */
export const loginDevices = pgTable('login_devices', {
  jti: text('jti').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  label: text('label').notNull(),
  platform: text('platform').notNull().default('unknown'),
  appVersion: text('app_version'),
  source: text('source').notNull().default('qr'),
  ip: text('ip'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  index('login_devices_employee_idx').on(t.tenantId, t.employeeId),
  index('login_devices_expires_idx').on(t.expiresAt),
])
