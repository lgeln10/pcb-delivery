// core/org/tests/qr-payload-contract.test.ts
// 二维码里那串 JSON 是**跨仓契约**:电脑端由 core/org/ui/MobileQrLogin.vue 的 payloadOf() 生成,
// 手机端由 mobile-app/shell/app.js 的 parseScan() 解析。两边各自维护,没有编译器管它们。
//
// ★分叉的表现是最糟的一种:扫码器扫到了、解出来了、但 ticket 字段名对不上 →
//   壳把它当成「只填地址的入口码」,人被留在填账号密码的页面上,**全程不报错**,
//   而电脑那边永远停在「等待扫码」。所以这条契约必须有个会红的地方。
//
// 这里不是扫源码找关键字,而是**把壳里那个函数真的抠出来跑**(它无外部依赖)。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../../../..')
const shellSrc = readFileSync(join(ROOT, 'mobile-app/shell/app.js'), 'utf8')
const pcSrc = readFileSync(join(import.meta.dirname, '../ui/MobileQrLogin.vue'), 'utf8')

/**
 * 把壳里的 parseScan 抠出来变成可调用的函数。抠不到就直接红 —— 别静默 skip。
 *
 * ★数花括号必须跳过字符串和注释:parseScan body 里就有一处 `=== '{'`,
 *   天真的计数器会被那个引号里的花括号带偏,配对到文件末尾,报一句
 *   莫名其妙的 `Unexpected identifier 'let'`(第一版就是这么红的)。
 */
function loadParseScan(): (t: string) => { server: string; ticket: string | null } | null {
  const start = shellSrc.indexOf('function parseScan(')
  expect(start, 'mobile-app/shell/app.js 里找不到 parseScan —— 这条契约的前提变了').toBeGreaterThan(-1)

  const from = shellSrc.indexOf('{', start)
  let depth = 0
  let i = from
  let quote: string | null = null
  for (; i < shellSrc.length; i++) {
    const c = shellSrc[i]!
    const prev = shellSrc[i - 1]
    if (quote) {
      if (c === quote && prev !== '\\') quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '/' && shellSrc[i + 1] === '/') { i = shellSrc.indexOf('\n', i); continue }
    if (c === '/' && shellSrc[i + 1] === '*') { i = shellSrc.indexOf('*/', i) + 1; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) break
  }
  expect(depth, 'parseScan 的花括号没配上,抠取逻辑失效了').toBe(0)
  return new Function('text', shellSrc.slice(from + 1, i)) as ReturnType<typeof loadParseScan>
}

/** 电脑端二维码里那串 JSON 的判别字段值(payloadOf 里写死的 `t`)。 */
function pcDiscriminator(): string {
  const m = pcSrc.match(/t:\s*'([^']+)'/)
  expect(m, 'MobileQrLogin.vue 的 payloadOf 里找不到判别字段 t').not.toBeNull()
  return m![1]!
}

const parseScan = loadParseScan()

describe('★扫码 payload 契约:电脑生成的码,手机必须认得', () => {
  it('登录码 → 解出 server + ticket', () => {
    const payload = JSON.stringify({
      v: 1,
      t: pcDiscriminator(),
      server: 'https://ai.example.com',
      ticket: 'x'.repeat(43),
    })
    const r = parseScan(payload)
    expect(r, '手机端把电脑生成的登录码解成了 null').not.toBeNull()
    expect(r!.server).toBe('https://ai.example.com')
    expect(r!.ticket, '★ticket 没解出来 = 壳会把登录码当成「只填地址」,人被留在密码页,全程不报错').toBe(
      'x'.repeat(43),
    )
  })

  it('判别字段两边逐字一致(改一边就红)', () => {
    expect(shellSrc, `壳的 parseScan 认的判别值与电脑端的 '${pcDiscriminator()}' 对不上`).toContain(
      `'${pcDiscriminator()}'`,
    )
  })

  it('电脑端三个字段一个都不能少', () => {
    for (const k of ['server', 'ticket']) {
      expect(pcSrc, `payloadOf 少了 ${k},手机端解不出来`).toMatch(new RegExp(`${k}[:,\\s]`))
    }
  })
})

describe('parseScan 的其余形态(管理员发的「入口码」照旧只填地址)', () => {
  it('纯域名 / 完整 URL → ticket 为 null', () => {
    expect(parseScan('ai.example.com')).toEqual({ server: 'ai.example.com', ticket: null })
    expect(parseScan('https://ai.example.com/x')).toEqual({ server: 'https://ai.example.com/x', ticket: null })
  })

  it('老式 {"server":...} 入口码仍然只填地址', () => {
    expect(parseScan('{"server":"ai.example.com"}')).toEqual({ server: 'ai.example.com', ticket: null })
  })

  it('★票太短/不是字符串 → 退化成只填地址,而不是拿个坏票去调接口', () => {
    const bad = JSON.stringify({ t: 'aios-qr-login', server: 'ai.example.com', ticket: 'short' })
    expect(parseScan(bad)!.ticket).toBeNull()
    const worse = JSON.stringify({ t: 'aios-qr-login', server: 'ai.example.com', ticket: 12345 })
    expect(parseScan(worse)!.ticket).toBeNull()
  })

  it('★判别字段不对 → 不当登录码(别的系统的二维码碰巧带 ticket 字段也不会误触发)', () => {
    const other = JSON.stringify({ t: 'some-other-system', server: 'ai.example.com', ticket: 'y'.repeat(43) })
    expect(parseScan(other)!.ticket).toBeNull()
  })

  it('空 / 坏 JSON / 没有地址 → null', () => {
    expect(parseScan('')).toBeNull()
    expect(parseScan('{oops')).toBeNull()
    expect(parseScan('{"ticket":"' + 'z'.repeat(43) + '"}')).toBeNull()
  })
})
