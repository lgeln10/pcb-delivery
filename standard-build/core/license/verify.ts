// core/license/verify.ts
// License 验签 + 解析 + 状态计算。Ed25519(Node 内置 crypto,无依赖)。
// license 字符串 = base64url(payload JSON) + "." + base64url(签名)。
// 公钥内嵌在应用里(客户改不了),私钥只在厂商侧签发。生产构建前把 EMBEDDED_PUBLIC_KEY 换成你的真公钥。
import { verify as cryptoVerify, createPublicKey } from 'node:crypto'

export type LicensePayload = {
  v: number
  licenseId: string
  customer: string
  seats: number // 最大席位(在职账号数上限)
  issuedAt: string // ISO
  expiresAt: string // ISO
  features?: string[]
  graceDays?: number // 到期后宽限天数(默认 7)
}

// 内嵌公钥:对应厂商 license 服务(license.sixamtech.ai)的私钥。客户改不了(改了签名即失效)。
// 换私钥/多套环境可用 LICENSE_PUBLIC_KEY 环境变量覆盖。
export const EMBEDDED_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9lz2YTORBv0OP5kR3SD8GJsaNuLK/JekbsbKkbAquEU=\n-----END PUBLIC KEY-----\n'

export function activePublicKey(): string {
  return process.env.LICENSE_PUBLIC_KEY || EMBEDDED_PUBLIC_KEY
}

/** 验签 + 解析。签名无效/格式错/字段缺 → null(视为无有效授权)。 */
export function verifyLicense(license: string, publicKeyPem = activePublicKey()): LicensePayload | null {
  const parts = license.trim().split('.')
  if (parts.length !== 2) return null
  let payloadBuf: Buffer
  let sig: Buffer
  try {
    payloadBuf = Buffer.from(parts[0]!, 'base64url')
    sig = Buffer.from(parts[1]!, 'base64url')
  } catch {
    return null
  }
  let ok = false
  try {
    ok = cryptoVerify(null, payloadBuf, createPublicKey(publicKeyPem), sig)
  } catch {
    return null
  }
  if (!ok) return null
  try {
    const p = JSON.parse(payloadBuf.toString('utf8')) as LicensePayload
    if (!p || typeof p.seats !== 'number' || !p.expiresAt || !p.customer) return null
    return p
  } catch {
    return null
  }
}

export type LicenseState = 'active' | 'grace' | 'expired' | 'invalid'
export type LicenseStatus = {
  valid: boolean // 签名是否有效
  state: LicenseState
  customer: string
  seats: number
  seatsUsed: number
  overSeat: boolean // 已超席位
  expiresAt: string | null
  daysLeft: number // 距到期天数(负=已过期)
  readOnly: boolean // true=写操作应被拦(过期超宽限)
}

const DAY = 86_400_000

/** 由 payload + 当前时间 + 已用席位,算出授权状态(供强制/展示用)。 */
export function licenseStatus(payload: LicensePayload | null, opts: { now: Date; seatsUsed: number }): LicenseStatus {
  if (!payload) {
    return { valid: false, state: 'invalid', customer: '', seats: 0, seatsUsed: opts.seatsUsed, overSeat: true, expiresAt: null, daysLeft: 0, readOnly: true }
  }
  const exp = new Date(payload.expiresAt).getTime()
  const now = opts.now.getTime()
  const graceMs = (payload.graceDays ?? 7) * DAY
  const daysLeft = Math.floor((exp - now) / DAY)
  let state: LicenseState = 'active'
  if (now > exp + graceMs) state = 'expired'
  else if (now > exp) state = 'grace'
  return {
    valid: true,
    state,
    customer: payload.customer,
    seats: payload.seats,
    seatsUsed: opts.seatsUsed,
    overSeat: opts.seatsUsed > payload.seats,
    expiresAt: payload.expiresAt,
    daysLeft,
    readOnly: state === 'expired', // 宽限期内仍可写(只提示);过宽限 → 只读
  }
}
