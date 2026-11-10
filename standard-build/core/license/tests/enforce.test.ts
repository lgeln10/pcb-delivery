// core/license/tests/enforce.test.ts — 授权强制:未配则无感,配了则席位/到期生效。
import { afterEach, describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { createOrgTestDb, seedTenant } from '../../org/tests/helpers'
import { licenseEnforced, assertSeatAvailable, isWriteBlocked, countActiveSeats, __resetLicenseCache, activateLicense, hasLicenseSource, loadLicense, licenseHasFeature } from '../state'

const HB_FILE = '/tmp/aios-test-hb.json'
const LIC_FILE = '/tmp/aios-test-license.json'
process.env.LICENSE_FILE = LIC_FILE // 隔离上传授权文件路径,避免读到仓库里的真实文件
function setHb(obj: object) {
  process.env.LICENSE_STATE_FILE = HB_FILE
  writeFileSync(HB_FILE, JSON.stringify(obj))
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function mkLicense(seats: number, expiresAt: string): string {
  const payload = { v: 1, licenseId: 't', customer: 'ACME', seats, issuedAt: '2026-01-01T00:00:00Z', expiresAt, graceDays: 7 }
  const buf = Buffer.from(JSON.stringify(payload), 'utf8')
  return buf.toString('base64url') + '.' + sign(null, buf, privateKey).toString('base64url')
}
function mkLicF(features: string[]): string {
  const payload = { v: 1, licenseId: 't', customer: 'ACME', seats: 10, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z', graceDays: 7, features }
  const buf = Buffer.from(JSON.stringify(payload), 'utf8')
  return buf.toString('base64url') + '.' + sign(null, buf, privateKey).toString('base64url')
}
function setLicense(key: string | null) {
  process.env.LICENSE_PUBLIC_KEY = PUB
  if (key) process.env.LICENSE_KEY = key
  else delete process.env.LICENSE_KEY
  __resetLicenseCache()
}
afterEach(() => {
  delete process.env.LICENSE_KEY
  delete process.env.LICENSE_PUBLIC_KEY
  delete process.env.LICENSE_SERVER_URL
  delete process.env.LICENSE_STATE_FILE
  rmSync(HB_FILE, { force: true })
  rmSync(LIC_FILE, { force: true })
  __resetLicenseCache()
})

describe('license 界面激活(上传文件)', () => {
  it('上传有效授权 → 落盘激活,loadLicense 生效', () => {
    delete process.env.LICENSE_KEY
    process.env.LICENSE_PUBLIC_KEY = PUB
    __resetLicenseCache()
    expect(hasLicenseSource()).toBe(false)
    activateLicense({ license: mkLicense(20, '2999-01-01T00:00:00Z'), server: 'https://lic.example' })
    expect(hasLicenseSource()).toBe(true)
    expect(loadLicense()?.seats).toBe(20)
  })
  it('上传无效授权 → 抛 INVALID_INPUT', () => {
    process.env.LICENSE_PUBLIC_KEY = PUB
    expect(() => activateLicense({ license: 'garbage.sig' })).toThrow()
  })
})

describe('license 功能开关(AI 板块)', () => {
  it('不强制 → 全功能开', () => {
    setLicense(null)
    expect(licenseHasFeature('ai')).toBe(true)
  })
  it('强制 + license 含 ai → 开', () => {
    setLicense(mkLicF(['ai']))
    expect(licenseHasFeature('ai')).toBe(true)
  })
  it('强制 + license 不含 ai → 关', () => {
    setLicense(mkLicF([]))
    expect(licenseHasFeature('ai')).toBe(false)
  })
})

describe('license 强制', () => {
  it('未配 LICENSE_KEY → 不强制,建账号不受限、不只读', async () => {
    setLicense(null)
    const t = await createOrgTestDb()
    await seedTenant(t.db)
    expect(licenseEnforced()).toBe(false)
    await expect(assertSeatAvailable(t.db)).resolves.toBeUndefined()
    expect(isWriteBlocked()).toBe(false)
    t.close()
  })
  it('已达席位 → 新增账号被拦(LICENSE_SEAT_LIMIT)', async () => {
    const t = await createOrgTestDb()
    await seedTenant(t.db)
    const used = await countActiveSeats(t.db)
    setLicense(mkLicense(used, '2999-01-01T00:00:00Z')) // 席位=当前用量 → 满
    await expect(assertSeatAvailable(t.db)).rejects.toMatchObject({ code: 'LICENSE_SEAT_LIMIT' })
    t.close()
  })
  it('席位充足 → 放行', async () => {
    const t = await createOrgTestDb()
    await seedTenant(t.db)
    setLicense(mkLicense(999, '2999-01-01T00:00:00Z'))
    await expect(assertSeatAvailable(t.db)).resolves.toBeUndefined()
    t.close()
  })
  it('过期且过宽限 → 写被拦(只读)', () => {
    setLicense(mkLicense(999, '2020-01-01T00:00:00Z'))
    expect(isWriteBlocked()).toBe(true)
  })
})

describe('license 心跳折叠', () => {
  it('配了心跳服务 + 远程吊销 → 写被拦', () => {
    setLicense(mkLicense(999, '2999-01-01T00:00:00Z')) // 本地未到期
    process.env.LICENSE_SERVER_URL = 'https://lic.example'
    setHb({ revoked: true, serverExpiresAt: null, lastOkAt: new Date().toISOString() })
    expect(isWriteBlocked()).toBe(true)
  })
  it('远程续期(serverExpiresAt 更晚)→ 本地已过期也恢复可写', () => {
    setLicense(mkLicense(999, '2020-01-01T00:00:00Z')) // 本地早过期
    process.env.LICENSE_SERVER_URL = 'https://lic.example'
    setHb({ revoked: false, serverExpiresAt: '2999-01-01T00:00:00Z', lastOkAt: new Date().toISOString() })
    expect(isWriteBlocked()).toBe(false)
  })
  it('配了心跳但长期 check-in 不上 → 视为过期、写被拦', () => {
    setLicense(mkLicense(999, '2999-01-01T00:00:00Z'))
    process.env.LICENSE_SERVER_URL = 'https://lic.example'
    setHb({ revoked: false, serverExpiresAt: null, lastOkAt: '2020-01-01T00:00:00Z' }) // 很久没成功
    expect(isWriteBlocked()).toBe(true)
  })
  it('未配心跳服务 → 忽略心跳文件(纯离线证)', () => {
    setLicense(mkLicense(999, '2999-01-01T00:00:00Z'))
    setHb({ revoked: true, serverExpiresAt: null, lastOkAt: new Date().toISOString() }) // 即便文件说吊销
    expect(isWriteBlocked()).toBe(false) // 没配 LICENSE_SERVER_URL → 不看心跳
  })
})
