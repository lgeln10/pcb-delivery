// core/ui-kit/tests/async-state-prop-guard.test.ts
// **`<AsyncState empty-text="…">` —— 那句引导文案一次都没显示过。**
//
// 与同目录的 css-var-guard 是同一族问题:`.vue` 里的错没有任何东西拦得住。
// AsyncState 的空状态 prop 是 `empty-title` / `empty-hint`,**没有 `empty-text`**。
// 写成 `empty-text`,Vue 不当回事(顶多控制台一句 extraneous non-props attributes),
// 类型检查过、构建过、测试全绿 —— 页面只是永远显示默认的「暂无数据」,
// 精心写的「先在上方新增」「可在下方撰写并发送第一封邮件」用户一次都没看到。
//
// 实际发生过(2026-08-15):8 个页面共 12 处这么写,最早的已经躺了好几个月。
//
// 为什么容易写错:`empty-text` 是 Element Plus `<el-table>` / `<el-select>` 的**合法** prop,
// 天天在同一个文件里出现,顺手就带到 AsyncState 上了。所以这条护栏只看 `<AsyncState` 标签内部,
// el-table / el-select 上的 `empty-text` 一律不管。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname
const SCAN_DIRS = ['modules', 'core', 'src']

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

const vueFiles = () => SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), '.vue'))
const rel = (p: string) => p.slice(ROOT.length)

const TAG_RE = /<AsyncState(?=[\s/>])/g

/**
 * 切出每个 `<AsyncState …>` 开标签的属性区。
 * 逐字符找第一个「不在引号里」的 `>` —— 属性值里可能有 `>`(如 `:empty="n > 0"`),
 * 直接 indexOf('>') 会截断,漏掉后面的属性。
 */
function openTags(src: string): { attrs: string; line: number }[] {
  const out: { attrs: string; line: number }[] = []
  for (const m of src.matchAll(TAG_RE)) {
    const start = m.index!
    let quote: string | null = null
    let end = -1
    for (let i = start; i < src.length; i++) {
      const ch = src[i]!
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        end = i
        break
      }
    }
    if (end === -1) continue // 标签没闭合,交给模板编译器去报
    out.push({ attrs: src.slice(start, end), line: src.slice(0, start).split('\n').length })
  }
  return out
}

function collect() {
  const offences: { file: string; line: number }[] = []
  for (const f of vueFiles()) {
    for (const tag of openTags(readFileSync(f, 'utf8'))) {
      if (/\bempty-text\s*=/.test(tag.attrs)) offences.push({ file: rel(f), line: tag.line })
    }
  }
  return offences
}

describe('AsyncState 空状态 prop 护栏', () => {
  it('扫得到 AsyncState 用法(否则这条测试是空跑)', () => {
    const total = vueFiles().reduce((n, f) => n + openTags(readFileSync(f, 'utf8')).length, 0)
    expect(vueFiles().length).toBeGreaterThan(20)
    expect(total).toBeGreaterThan(20)
  })

  it('★AsyncState 上不得出现 empty-text —— 它不是 prop,那句文案永远不会显示', () => {
    const found = collect()
    const lines = found.map((o) => `  ${o.file}:${o.line}`).join('\n')
    expect(
      found,
      `这些 <AsyncState> 写了 empty-text,而 AsyncState 没有这个 prop —— ` +
        `Vue 会把它当普通 attr 丢到 DOM 上,用户看到的一直是默认的「暂无数据」:\n${lines}\n` +
        `\n改法:短名词短语放 empty-title,整句引导放 empty-hint。` +
        `\n(el-table / el-select 的 empty-text 是合法 prop,本护栏不扫它们。)`,
    ).toEqual([])
  })

  it('检测逻辑本身有效:属性值里带 > 也不会截断', () => {
    const src = [
      '<AsyncState :empty="rows.length > 0" empty-text="漏网的">',
      '<el-table empty-text="这个合法" />',
      '<AsyncStateFoo empty-text="别的组件" />',
    ].join('\n')
    const bad = openTags(src).filter((t) => /\bempty-text\s*=/.test(t.attrs))
    expect(bad.map((t) => t.line)).toEqual([1])
  })
})
