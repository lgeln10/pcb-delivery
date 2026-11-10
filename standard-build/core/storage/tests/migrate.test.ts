// core/storage/tests/migrate.test.ts
// 迁移的纯逻辑(本地 URL 抽取 / key 反推 / 指向改写)单测。真云上传与 DB 回写需真 OSS/PG,不在此覆盖。
import { describe, expect, it } from 'vitest'
import { extractLocalUrls, keyFromLocalUrl, replaceUrls } from '../migrate'

describe('storage migrate — 纯逻辑', () => {
  it('extractLocalUrls:相对 + 绝对都抽出,去重保序', () => {
    const text = '/uploads/general-request/u1-a.pdf 又见 https://x.example.com/uploads/finance/v/b.pdf 再见 /uploads/general-request/u1-a.pdf'
    expect(extractLocalUrls(text)).toEqual([
      '/uploads/general-request/u1-a.pdf',
      'https://x.example.com/uploads/finance/v/b.pdf',
    ])
  })

  it('extractLocalUrls:jsonb 文本内(引号包裹)只取到 URL 本体', () => {
    const jsonText = JSON.stringify([{ name: 'a.pdf', url: '/uploads/general-request/uuid-a.pdf' }])
    expect(extractLocalUrls(jsonText)).toEqual(['/uploads/general-request/uuid-a.pdf'])
  })

  it('extractLocalUrls:text[] 文本内(逗号分隔),外链不误抓', () => {
    const arrText = '{/uploads/finance/vouchers/x.pdf,https://cdn.other.com/some/report.pdf}'
    // 外链不含 /uploads/,不应被抽出
    expect(extractLocalUrls(arrText)).toEqual(['/uploads/finance/vouchers/x.pdf'])
  })

  it('keyFromLocalUrl:相对/绝对同解为 /uploads/ 之后的 key', () => {
    expect(keyFromLocalUrl('/uploads/general-request/uuid-a.pdf')).toBe('general-request/uuid-a.pdf')
    expect(keyFromLocalUrl('https://host/uploads/finance/vouchers/x.pdf')).toBe('finance/vouchers/x.pdf')
  })

  it('replaceUrls:先替换更长(绝对)再替换相对,互不污染', () => {
    const text = '相对 /uploads/a.pdf 与绝对 https://old.host/uploads/a.pdf'
    const mapping = new Map([
      ['/uploads/a.pdf', 'https://cdn.new/a.pdf'],
      ['https://old.host/uploads/a.pdf', 'https://cdn.new/a.pdf'],
    ])
    const out = replaceUrls(text, mapping)
    expect(out).toBe('相对 https://cdn.new/a.pdf 与绝对 https://cdn.new/a.pdf')
    // 幂等/彻底:替换后不应再残留本地指向
    expect(extractLocalUrls(out)).toEqual([])
  })

  it('replaceUrls:jsonb 场景改写后仍是合法 JSON 且指向云端', () => {
    const jsonText = JSON.stringify([{ name: 'a.pdf', url: '/uploads/general-request/uuid-a.pdf' }])
    const mapping = new Map([['/uploads/general-request/uuid-a.pdf', 'https://cdn.new/general-request/uuid-a.pdf']])
    const out = replaceUrls(jsonText, mapping)
    const parsed = JSON.parse(out) as { name: string; url: string }[]
    expect(parsed[0]!.url).toBe('https://cdn.new/general-request/uuid-a.pdf')
    expect(extractLocalUrls(out)).toEqual([])
  })

  it('replaceUrls:未映射的本地 URL(如本地文件缺失)保持原样', () => {
    const text = '/uploads/present/a.pdf 和 /uploads/missing/b.pdf'
    const mapping = new Map([['/uploads/present/a.pdf', 'https://cdn.new/present/a.pdf']])
    const out = replaceUrls(text, mapping)
    expect(out).toBe('https://cdn.new/present/a.pdf 和 /uploads/missing/b.pdf')
  })
})
