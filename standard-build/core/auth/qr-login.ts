// core/auth/qr-login.ts
// PC 端扫码授权手机登录:已登录的电脑出示一张动态二维码,App 扫码 → 电脑上确认 → 手机拿到
// 一枚 90 天的登录令牌。表见迁移 0301,列注释在 core/auth/model.ts。
//
// ── 方向与既有「扫码」不是一回事 ──────────────────────────────────────────────
// 微信那种扫码登录是「手机是可信的认证器,给不可信的网页发会话」。这里是**反过来**的:
// 已经登录的 PC 是可信方,把自己的身份授予一台新手机。所以真正的威胁不是钓鱼网站,而是
// **别人看到了你的屏幕** —— 拍照、投屏、录屏、会议共享。四条闸都是冲这个来的:
//
//   ① 二维码里没有任何凭据,只有一张一次性票(256 bit 随机),票本身什么也不是;
//   ② 票 2 分钟就死,PC 前端还会更早地换新的(见 QR_TICKET_TTL_MS);
//   ③ **扫到之后必须回 PC 上按一次「确认」**,PC 上会显示是哪台设备在扫 ——
//      拍屏的人扫了,跳出确认框的是你,你点拒绝就完了;
//   ④ 一次性:consumed_at 从 NULL 只变一次,并发兑换只有一个赢家。
//
// ★③ 是这套东西的**主闸**。去掉它,一张被拍下的二维码在有效期内等于账号本身。
//    需求方 2026-08-25 明确选了「要确认」。
//
// ── 为什么不复用 service_tokens ──────────────────────────────────────────────
// 那套是给非交互调用方的受限令牌(scopes 封顶、背靠员工)。这里要的是**完整的本人身份**,
// 走的就是普通登录令牌(issueTokenForEmployee),只是 ttl 长。共用一套鉴权、一套吊销。
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { employees } from '../org/model'
import { AuthError } from './errors'
import { issueTokenForEmployee } from './login'
import { loginDevices, qrLoginTickets, QR_LOGIN_STATUS, type QrLoginStatus } from './model'
import { registerJob } from '../scheduler'
import { verifyToken } from './token'
import { revokeToken } from './token-revocation'

/** 二维码有效期。PC 前端应在此之前就换新码(见 QR_ROTATE_MS)。 */
export const QR_TICKET_TTL_MS = 120_000
/** PC 前端换码周期。**必须小于 TTL** —— 相等的话总有一瞬间手里那张已经死了。 */
export const QR_ROTATE_MS = 90_000
/**
 * 扫到之后留给「回 PC 点确认」的时间。
 * ★不能沿用原来的 expires_at:人在 118 秒时扫到码,只剩 2 秒去点确认 —— 那就是个必然失败的设计。
 *   所以扫码时把死线**顺延**到 now + 这个值。
 */
export const QR_CONFIRM_WINDOW_MS = 90_000
/** 扫码签发的登录令牌有效期:3 个月(需求方 2026-08-25 指定)。 */
export const QR_TOKEN_TTL_SECONDS = 90 * 24 * 3600

/** 手机自报的机型串最长留这么多字符。**不可信输入**,只用于给人看。 */
const DEVICE_LABEL_MAX = 80

export type ScanDevice = { label?: string | null; platform?: string | null; appVersion?: string | null }

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * 明文票 → 库里的主键。★库里只存这个哈希 ——
 * 明文只在二维码里和手机内存中出现过,备份/只读从库/日志被读到都不足以冒充任何人。
 */
export function ticketHashOf(ticket: string): string {
  return sha256(ticket)
}

