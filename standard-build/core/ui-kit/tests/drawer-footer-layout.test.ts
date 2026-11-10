// 抽屉底部按钮的排布约定(源码级)。
//
// 约定:**破坏性操作(删除/作废/清除…)连着排在最左边一组,其余动作靠右。**
// 实现只有一处 —— src/styles.css 里 `.drawer-footer__danger + :not(.drawer-footer__danger)`
// 拿 `margin-left: auto`,在左右两组的交界处断开一次。
//
// ★这条护栏来自一次真实的走形(2026-08-26 用户报):原先的写法是给**每个** danger 各写
//   一个 `margin-right: auto`。flex 里多个 auto 外边距会把剩余空间**均分** —— 于是
//   「删除」停在最左、「作废」被推到正中间孤零零一个,中间两大片空白。
//   删除/作废同时出现的有合同、线索、报销单三处,三处全是这个样子。
//
// 两件事都要钉,因为两件都**改坏了不会有任何地方报错**:
//   ① 交界只能有一次 → danger 必须连着排在最前(中间夹一个非 danger,空白又会被均分回来);
//   ② 删除/作废这类按钮必须标 drawer-footer__danger(漏标就混进右边那排正向动作里,
//      商机的「作废」和凭证的「作废」当年就是这样夹在「编辑」「过账」中间的)。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['core', 'modules', 'src']
const DANGER = 'drawer-footer__danger'

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name.endsWith('.vue')) yield p
  }
}

/** 取出每个 `<div class="drawer-footer">` 的内容(按 div 配平,不用正则一把梭)。 */
function footerBlocks(src: string): string[] {
  const out: string[] = []
  const re = /<div[^>]*class="drawer-footer"[^>]*>/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1
    let j = m.index + m[0].length
    const start = j
    while (depth > 0) {
      const open = src.indexOf('<div', j)
      const close = src.indexOf('</div>', j)
      if (close === -1) break
      if (open !== -1 && open < close) { depth++; j = open + 4 } else { depth--; j = close + 6 }
    }
    out.push(src.slice(start, Math.max(start, j - 6)))
  }
  return out
}

/**
 * 顶层子元素(嵌套在别的元素里的不算 —— 它们不是 flex 直接子项)。
 * 返回开标签原文与它在 block 里的结束位置,后者用来取标签之后的文案。
 * ★别用 `<${name}${attrs}>` 重新拼一个再去 indexOf:自闭合标签的 `/` 会丢,
 *   indexOf 返回 -1,取出来的"文案"就是隔壁属性的一截(第一版就是这么误报的)。
 */
function topLevelTags(block: string): Array<{ tag: string; end: number }> {
  const tags: Array<{ tag: string; end: number }> = []
  const stack: string[] = []
  const re = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  for (let m = re.exec(block); m; m = re.exec(block)) {
    const [, closing, name, , selfClose] = m
    if (closing) { if (stack[stack.length - 1] === name) stack.pop(); continue }
    if (stack.length === 0 && name !== 'template') tags.push({ tag: m[0], end: m.index + m[0].length })
    if (!selfClose && !['br', 'img', 'input', 'hr'].includes(name!)) stack.push(name!)
  }
  return tags
}

const FILES = ROOTS.flatMap((r) => [...walk(join(process.cwd(), r))])
  .map((f) => ({ rel: f.slice(process.cwd().length + 1), src: readFileSync(f, 'utf8') }))
  .filter((f) => f.src.includes('class="drawer-footer"'))

describe('抽屉底部:破坏性操作靠左成一组', () => {
  it('扫得到底部块 —— 扫不到就是选择器变了,不是问题消失了', () => {
    expect(FILES.length).toBeGreaterThan(2)
  })

  it('★danger 必须连着排在最前:中间夹一个非 danger,剩余空白会被 flex 均分回来', () => {
    const offenders: string[] = []
    for (const { rel, src } of FILES) {
      for (const block of footerBlocks(src)) {
        const flags = topLevelTags(block).map((t) => t.tag.includes(DANGER))
        // 合法形状:一串 true 之后全是 false(v-if/v-else 互斥的一对也要写成 danger 在前)
        const firstFalse = flags.indexOf(false)
        if (firstFalse !== -1 && flags.slice(firstFalse).includes(true)) {
          offenders.push(`${rel}: [${flags.map((f) => (f ? '★' : '·')).join('')}]`)
        }
      }
    }
    expect(
      offenders,
      'danger 之间夹了非 danger:左右两组的交界会出现两次,`margin-left: auto` 被应用两回,' +
        '空白被均分 —— 中间那个按钮就会孤零零停在屏幕正中(这正是当年那个 bug 的样子)',
    ).toEqual([])
  })

  it('★删除/作废这类按钮必须标 drawer-footer__danger,否则混进右边那排正向动作里', () => {
    // 只看底部块里的按钮文案/label;「取消」「关闭」「退回」不算破坏性。
    const DESTRUCTIVE = /(^|[^不])(删除|作废|清空|移除)/
    const offenders: string[] = []
    for (const { rel, src } of FILES) {
      for (const block of footerBlocks(src)) {
        for (const { tag, end } of topLevelTags(block)) {
          if (tag.includes(DANGER)) continue
          // ConfirmButton 用 label=;el-button 的文案在标签之后。两者都只取「按钮上印的字」——
          // confirm-text 之类的说明文字里也有「删除」,拿它判会满屏误报。
          const label = /\slabel="([^"]*)"/.exec(tag)?.[1] ?? ''
          const text = label || (/^\s*([^<>{]{1,20})/.exec(block.slice(end))?.[1] ?? '')
          if (DESTRUCTIVE.test(text.trim())) offenders.push(`${rel}: ${text.trim().slice(0, 16)}`)
        }
      }
    }
    expect(
      offenders,
      '这些破坏性按钮没标 drawer-footer__danger:它们会排进右边那排正向动作里 —— ' +
        '「作废」挨着「过账」「转赢单」,点错一次单据就废了',
    ).toEqual([])
  })
})

describe('实现只有一处', () => {
  it('★左右分组只由 styles.css 那条交界规则实现,别在页面里各写各的 margin', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css, '交界规则不见了 —— 左右分组失效,所有按钮会挤到右边').toContain(
      `.${DANGER} + :not(.${DANGER})`,
    )
    // 老写法必须绝迹:它就是「作废停在正中间」的成因
    const perItem = new RegExp(`\\.${DANGER}\\s*\\{[^}]*margin-right:\\s*auto`, 's')
    expect(
      perItem.test(css),
      '又给每个 danger 各写了一个 margin-right: auto —— flex 会把剩余空间均分,' +
        '两个 danger 时中间那个会停在屏幕正中(:last-child 那条兜底不算,它只在没有右侧兄弟时生效)',
    ).toBe(false)
  })
})
