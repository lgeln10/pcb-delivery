// 护栏:styles.css 里对 Element Plus 的覆盖,有没有会被 EP 自己的声明**静默压掉**的。
//
// ★为什么需要这个测试(2026-08-16 真出过事):
//   e3b4409c 把 EP 改成按需引入之前,main.ts 里是
//       import 'element-plus/dist/index.css'   ← EP
//       import './styles.css'                  ← 我们(在后,同特指度我们赢)
//   改完之后,EP 的组件 CSS 由 unplugin 注入到各 .vue 里,而**页面是懒加载的、运行时才到**,
//   于是顺序永久反转:**同特指度平手时 EP 赢**。styles.css 里几十条覆盖都建立在旧前提上。
//
//   它的可怕之处在于**一半生效一半不生效**,肉眼很难归因。真实现象:
//     · `.el-radio-button__inner` 的 `display:inline-flex` 被压回 `inline-block`,
//       但同一条规则里的 `min-height:44px` 生效了(EP 没声明这个属性)——
//       结果是「盒子 44px 高、字顶在上边」,报上来的话叫「按钮高度和内容高度不匹配」。
//     · `.el-select__wrapper` 的 min-height 被压回 32px、`--small` 那档被压回 **24px**,
//       而紧挨着的 `.el-input__wrapper` 是 44px(EP 没声明)——就是「相邻控件上下错位」。
//     · `.el-table .cell` 的 line-height 被压回 23px,全站每张表每一行高 2px(桌面端也中招)。
//
// ★为什么不用别的办法:
//   · 调 import 顺序 —— 救不回来,懒加载路由的 CSS 永远更晚。
//   · 恢复引入全量 EP CSS —— 首屏渲染阻塞路径上要多下约 24KB(brotli),把刚做完的首屏优化吃掉。
//   · `@layer` 把 EP 降一层 —— 老 WebView 不认 @layer 时会**整块丢弃**那段 CSS,
//     等于用「小错位」换「整站掉样式」,不划算(本仓要覆盖企业安卓机的旧 WebView)。
//   → 结论:与 EP 声明了**同一个属性**的覆盖,一律显式 `!important`;本测试负责扫出漏网的。
//     不同属性不算竞争(例:我们写 min-height、EP 写 height,min-height 本来就会顶开 height)。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const EP_DIR = join(ROOT, 'node_modules/element-plus/theme-chalk')

/** 只看这些属性:错了会造成肉眼可见的尺寸/对齐/命中区偏差。颜色类的错了一眼就能看见,不用护栏。 */
const WATCHED = new Set([
  'display',
  'height',
  'min-height',
  'max-height',
  'line-height',
  'align-items',
  'justify-content',
  'padding',
  'vertical-align',
  'width',
  'min-width',
  'flex',
])

/**
 * 本仓**不使用**的 EP 上下文类。EP 的 CSS 里有大量只在这些容器里才生效的规则,
 * 它们不可能命中我们的元素,算进来就是误报。每加一条都要写清楚为什么用不到。
 */
const DEAD_CONTEXTS = new Map<string, string>([
  // 侧栏菜单是纵向的(App.vue 的 el-menu 没有 mode="horizontal");
  // EP 的 .el-menu--horizontal 那一大批规则永远匹配不到。
  ['el-menu--horizontal', '本仓只有纵向侧栏菜单,没有 mode="horizontal"'],
])

/**
 * 已人工判定为误报的组合。扫描器只做「键选择器互为子集」的近似,判不出两个**祖先容器**
 * 在真实 DOM 里根本不会嵌套 —— 那种只能人看。
 * ★写成「我方选择器 + EP 选择器」的配对,而不是整条豁免:同一个选择器上**新出现**的冲突照样会红。
 */
