// 响应式断点的一致性护栏(扫源码,同 core/org/tests/nav-permission-guard.test.ts 的做法)。
//
// ★为什么值得写这么一条:2026-08-02 之前,壳层的 JS 断点是 960、页面组件是 768,
//   于是 769–960 这一段变成「桌面 DOM + 移动 CSS」的混合体 —— FilterBar 渲染的是桌面收起态
//   (flex-wrap:wrap + max-height 限高一行),CSS 却把方向改成 column:
//   **列方向 + 换行 + 限高 = 往右边换列**,五个筛选字段横着排出去 3215px,
//   再被 body{overflow-x:hidden} 裁掉 —— 筛选项不是「要滑一下」,是**根本够不着**。
//   展开的折叠屏(华为 Mate X 约 890px、Galaxy Z Fold 约 820px)与小平板正好落在这一段。
//
//   这类错配不会报错、不会有失败的断言,只在某个宽度区间静默失效。只能靠扫源码钉住。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const appVue = readFileSync(join(root, 'src/App.vue'), 'utf8')
const stylesCss = readFileSync(join(root, 'src/styles.css'), 'utf8')
const filterBarVue = readFileSync(join(root, 'core/ui-kit/FilterBar.vue'), 'utf8')
const useIsMobileTs = readFileSync(join(root, 'src/composables/useIsMobile.ts'), 'utf8')

/** useIsMobile 的默认断点(页面组件不传参时用的那个) */
function defaultBreakpoint(): number {
  const m = useIsMobileTs.match(/query\s*=\s*'\(max-width:\s*(\d+)px\)'/)
  expect(m, 'useIsMobile 的默认 query 形状变了,更新本测试').not.toBeNull()
  return Number(m![1])
}

/** 把 styles.css 切成 [媒体条件, 块内文本] —— 只做顶层 @media,够用且不必引 CSS 解析器 */
function mediaBlocks(): Array<{ cond: string; body: string }> {
  const out: Array<{ cond: string; body: string }> = []
  const re = /@media\s*([^{]+)\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stylesCss)) !== null) {
    let depth = 1
    let i = re.lastIndex
    while (i < stylesCss.length && depth > 0) {
      if (stylesCss[i] === '{') depth++
      else if (stylesCss[i] === '}') depth--
      i++
    }
    out.push({ cond: m[1]!.trim(), body: stylesCss.slice(re.lastIndex, i - 1) })
  }
  return out
}

function maxWidthOf(cond: string): number | null {
  const m = cond.match(/max-width:\s*(\d+)px/)
  return m ? Number(m[1]) : null
}

