// core/license/state.ts
// 运行时授权状态:加载 LICENSE_KEY(env)→ 验签缓存 → 算状态;席位统计 + 强制判定。
// ★安全闸:只有设置了 LICENSE_KEY 才启用强制。未设(demo/dev/内部)→ 完全不强制、无行为变化。
import { sql } from 'drizzle-orm'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Ctx, Db } from '../db/client'
import { employees } from '../org/model'
import { verifyLicense, licenseStatus, type LicensePayload, type LicenseStatus } from './verify'
import { readHeartbeatState } from './hbstore'

const HB_GRACE_DAYS = 14 // 配了心跳却连续这么多天 check-in 不上 → 视为过期

// 授权来源:优先环境变量 LICENSE_KEY;否则读「界面上传并落盘」的授权文件(持久化在 uploads 卷)。
function licenseFile(): string {
  return process.env.LICENSE_FILE || `${process.env.UPLOAD_DIR || 'uploads'}/.license.json`
}
function readStored(): { license: string; server?: string } | null {
  try {
    return JSON.parse(readFileSync(licenseFile(), 'utf8'))
  } catch {
    return null
  }
}
function rawLicense(): string | null {
  return process.env.LICENSE_KEY || readStored()?.license || null
}
/** 心跳服务地址:环境变量优先,否则取上传授权文件里带的 server。 */
export function licenseServerUrl(): string | null {
  return process.env.LICENSE_SERVER_URL || readStored()?.server || null
}
/** 是否已配置授权源(env 或上传文件)。 */
export function hasLicenseSource(): boolean {
  return !!rawLicense()
}

let cached: LicensePayload | null | undefined // undefined = 尚未加载

/**
 * 是否启用授权强制。客户镜像设 LICENSE_REQUIRED=true → 一律强制(未激活则只读 + 提示上传);
 * 或已有授权源(env/上传)也强制。demo/dev 两者皆无 → 不强制。
 */
export function licenseEnforced(): boolean {
  return process.env.LICENSE_REQUIRED === 'true' || hasLicenseSource()
}

/**
 * 是否拥有某项按需采购的功能(如 'ai' = 企业智能体板块)。
 * 不强制(demo/dev/内部)→ 全开;强制且已激活 → 看 license 的 features 清单;强制未激活 → 关。
 */
export function licenseHasFeature(feature: string): boolean {
  if (!licenseEnforced()) return true
  const p = loadLicense()
  return !!p && Array.isArray(p.features) && p.features.includes(feature)
}

/** 加载并验签授权(env 或上传文件,缓存)。未配/无效 → null。 */
export function loadLicense(): LicensePayload | null {
  if (cached !== undefined) return cached
  const raw = rawLicense()
  cached = raw ? verifyLicense(raw) : null
  return cached
}

/** 界面上传授权文件激活:验签 → 落盘持久化 → 清缓存。无效则抛 INVALID_INPUT。 */
export function activateLicense(input: { license: string; server?: string }): void {
  const license = (input.license || '').trim()
  if (!verifyLicense(license)) {
    throw Object.assign(new Error('授权文件无效或签名不匹配'), { code: 'INVALID_INPUT' })
  }
  writeFileSync(licenseFile(), JSON.stringify({ license, server: (input.server || licenseServerUrl() || '').trim() }))
  __resetLicenseCache()
}

/** 测试用:重置缓存(改了 env 后重新加载)。 */
export function __resetLicenseCache(): void {
  cached = undefined
}

/** 折叠心跳:服务器权威到期日覆盖本地(远程续期/缩短,无需重新部署)。 */
function effectivePayload(): LicensePayload | null {
  const p = loadLicense()
  if (!p) return null
  const hb = readHeartbeatState()
  return hb?.serverExpiresAt ? { ...p, expiresAt: hb.serverExpiresAt } : p
}

/** 配了心跳服务时:远程吊销 或 长期 check-in 不上 → 强制过期(防离线绕过/断网续用)。 */
function heartbeatForcesExpired(): boolean {
  if (!licenseServerUrl()) return false
  const hb = readHeartbeatState()
  if (hb?.revoked) return true
  const last = hb?.lastOkAt ? new Date(hb.lastOkAt).getTime() : 0
  return Date.now() - last > HB_GRACE_DAYS * 86_400_000
}

/** 在职账号数(占席位的口径:active 且未删除)。 */
export async function countActiveSeats(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(employees)
    .where(sql`${employees.status} = 'active' and ${employees.isDeleted} = false`)
  return rows[0]?.n ?? 0
}

/** 当前授权状态(含席位使用 + 心跳折叠)。 */
export async function getLicenseStatus(db: Db): Promise<LicenseStatus> {
  const seatsUsed = await countActiveSeats(db)
  const st = licenseStatus(effectivePayload(), { now: new Date(), seatsUsed })
  return heartbeatForcesExpired() ? { ...st, state: 'expired', readOnly: true } : st
}

/** 写操作是否应被拦(启用强制 且 过宽限只读/被远程吊销/长期失联)。不查库,便于放进热路径中间件。 */
export function isWriteBlocked(): boolean {
  if (!licenseEnforced()) return false
  if (heartbeatForcesExpired()) return true
  return licenseStatus(effectivePayload(), { now: new Date(), seatsUsed: 0 }).readOnly
}

/** 建账号前校验席位:启用强制且已达上限 → 抛错(调用方 core/org 捕获为业务错误)。 */
export async function assertSeatAvailable(db: Db): Promise<void> {
  if (!licenseEnforced()) return
  const lic = loadLicense()
  if (!lic) {
    const err = new Error('授权无效，无法新增账号') as Error & { code: string }
    err.code = 'LICENSE_INVALID'
    throw err
  }
  const used = await countActiveSeats(db)
  if (used >= lic.seats) {
    const err = new Error(`已达授权席位上限（${lic.seats} 个），请联系升级授权`) as Error & { code: string }
    err.code = 'LICENSE_SEAT_LIMIT'
    throw err
  }
}