const ACKNOWLEDGED: Array<{ mine: string; ep: string; why: string }> = [
  {
    mine: '.filter-bar .el-select',
    ep: '.el-pagination .el-select',
    why: '筛选条里的下拉不会长在分页器里 —— 两个容器不嵌套',
  },
  {
    mine: '.drawer-footer .el-button',
    ep: '.el-input-group__append .el-button',
    why: '抽屉底部操作按钮不会长在输入框组的 append 槽里',
  },
  // 筛选抽屉(手机上 FilterBar 把字段搬进去的那个 bottom sheet)里同样没有分页器 ——
  // 与上面 .filter-bar 那条同源,只是容器换了个名字。
  {
    mine: '.sb-filter-sheet .el-select',
    ep: '.el-pagination .el-select',
    why: '筛选抽屉里的下拉不会长在分页器里 —— 两个容器不嵌套',
  },
  {
    mine: '.sb-filter-sheet .el-input',
    ep: '.el-pagination--large .el-select .el-input',
    why: '同上:筛选抽屉里没有分页器,更没有 large 档的分页器',
  },
  {
    mine: '.sb-filter-sheet .el-date-editor.el-input',
    ep: '.el-pagination--large .el-select .el-input',
    why: '同上。这条本身是为了压过 `.el-date-editor.el-input`(那条是真冲突,已用三层特指度压掉)',
  },
  {
    mine: '.el-descriptions__table',
    ep: '.el-descriptions__body .el-descriptions__table',
    why: 'EP 那条的值与我们完全一致(都是 width:100%),压掉也没有任何视觉差异',
  },
]

function specificity(sel: string): number {
  const s = sel
    .replace(/::[a-zA-Z-]+/g, ' e') // 伪元素按元素算
    .replace(/:(?:is|where|not)\([^)]*\)/g, ' c') // 粗算,够用
    .replace(/:[a-zA-Z-]+(?:\([^)]*\))?/g, ' c') // 伪类按类算
  const ids = (s.match(/#[\w-]+/g) ?? []).length
  const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|(?<![\w-])c(?![\w-])/g) ?? []).length
  const els = (s.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length
  return ids * 10000 + cls * 100 + els
}

/** 最右复合选择器里的类名集合 —— 判断两条规则会不会命中同一个元素 */
function keyClasses(sel: string): Set<string> {
  const last = sel.trim().split(/\s*[\s>+~]\s*/).pop() ?? ''
  return new Set((last.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1)))
}

/** 除最右复合之外的祖先部分里出现的类名 */
function ancestorClasses(sel: string): Set<string> {
  const parts = sel.trim().split(/\s*[\s>+~]\s*/)
  parts.pop()
  return new Set(parts.flatMap((p) => (p.match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1))))
}

interface Rule {
  origin: string
  sel: string
  spec: number
  keys: Set<string>
  ancestors: Set<string>
  decls: Map<string, { value: string; important: boolean }>
}

function parseRules(css: string, origin: string): Rule[] {
  const out: Rule[] = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean))) {
    const selRaw = m[1]!.trim()
    if (!selRaw || selRaw.startsWith('@')) continue
    const decls = new Map<string, { value: string; important: boolean }>()
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':')
      if (i < 0) continue
      const prop = d.slice(0, i).trim().toLowerCase()
      if (!WATCHED.has(prop)) continue
      decls.set(prop, { value: d.slice(i + 1).trim(), important: /!important/i.test(d) })
    }
    if (decls.size === 0) continue
    for (const sel of selRaw.split(',')) {
      const s = sel.trim()
      if (!s.includes('.el-')) continue
      out.push({ origin, sel: s, spec: specificity(s), keys: keyClasses(s), ancestors: ancestorClasses(s), decls })
    }
  }
  return out
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** EP 的规则会不会命中我们这条规则所针对的元素 */
function canCollide(mine: Rule, ep: Rule): boolean {
  for (const dead of ep.ancestors) if (DEAD_CONTEXTS.has(dead)) return false
  // 键选择器必须一宽一窄(或相同):互为子集才可能是同一批元素;
  // 修饰类互斥(.el-button--small vs .el-button.is-link)时两边都不是子集,判为不相干。
  if (mine.keys.size === 0 || ep.keys.size === 0) return false
  return isSubset(ep.keys, mine.keys) || isSubset(mine.keys, ep.keys)
}

interface Loss {
  prop: string
  mineSel: string
  epSel: string
  mine: string
  beatenBy: string
  file: string
}