describe('响应式断点一致性', () => {
  const MOBILE = defaultBreakpoint()

  it('壳层的手机断点 = 页面组件的默认断点(两边分歧过一次,代价见文件头)', () => {
    const m = appVue.match(/const isMobile = useIsMobile\('\(max-width:\s*(\d+)px\)'\)/)
    expect(m, 'App.vue 的 isMobile 声明形状变了').not.toBeNull()
    expect(Number(m![1])).toBe(MOBILE)
  })

  it('平板档紧接手机档,中间不留空隙也不重叠', () => {
    const m = appVue.match(/const isTablet = useIsMobile\('\(min-width:\s*(\d+)px\) and \(max-width:\s*(\d+)px\)'\)/)
    expect(m, 'App.vue 的 isTablet 声明形状变了').not.toBeNull()
    const [min, max] = [Number(m![1]), Number(m![2])]
    expect(min).toBe(MOBILE + 1) // 空隙 = 那个宽度既不是手机也不是平板,壳层形态未定义
    expect(max).toBeGreaterThan(min)
  })

  it('off-canvas 抽屉侧栏只在手机档生效 —— 平板/折叠屏要常驻侧栏', () => {
    const offCanvas = mediaBlocks().filter((b) => /\.app-sidebar\s*\{[^}]*position:\s*fixed/.test(b.body))
    expect(offCanvas.length, '找不到 off-canvas 侧栏的媒体查询,结构变了就更新本测试').toBeGreaterThan(0)
    for (const b of offCanvas) {
      expect(maxWidthOf(b.cond), `off-canvas 块的条件不是 max-width:${b.cond}`).toBe(MOBILE)
    }
  })

  it('★不许在比手机档更宽的媒体查询里把 .filter-bar 改成 column —— 那会让筛选项往右溢出到够不着', () => {
    const offenders = mediaBlocks()
      .filter((b) => {
        const mw = maxWidthOf(b.cond)
        return mw !== null && mw > MOBILE
      })
      .filter((b) => /\.filter-bar\s*\{[^}]*flex-direction:\s*column/.test(b.body))
      .map((b) => b.cond)
    expect(offenders, '这些媒体查询会重现 2026-08-02 那个「筛选项够不着」的 bug').toEqual([])
  })

  it('FilterBar 用的是默认断点(不传参),否则上面几条就白钉了', () => {
    expect(filterBarVue).toMatch(/useIsMobile\(\)/)
  })

  it('★组件 scoped 里 769–1100 区间的 max-width 断点必须显式带下界(存量记基线,不得新增)', () => {
    // 为什么:`@media (max-width: 900px)` 命中的是「900 以下的一切」,包括手机。
    // 而页面级 DOM 切换(useIsMobile)在 768 —— 769–900 这一段就成了
    // 「桌面 DOM + 这块自定 CSS」的混合体,正是文件头那个 2026-08-02 bug 的形状。
    // 给这类平板档特调**显式写上 `(min-width: 769px)`**,手机样式留在标准 ≤768 块里,
    // 两套形态就不会再互相渗透。
    // ★基线按「文件 → 条数」记,不记行号(行号一改基线就腐烂,教训见
    //   memory: source-scanning-guards-are-not-tests 的基线式写法)。
    //   存量 28 个文件是 2026-08-27 盘点的 18+ 个自定断点的现状,逐步归三档;新增直接红。
    const counts = new Map<string, number>()
    // 只扫应用源码三目录 —— website/ 是独立的官网应用,断点体系不同,不归这条管
    const scanDirs = ['src', 'core', 'modules'].flatMap((d) => walkVue(join(root, d)))
    for (const file of scanDirs) {
      const text = readFileSync(file, 'utf8')
      let n = 0
      for (const m of text.matchAll(/@media[^{]*max-width:\s*(\d+)px[^{]*\{/g)) {
        const w = Number(m[1])
        if (w > MOBILE && w <= 1100 && !m[0].includes('min-width')) n += 1
      }
      if (n > 0) counts.set(relative(root, file), n)
    }
    const offenders: string[] = []
    for (const [file, n] of counts) {
      const base = SCOPED_BREAKPOINT_BASELINE[file] ?? 0
      if (n > base) offenders.push(`${file}: ${n} 处(基线 ${base})`)
    }
    expect(
      offenders,
      '新增的平板档 max-width 断点要写成 `@media (min-width: 769px) and (max-width: …)`,' +
        '或直接用标准三档(≤768 / 769–1100 / >1100)。真在还基线债时把 SCOPED_BREAKPOINT_BASELINE 里的数字改小。',
    ).toEqual([])
  })
})

function walkVue(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkVue(p, out)
    else if (e.isFile() && e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 2026-08-27 存量(28 个文件)。只许变小,新增/变大直接红。 */
const SCOPED_BREAKPOINT_BASELINE: Record<string, number> = {
  'modules/aiagent/ui/AiAgentDetail.vue': 1,
  'modules/app-settings/ui/LlmConfig.vue': 1,
  'modules/pcb-cam/ui/PcbCamWorkspace.vue': 1,
  'modules/pcb-cam/ui/parts/TimeScrub.vue': 1,
  'modules/app-settings/ui/SixamBilling.vue': 1,
  'modules/askai/ui/AskAiChat.vue': 1,
  'modules/askai/ui/AskAiPage.vue': 1,
  'modules/attendance/ui/CheckinPage.vue': 1,
  'modules/crm-dashboard/ui/CrmDashboard.vue': 1,
  'modules/document/ui/ApprovalInbox.vue': 1,
  'modules/feedback/ui/FeedbackWidget.vue': 1,
  'modules/finance/ui/AccountManagement.vue': 1,
  'modules/finance/ui/AssetsPanel.vue': 1,
  'modules/finance/ui/BudgetPanel.vue': 1,
  'modules/finance/ui/ConsolidationPanel.vue': 1,
  'modules/finance/ui/FinanceReportConfig.vue': 1,
  'modules/finance/ui/RevenueRecognitionPanel.vue': 1,
  'modules/finance/ui/TaxInvoicesPanel.vue': 2,
  'modules/finance/ui/voucher-template/VoucherAmountBuilder.vue': 1,
  'modules/finance/ui/voucher-template/VoucherConditionBuilder.vue': 1,
  'modules/finance/ui/voucher-template/VoucherTemplateEditor.vue': 1,
  'modules/finance/ui/voucher-template/VoucherTemplateList.vue': 1,
  'modules/finance/ui/voucher-template/VoucherTemplateReview.vue': 1,
  'modules/hr-core/ui/HrRoster.vue': 1,
  'modules/payment-voucher/ui/PaymentVoucherWorkspace.vue': 1,
  'modules/seal-ledger/ui/SealLedgerWorkspace.vue': 1,
  'modules/superindividual/ui/InboxPage.vue': 1,
  'modules/superindividual/ui/SuperindividualHub.vue': 2,
  'modules/user-guide/ui/UserGuidePage.vue': 1,
  'modules/website/ui/WebsiteAdmin.vue': 2,
}
