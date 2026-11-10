// core/license/tests/license.test.ts
import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifyLicense, licenseStatus } from '../verify'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const BASE = { v: 1, licenseId: 'x', customer: 'ACME', seats: 10, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', graceDays: 7 }

function makeLicense(payloadObj: object, key = privateKey): string {
  const buf = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const sig = sign(null, buf, key)
  return `${buf.toString('base64url')}.${sig.toString('base64url')}`
}

describe('license 验签', () => {
  it('有效签名 → 解析出 payload', () => {
    const p = verifyLicense(makeLicense(BASE), PUB)
    expect(p?.customer).toBe('ACME')
    expect(p?.seats).toBe(10)
  })
  it('篡改 payload(改席位)→ 验签失败', () => {
    const sig = makeLicense(BASE).split('.')[1]!
    const forged = Buffer.from(JSON.stringify({ ...BASE, seats: 9999 }), 'utf8').toString('base64url') + '.' + sig
    expect(verifyLicense(forged, PUB)).toBeNull()
  })
  it('换公钥 → 验签失败', () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyLicense(makeLicense(BASE), other)).toBeNull()
  })
  it('格式错 → null', () => {
    expect(verifyLicense('garbage', PUB)).toBeNull()
    expect(verifyLicense('a.b.c', PUB)).toBeNull()
  })
})

describe('license 状态', () => {
  const p = verifyLicense(makeLicense(BASE), PUB)
  it('未到期 = active、可写、未超席位', () => {
    const s = licenseStatus(p, { now: new Date('2026-06-01'), seatsUsed: 5 })
    expect(s.state).toBe('active')
    expect(s.readOnly).toBe(false)
    expect(s.overSeat).toBe(false)
  })
  it('到期后宽限期内 = grace、仍可写', () => {
    const s = licenseStatus(p, { now: new Date('2027-01-03'), seatsUsed: 5 }) // 到期后2天 < 7天宽限
    expect(s.state).toBe('grace')
    expect(s.readOnly).toBe(false)
  })
  it('过宽限 = expired、只读', () => {
    const s = licenseStatus(p, { now: new Date('2027-01-15'), seatsUsed: 5 }) // 到期后14天 > 7天宽限
    expect(s.state).toBe('expired')
    expect(s.readOnly).toBe(true)
  })
  it('超席位 → overSeat', () => {
    const s = licenseStatus(p, { now: new Date('2026-06-01'), seatsUsed: 11 })
    expect(s.overSeat).toBe(true)
  })
  it('无 license → invalid、只读', () => {
    const s = licenseStatus(null, { now: new Date('2026-06-01'), seatsUsed: 0 })
    expect(s.valid).toBe(false)
    expect(s.state).toBe('invalid')
    expect(s.readOnly).toBe(true)
  })
})