function findLosses(): Loss[] {
  const mine = parseRules(readFileSync(join(ROOT, 'src/styles.css'), 'utf8'), 'styles.css')
  const theirs: Rule[] = []
  for (const f of readdirSync(EP_DIR)) {
    // index.css 是全量打包(内容与各 el-*.css 重复),只读分文件,免得同一条报两次
    if (!f.startsWith('el-') || !f.endsWith('.css')) continue
    theirs.push(...parseRules(readFileSync(join(EP_DIR, f), 'utf8'), f))
  }

  const losses: Loss[] = []
  for (const m of mine) {
    for (const [prop, mineDecl] of m.decls) {
      let worst: (Rule & { decl: { value: string; important: boolean } }) | null = null
      for (const t of theirs) {
        const td = t.decls.get(prop)
        if (!td) continue
        if (!canCollide(m, t)) continue
        // EP 排在我们后面 → 平手也是 EP 赢;!important 优先于特指度
        const epWins = td.important ? !mineDecl.important : mineDecl.important ? false : t.spec >= m.spec
        if (!epWins) continue
        if (!worst || t.spec > worst.spec) worst = { ...t, decl: td }
      }
      if (worst) {
        losses.push({
          prop,
          mineSel: m.sel,
          epSel: worst.sel,
          mine: `${m.sel} { ${prop}: ${mineDecl.value} }`,
          beatenBy: `${worst.sel} { ${prop}: ${worst.decl.value} }`,
          file: worst.origin,
        })
      }
    }
  }
  return losses
}

const isAcknowledged = (l: Loss) => ACKNOWLEDGED.some((a) => a.mine === l.mineSel && a.ep === l.epSel)

describe('Element Plus 覆盖的层叠护栏', () => {
  it('★styles.css 里没有会被 EP 静默压掉的覆盖(平手 = EP 赢,见文件头)', () => {
    const losses = findLosses().filter((l) => !isAcknowledged(l))
    const report = losses
      .map((l) => `  ✘ styles.css: ${l.mine}\n     被 ${l.file} 的 ${l.beatenBy} 压掉`)
      .join('\n')
    expect(
      losses,
      `下面这些覆盖写了但不会生效 —— 加 !important,或把选择器特指度提到严格高于 EP:\n${report}\n` +
        '(若确认是误报:EP 那条规则只在本仓用不到的容器里生效 → 往 DEAD_CONTEXTS 加一条并写明理由)',
    ).toEqual([])
  })

  it('豁免清单不许腐烂 —— 每条都还得对应一个真实存在的冲突', () => {
    // 覆盖被删/被改成 !important 之后,对应的豁免就成了误导人的死条目,这里逼着一起删。
    const all = findLosses()
    const stale = ACKNOWLEDGED.filter((a) => !all.some((l) => l.mineSel === a.mine && l.epSel === a.ep))
    expect(
      stale.map((s) => `${s.mine}  ↔  ${s.ep}`),
      '这些豁免已经没有对应的冲突了(覆盖被删或已加 !important),请从 ACKNOWLEDGED 里删掉',
    ).toEqual([])
  })

  it('护栏本身有效:去掉 !important 就该被扫出来', () => {
    // 反向自检 —— 防止解析器写错导致「永远 0 条」的空断言
    const fake = parseRules('.el-table .cell { line-height: 1.5; }', 'fake')[0]!
    const ep = parseRules('.el-table .cell{line-height:23px}', 'el-table.css')[0]!
    expect(canCollide(fake, ep)).toBe(true)
    expect(ep.spec >= fake.spec).toBe(true) // 平手 → EP 赢
    const fakeImportant = parseRules('.el-table .cell { line-height: 1.5 !important; }', 'fake')[0]!
    expect(fakeImportant.decls.get('line-height')!.important).toBe(true)
  })

  it('解析器确实读到了东西(防空断言)', () => {
    const mine = parseRules(readFileSync(join(ROOT, 'src/styles.css'), 'utf8'), 'styles.css')
    expect(mine.length).toBeGreaterThan(20)
    const epFiles = readdirSync(EP_DIR).filter((f) => f.startsWith('el-') && f.endsWith('.css'))
    expect(epFiles.length).toBeGreaterThan(50)
  })
})
