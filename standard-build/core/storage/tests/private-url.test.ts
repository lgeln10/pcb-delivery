// 私有文件下载票据 + 内部标记互转:签发/校验/过期/篡改/跨租户,以及 key 编码。
import { describe, expect, it, vi } from 'vitest'
import {
  isPrivateMarker,
  normalizeStoredFileUrl,
  keyFromPrivateMarker,
  privateMarker,
  signedDownloadPath,
  signFileTicket,
  verifyFileTicket,
} from '../private-url'

const SECRET = 'test-secret-do-not-use'
const TENANT = '11111111-1111-1111-1111-111111111111'
const KEY = 'contract/scans/abc-合同扫描件 A.pdf'

describe('私有文件内部标记', () => {
  it('标记与 key 互转;非标记不误判', () => {
    expect(privateMarker(KEY)).toBe(`storage:private/${KEY}`)
    expect(isPrivateMarker(privateMarker(KEY))).toBe(true)
    expect(keyFromPrivateMarker(privateMarker(KEY))).toBe(KEY)
    expect(isPrivateMarker('https://bucket.tos-cn-beijing.volces.com/website/a.png')).toBe(false)
    expect(keyFromPrivateMarker('https://x/website/a.png')).toBeNull()
  })
})

describe('下载票据', () => {
  it('签发的票据能验过,并回带租户 id', () => {
    const t = signFileTicket(KEY, TENANT, SECRET)
    expect(verifyFileTicket(KEY, t, SECRET)).toBe(TENANT)
  })

  it('换一个 key 用同一张票据 → 验不过(票据绑定 key)', () => {
    const t = signFileTicket(KEY, TENANT, SECRET)
    expect(verifyFileTicket('contract/scans/别人的文件.pdf', t, SECRET)).toBeNull()
  })

  it('改签名 / 改载荷 / 换密钥 → 一律验不过', () => {
    const t = signFileTicket(KEY, TENANT, SECRET)
    const [body, sig] = t.split('.')
    expect(verifyFileTicket(KEY, `${body}.${sig!.slice(0, -2)}xx`, SECRET)).toBeNull()
    const forged = Buffer.from(JSON.stringify({ tid: 'other-tenant', exp: 99999999999 })).toString('base64url')
    expect(verifyFileTicket(KEY, `${forged}.${sig}`, SECRET)).toBeNull()
    expect(verifyFileTicket(KEY, t, 'another-secret')).toBeNull()
  })

  it('过期票据验不过', () => {
    const t = signFileTicket(KEY, TENANT, SECRET, 60)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.now() + 61_000))
      expect(verifyFileTicket(KEY, t, SECRET)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('空票据/垃圾串不抛异常,直接判否', () => {
    expect(verifyFileTicket(KEY, '', SECRET)).toBeNull()
    expect(verifyFileTicket(KEY, 'not-a-ticket', SECRET)).toBeNull()
    expect(verifyFileTicket(KEY, '....', SECRET)).toBeNull()
  })
})

describe('下载地址拼装', () => {
  it('key 逐段编码(中文/空格可用),票据按原始 key 签', () => {
    const path = signedDownloadPath(KEY, TENANT, SECRET)
    expect(path.startsWith('/api/files/contract/scans/')).toBe(true)
    expect(path).not.toContain(' ') // 空格已编码
    const url = new URL(path, 'https://example.com')
    const decodedKey = decodeURIComponent(url.pathname.replace('/api/files/', ''))
    expect(decodedKey).toBe(KEY)
    expect(verifyFileTicket(decodedKey, url.searchParams.get('t')!, SECRET)).toBe(TENANT)
  })
})

describe('normalizeStoredFileUrl:落库前把带票据地址归一回稳定标记', () => {
  it('/api/files/<key>?t=... → storage:private/<key>(逐段解码中文/空格)', () => {
    const key = 'reimbursements/invoices/uuid-发票 A.pdf'
    const enc = key.split('/').map(encodeURIComponent).join('/')
    expect(normalizeStoredFileUrl(`/api/files/${enc}?t=abc.def`)).toBe(`storage:private/${key}`)
    expect(normalizeStoredFileUrl(`/api/files/${enc}`)).toBe(`storage:private/${key}`)
  })
  it('已是标记 / http 直链 / /uploads 相对 / null / undefined 一律原样返回', () => {
    expect(normalizeStoredFileUrl('storage:private/contract/scans/x.pdf')).toBe('storage:private/contract/scans/x.pdf')
    expect(normalizeStoredFileUrl('https://bucket.tos.com/website/a.png')).toBe('https://bucket.tos.com/website/a.png')
    expect(normalizeStoredFileUrl('/uploads/branding/logo.png')).toBe('/uploads/branding/logo.png')
    expect(normalizeStoredFileUrl(null)).toBeNull()
    expect(normalizeStoredFileUrl(undefined)).toBeUndefined()
  })
  it('归一后签发的下载地址,其 key 与原始 key 一致(闭环可用)', () => {
    const key = 'finance/invoices/uuid-票.pdf'
    const enc = key.split('/').map(encodeURIComponent).join('/')
    const marker = normalizeStoredFileUrl(`/api/files/${enc}?t=stale`)
    expect(keyFromPrivateMarker(marker!)).toBe(key)
  })
})