/** 机型串净化:截断 + 去掉控制字符。这串会显示在 PC 的确认框里,不能让它带换行去伪造上下文。 */
export function sanitizeDeviceLabel(raw: string | null | undefined, fallback = '未知设备'): string {
  const s = (raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  if (!s) return fallback
  return s.length > DEVICE_LABEL_MAX ? s.slice(0, DEVICE_LABEL_MAX) + '…' : s
}

// ── 公开端点的限流(内存级,进程重启即清)──────────────────────────────────────
// ★票是 256 bit 随机的,穷举不是威胁 —— 这个闸挡的是「拿公开端点当放大器打库」。
//   与官网公开写口、登录退避同款约束:单实例部署成立,多实例要挪到共享存储。
const RATE_WINDOW_MS = 60_000
const rateBuckets = new Map<string, number[]>()

export function checkQrRate(key: string, maxPerMinute: number, now = Date.now()): void {
  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (hits.length >= maxPerMinute) throw new AuthError('TOO_MANY_ATTEMPTS', '操作过于频繁,请稍后再试')
  hits.push(now)
  rateBuckets.set(key, hits)
  if (rateBuckets.size > 10_000) {
    for (const [k, v] of rateBuckets) if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateBuckets.delete(k)
  }
}

/** 仅测试用:清空限流桶。进程内状态跨用例会串味。 */
export function _resetQrRateLimit(): void {
  rateBuckets.clear()
}

// ── PC 侧(已鉴权)────────────────────────────────────────────────────────────

/** 出一张新票。返回的 `ticket` 是**唯一一次**能拿到明文的机会。 */
export async function createQrTicket(
  db: Db,
  who: { tenantId: string; employeeId: string },
  opts: { ip?: string | null; now?: Date } = {},
): Promise<{ ticket: string; expiresAt: Date; rotateAfterMs: number }> {
  const now = opts.now ?? new Date()
  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + QR_TICKET_TTL_MS)
  await db.insert(qrLoginTickets).values({
    ticketHash: ticketHashOf(ticket),
    tenantId: who.tenantId,
    employeeId: who.employeeId,
    status: 'pending',
    expiresAt,
    createdAt: now,
    createdIp: opts.ip ?? null,
  })
  return { ticket, expiresAt, rotateAfterMs: QR_ROTATE_MS }
}

export type TicketView = {
  status: QrLoginStatus | 'expired'
  expiresAt: Date
  device: { label: string; platform: string; ip: string | null; scannedAt: Date } | null
}

/**
 * PC 轮询自己那张票。
 * ★必须带上 who 并进 WHERE —— 少了它,任何登录用户都能读别人的票状态(以及扫码设备的 IP)。
 */
