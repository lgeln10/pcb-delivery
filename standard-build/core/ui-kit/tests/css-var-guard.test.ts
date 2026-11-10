// core/ui-kit/tests/css-var-guard.test.ts
// **`.vue` 里引用了不存在的 CSS 变量 —— 页面会静默地没有样式。**
//
// 与同目录的 vue-missing-import-guard 是同一族问题:`.vue` 里的错没有任何东西拦得住。
// 这一类更阴 —— 缺 import 至少会白屏报 ReferenceError,而 **CSS 变量解析失败是完全静默的**:
// `border: 1px solid var(--color-border)` 里的变量不存在,整条声明被丢弃,没有报错、
// 没有告警,构建照常通过,测试照常全绿。页面只是"看着像没做设计"。
//
// 实际发生过(2026-08-02,智能体管理页):整页写成 --color-* / --space-* / --radius-*,
// 而本仓 token 体系是 --sb-*。边框、圆角、背景、间距通通没生效,直到有人打开页面才发现。
//
// 判据:`var(--x)` 里的 x 必须定义在某个 .css 里,或定义在同一个 .vue 内,
// 或是 Element Plus 自带的 --el-*。零猜测,不做级联/继承分析。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

const DEFINE_RE = /(--[a-zA-Z0-9-]+)\s*:/g
const USE_RE = /var\(\s*(--[a-zA-Z0-9-]+)/g
const rel = (p: string) => p.slice(ROOT.length)

/**
 * 已知欠账:写这条护栏时仓里已存在的未定义变量。
 *
 * ★**只降不升**:允许清理,不允许新增。这里冻结的是「发现时的现状」,不是「可以这么写」——
 *   每一条都是某个页面的某处样式**当前就是失效的**,只是还没人打开那一页发现。
 * ★2026-08-27 已逐页清零(34 个 → 0):错名统一改回 tokens.css 的正名、`--sb-font-mono` 与
 *   `--sb-color-danger-border` 补进 tokens、`--pv-primary` 在 SectionPreview 内补了兜底定义。
 *   此后新增未定义变量一律直接红,不再进欠账。
 */
const KNOWN_UNDEFINED = new Set<string>([])

function collect() {
  const defined = new Set<string>()
  for (const f of walk(ROOT, '.css')) {
    for (const m of readFileSync(f, 'utf8').matchAll(DEFINE_RE)) defined.add(m[1]!)
  }
  const offences: { file: string; varName: string }[] = []
  for (const f of walk(ROOT, '.vue')) {
    const src = readFileSync(f, 'utf8')
    // 同一个 .vue 里自定义的局部变量算已定义(组件内部约定,不必进 tokens)
    const local = new Set([...src.matchAll(DEFINE_RE)].map((m) => m[1]!))
    for (const m of new Set([...src.matchAll(USE_RE)].map((x) => x[1]!))) {
      if (defined.has(m) || local.has(m) || m.startsWith('--el-')) continue
      offences.push({ file: rel(f), varName: m })
    }
  }
  return offences
}

describe('CSS 变量护栏', () => {
  it('扫得到 .vue 与 .css(否则这条测试是空跑)', () => {
    expect(walk(ROOT, '.vue').length).toBeGreaterThan(20)
    expect(walk(ROOT, '.css').length).toBeGreaterThan(0)
  })

  it('★不得新增未定义的 CSS 变量 —— 解析失败是静默的,页面只是没样式', () => {
    const fresh = collect().filter((o) => !KNOWN_UNDEFINED.has(o.varName))
    const lines = fresh.map((o) => `  ${o.file}: var(${o.varName})`).join('\n')
    expect(
      fresh,
      `这些 CSS 变量没有任何 .css 定义过,写了等于没写(整条声明被静默丢弃):\n${lines}\n` +
        `\n请到 core/ui-kit/tokens.css 查正确的名字 —— 本仓 token 一律 --sb-* 前缀。`,
    ).toEqual([])
  })

  it('★欠账只降不升:KNOWN_UNDEFINED 里已经不存在的条目要删掉', () => {
    const still = new Set(collect().map((o) => o.varName))
    const stale = [...KNOWN_UNDEFINED].filter((v) => !still.has(v))
    expect(
      stale,
      `这些变量已经不再被引用(或已补进 tokens.css),请从 KNOWN_UNDEFINED 里删掉 —— ` +
        `留着会让门槛悄悄变松:\n${stale.join('\n')}`,
    ).toEqual([])
  })
})