export async function readQrTicket(
  db: Db,
  ticket: string,
  who: { tenantId: string; employeeId: string },
  now = new Date(),
): Promise<TicketView | null> {
  const rows = await db
    .select()
    .from(qrLoginTickets)
    .where(
      and(
        eq(qrLoginTickets.ticketHash, ticketHashOf(ticket)),
        eq(qrLoginTickets.tenantId, who.tenantId),
        eq(qrLoginTickets.employeeId, who.employeeId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const expired = row.expiresAt.getTime() <= now.getTime() && row.status !== 'consumed'
  return {
    status: expired ? 'expired' : row.status,
    expiresAt: row.expiresAt,
    device:
      row.scannedAt && row.deviceLabel
        ? { label: row.deviceLabel, platform: row.platform ?? 'unknown', ip: row.scanIp, scannedAt: row.scannedAt }
        : null,
  }
}

/**
 * PC 上点「确认 / 拒绝」。
 * ★只允许从 `scanned` 迁移 —— 没人扫过就没什么可确认的,而「先批准、再等人来扫」
 *   等于把确认闸整个作废(谁抢到那张码谁登录)。这条 WHERE 就是那道闸。
 */
export async function decideQrTicket(
  db: Db,
  ticket: string,
  who: { tenantId: string; employeeId: string },
  approve: boolean,
  now = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(qrLoginTickets)
    .set({ status: approve ? 'approved' : 'rejected', decidedAt: now })
    .where(
      and(
        eq(qrLoginTickets.ticketHash, ticketHashOf(ticket)),
        eq(qrLoginTickets.tenantId, who.tenantId),
        eq(qrLoginTickets.employeeId, who.employeeId),
        eq(qrLoginTickets.status, 'scanned'),
        sql`${qrLoginTickets.expiresAt} > ${now}`,
      ),
    )
    .returning({ h: qrLoginTickets.ticketHash })
  return updated.length > 0
}

// ── 手机侧(公开)──────────────────────────────────────────────────────────────

export type ScanResult = { loginAs: string; expiresAt: Date }

/**
 * 手机扫到码。写入机型并把死线顺延,好让人有时间回 PC 点确认。
 *
 * ★返回**要登录成什么身份**(姓名)让手机显示出来 —— 这是手机端唯一能看见的语义,
 *   扫错码/扫到别人的码时人在这一步就能发现。姓名不算敏感面:能拿到这张票的人,
 *   本来就正站在那块屏幕前。
 * ★不存在的票和已过期的票回**同一个错误** —— 分开回等于给了一个「这串是不是有效票」的探针。
 */
export async function scanQrTicket(
  db: Db,
  ticket: string,
  device: ScanDevice,
  opts: { ip?: string | null; now?: Date } = {},
): Promise<ScanResult> {
  const now = opts.now ?? new Date()
  const newDeadline = new Date(now.getTime() + QR_CONFIRM_WINDOW_MS)
  const updated = await db
    .update(qrLoginTickets)
    .set({
      status: 'scanned',
      scannedAt: now,
      deviceLabel: sanitizeDeviceLabel(device.label),
      platform: sanitizeDeviceLabel(device.platform, 'unknown'),
      appVersion: device.appVersion ? sanitizeDeviceLabel(device.appVersion, '') : null,
      scanIp: opts.ip ?? null,
      expiresAt: newDeadline,
    })
    .where(
      and(
        eq(qrLoginTickets.ticketHash, ticketHashOf(ticket)),
        // 只有 pending / scanned 能再扫(重扫同一张码是常见的手滑,不该报错)
        sql`${qrLoginTickets.status} in ('pending','scanned')`,
        isNull(qrLoginTickets.consumedAt),
        sql`${qrLoginTickets.expiresAt} > ${now}`,
      ),
    )
    .returning({ tenantId: qrLoginTickets.tenantId, employeeId: qrLoginTickets.employeeId })
  const row = updated[0]
  if (!row) throw new AuthError('QR_TICKET_INVALID', '二维码无效或已过期,请在电脑上刷新后重新扫码')

  const emp = await db
    .select({ name: employees.name })
    .from(employees)
    .where(and(eq(employees.id, row.employeeId), eq(employees.tenantId, row.tenantId), eq(employees.isDeleted, false)))
    .limit(1)
  return { loginAs: emp[0]?.name ?? '', expiresAt: newDeadline }
}

export type RedeemResult =
  | { status: 'pending' | 'scanned' | 'rejected' | 'expired' }
  | { status: 'approved'; token: string; employee: { id: string; name: string; tenantId: string; phone: string } }

/**
 * 手机轮询兑换。没批准就如实回状态(手机据此显示「请在电脑上确认」),批准了就当场签令牌。
 *
 * ★一次性由**这一条 UPDATE 自己**保证:`consumed_at IS NULL` 进 WHERE,RETURNING 有行才算赢。
 *   先 SELECT 判断再 UPDATE 的写法在并发下会双发 —— 那意味着一张码换出两枚 90 天令牌。
 * ★签令牌走 issueTokenForEmployee,与密码登录**同一套准入**(在职 + 租户启用)。
 *   离职的人即使 PC 那边还开着确认框也进不来。
 */
export async function redeemQrTicket(
  db: Db,
  ticket: string,
  secret: string,
  opts: { ip?: string | null; now?: Date } = {},
): Promise<RedeemResult> {
  const now = opts.now ?? new Date()
  const hash = ticketHashOf(ticket)

  const claimed = await db
    .update(qrLoginTickets)
    .set({ status: 'consumed', consumedAt: now })
    .where(
      and(
        eq(qrLoginTickets.ticketHash, hash),
        eq(qrLoginTickets.status, 'approved'),
        isNull(qrLoginTickets.consumedAt),
        sql`${qrLoginTickets.expiresAt} > ${now}`,
      ),
    )
    .returning({
      tenantId: qrLoginTickets.tenantId,
      employeeId: qrLoginTickets.employeeId,
      label: qrLoginTickets.deviceLabel,
      platform: qrLoginTickets.platform,
      appVersion: qrLoginTickets.appVersion,
    })

  if (!claimed[0]) {
    // 没抢到:要么还没批准,要么已经被兑换过/被拒/过期。回当前状态给手机显示。
    const rows = await db
      .select({ status: qrLoginTickets.status, expiresAt: qrLoginTickets.expiresAt, consumedAt: qrLoginTickets.consumedAt })
      .from(qrLoginTickets)
      .where(eq(qrLoginTickets.ticketHash, hash))
      .limit(1)
    const row = rows[0]
    if (!row) throw new AuthError('QR_TICKET_INVALID', '二维码无效或已过期,请在电脑上刷新后重新扫码')
    if (row.status === 'rejected') return { status: 'rejected' }
    if (row.consumedAt) throw new AuthError('QR_TICKET_INVALID', '这张二维码已经用过了,请在电脑上刷新后重新扫码')
    if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired' }
    return { status: row.status === 'scanned' ? 'scanned' : 'pending' }
  }

  const row = claimed[0]
  const { token, employee } = await issueTokenForEmployee(
    db,
    { employeeId: row.employeeId, tenantId: row.tenantId },
    { secret, ttlSeconds: QR_TOKEN_TTL_SECONDS },
  )

  // 记台账。★jti 从签好的令牌里读回来,而不是让 signToken 多返回一个值 ——
  //   台账与令牌里的那一枚必须是同一个,读回来是最难写错的做法。
  const jti = verifyToken(token, secret).jti
  if (jti) {
    await db.insert(loginDevices).values({
      jti,
      tenantId: row.tenantId,
      employeeId: row.employeeId,
      label: sanitizeDeviceLabel(row.label),
      platform: row.platform ?? 'unknown',
      appVersion: row.appVersion,
      source: 'qr',
      ip: opts.ip ?? null,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + QR_TOKEN_TTL_SECONDS * 1000),
    }).onConflictDoNothing()
  }

  return {
    status: 'approved',
    token,
    employee: { id: employee.id, name: employee.name, tenantId: employee.tenantId, phone: employee.phone },
  }
}

// ── 设备台账 ─────────────────────────────────────────────────────────────────

export type DeviceRow = {
  jti: string
  label: string
  platform: string
  appVersion: string | null
  issuedAt: Date
  expiresAt: Date
  revokedAt: Date | null
  current: boolean
}

/** 本人名下还活着的登录设备(已过期的不列 —— 列出来只会让人以为还得去下线它)。 */
export async function listLoginDevices(
  db: Db,
  who: { tenantId: string; employeeId: string },
  currentJti: string | null,
  now = new Date(),
): Promise<DeviceRow[]> {
  const rows = await db
    .select()
    .from(loginDevices)
    .where(
      and(
        eq(loginDevices.tenantId, who.tenantId),
        eq(loginDevices.employeeId, who.employeeId),
        isNull(loginDevices.revokedAt),
        sql`${loginDevices.expiresAt} > ${now}`,
      ),
    )
  return rows
    .map((r) => ({
      jti: r.jti,
      label: r.label,
      platform: r.platform,
      appVersion: r.appVersion,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      current: currentJti !== null && r.jti === currentJti,
    }))
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())
}

/**
 * 下线一台设备 = 把它那枚 jti 写进 revoked_tokens(既有的单枚吊销黑名单)+ 标记台账。
 * ★顺序:先吊销再标记。反过来的话,标记成功而吊销失败时台账说「已下线」、令牌其实还活着 ——
 *   那是最坏的一种失败(界面告诉你安全了,而它不安全)。
 */
export async function revokeLoginDevice(
  db: Db,
  jti: string,
  who: { tenantId: string; employeeId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .select()
    .from(loginDevices)
    .where(and(eq(loginDevices.jti, jti), eq(loginDevices.tenantId, who.tenantId), eq(loginDevices.employeeId, who.employeeId)))
    .limit(1)
  const row = rows[0]
  if (!row) return false
  await revokeToken(
    db,
    { employeeId: row.employeeId, tenantId: row.tenantId, exp: Math.floor(row.expiresAt.getTime() / 1000), jti },
    'admin',
  )
  await db.update(loginDevices).set({ revokedAt: now }).where(eq(loginDevices.jti, jti))
  return true
}

// ── 清理 ─────────────────────────────────────────────────────────────────────

/** 过期票 / 过期设备行都没有意义了。**不清的话这两张表只增不减**(见 model.ts 的注释)。 */
export async function purgeExpiredQrData(db: Db, now = new Date()): Promise<{ tickets: number; devices: number }> {
  const t = await db.delete(qrLoginTickets).where(lt(qrLoginTickets.expiresAt, new Date(now.getTime() - 3600_000))).returning({ h: qrLoginTickets.ticketHash })
  const d = await db.delete(loginDevices).where(lt(loginDevices.expiresAt, now)).returning({ j: loginDevices.jti })
  return { tickets: t.length, devices: d.length }
}

export function registerQrLoginJobs(): void {
  registerJob({
    name: 'auth:purge-qr-login',
    intervalMs: 3600 * 1000,
    run: async (db) => {
      await purgeExpiredQrData(db)
    },
  })
}

/** 仅供护栏测试:导出状态枚举,和迁移里的 CHECK 比对。 */
export { QR_LOGIN_STATUS }
