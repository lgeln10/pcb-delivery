// 界面「结构一致性」的三条护栏(扫源码,同 drawer-width-contract.test.ts 的做法)。
//
// ★为什么值得写:这三件事都属于「同一件事全站长一个样」,而它们回潮时**不报错、不失败、
//   只是某一页长得跟别处不一样** —— 只有把它写成断言才拦得住下一个人再写一遍。
//   2026-08-27 的全量盘点里,这三条各自的实况是:
//   ① 抽屉底栏 —— 4 个抽屉裸写 `#footer`(没有 .drawer-footer),按钮既不 sticky 也不右对齐;
//   ② 只读详情 —— 15 处抽屉里还在用 el-descriptions:一个字段占一整行、label 单元格固定吃掉
//      约三成宽,客户详情实测 18 个字段 521px 高,其中 8 个是空的(UI_SPEC 详情抽屉一节);
//   ③ 页内大标题 —— 顶栏已经有一个由导航项 label 驱动的 <h1>,页面里再写一个就是两个 h1,
//      视觉上重复、语义上一页两个主标题(UI_SPEC §2.5「新增页面不另搭标题区」);
//   ④ 打开即聚焦 —— UI_SPEC §7 第一条要求「打开即聚焦首字段」,而实况是
//      **36 个抽屉 0 个聚焦**:点「新建」抽屉滑出来,光标不在任何地方,每次录入先多一次点击。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'core', 'modules']

/** 只有「渲染成一份可打印文档」的地方才允许自带 h1 —— 那个 h1 是文档的标题,不是页面的。 */
const H1_ALLOWLIST: Record<string, string> = {
  'modules/opportunity/ui/QuoteDocEditor.vue': '报价单文档版式(纸张视图),h1 是单据抬头',
  'modules/finance/ui/FinanceWorkspace.vue': '打印窗口的 HTML 字符串(报表/总账),不在应用 DOM 里',
  'modules/reimbursement/ui/Reimbursements.vue': '打印窗口的 HTML 字符串(报销单),不在应用 DOM 里',
  'src/App.vue': '顶栏那一个 —— 全应用唯一的页面标题,由导航项 label 驱动',
  'src/pages/LoginPage.vue': '登录页没有顶栏,它自己就是那一屏的主标题',
}

/**
 * 不该自动聚焦的抽屉,连同理由。**按文件路径豁免,不记行号** —— 行号一改就得回来改这份清单,
 * 而它要记的是「这个抽屉为什么不聚焦」,不是它在第几行(同一条教训见传播扫描的基线写法)。
 * 代价是同一个文件里以后新加的表单抽屉不会被这条逮到;换来的是这份清单不会腐烂。
 */
const AUTOFOCUS_EXEMPT: Record<string, string> = {
  'modules/finance/ui/BankReconPanel.vue': '导入对账单流水:第一步是点「选择 Excel/CSV」挑文件,不是打字',
  'modules/finance/ui/FinanceWorkspace.vue': '凭证详情:只读,里面的 FormField 是拿来展示的(同文件的「新增凭证」已挂)',
  'modules/finance/ui/RevenueRecognitionPanel.vue': '收入确认详情:只读',
  'modules/hr-core/ui/HrRoster.vue': '员工详情:只读(编辑档案另开抽屉)',
  'modules/opportunity/ui/OpportunityBoard.vue': '商机详情:只读 + 页签,进来先看不先填(同文件的「新建商机」已挂)',
  'modules/payment-voucher/ui/PaymentVoucherWorkspace.vue': '付款凭证详情:只读(同文件的「新建付款凭证」已挂)',
  'modules/reimbursement/ui/Reimbursements.vue': '报销详情:只读(同文件的「新建报销单」已挂)',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

function vueFiles(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(join(root, dir))) {
      out.push({ file: relative(root, abs), text: readFileSync(abs, 'utf8') })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * 取出每个 `<el-drawer>` … `</el-drawer>` 的整段文本(按同名标签配对计深度,兼容抽屉套抽屉)。
 * 用文本切段而不是解析 AST:护栏要的是「写法」而不是运行结果,而且和另外两条护栏保持同一种做法。
 */
function drawerBlocks(text: string): string[] {
  const tag = /<\/?(?:el-drawer|ElDrawer)\b/g
  const blocks: string[] = []
  const opens = [...text.matchAll(/<(?:el-drawer|ElDrawer)\b/g)].map((m) => m.index)
  for (const start of opens) {
    tag.lastIndex = start
    let depth = 0
    for (let m = tag.exec(text); m; m = tag.exec(text)) {
      if (m[0].startsWith('</')) {
        depth -= 1
        if (depth === 0) {
          blocks.push(text.slice(start, m.index))
          break
        }
      } else {
        depth += 1
      }
    }
  }
  return blocks
}

describe('界面结构契约', () => {
  it('抽屉的 #footer 第一个元素必须是全局 .drawer-footer,不许各页自拼底栏', () => {
    const offenders: string[] = []
    for (const { file, text } of vueFiles()) {
      for (const block of drawerBlocks(text)) {
        const foot = /<template\s+#footer\s*>/.exec(block)
        if (!foot) continue // 纯只读抽屉可以没有底栏;这条只管「有底栏的写法对不对」
        const rest = block.slice(foot.index + foot[0].length)
        const first = /<\s*([A-Za-z][\w.-]*)([^>]*?)>/.exec(rest)
        if (!first) {
          offenders.push(`${file}: #footer 是空的`)
          continue
        }
        const cls = /class\s*=\s*"([^"]*)"/.exec(first[2]!)?.[1] ?? ''
        if (!cls.split(/\s+/).includes('drawer-footer')) {
          offenders.push(`${file}: #footer 首元素是 <${first[1]} class="${cls}">`)
        }
      }
    }
    expect(
      offenders,
      '抽屉底栏一律 `<template #footer><div class="drawer-footer">…`(UI_SPEC §2.5 详情/编辑抽屉)',
    ).toEqual([])
  })

  it('抽屉里不许再用 el-descriptions 展示单条记录的属性,用 .dl 字段网格', () => {
    const offenders: string[] = []
    for (const { file, text } of vueFiles()) {
      for (const block of drawerBlocks(text)) {
        // ★`\b` 在这里不够:`<el-descriptions-item` 也过 —— 会把每个字段都算成一处违规,
        //   数字虚高十倍。要显式排除后面还跟着 `-`/字母的情况。
        const n = [...block.matchAll(/<(?:el-descriptions|ElDescriptions)(?![-\w])/g)].length
        if (n > 0) offenders.push(`${file}: 抽屉内有 ${n} 处 el-descriptions`)
      }
    }
    expect(
      offenders,
      'el-descriptions 是 <table>:一个字段占一整行、label 单元格固定吃掉约三成宽,还会在窄屏内部横滚。' +
        '一条记录的属性不需要对齐成表 —— 改用 `.dl > .dl__i > (.dl__k + .dl__v)`,样板见 PartnerManagement.vue。',
    ).toEqual([])
  })

  it('带录入表单的抽屉必须挂 v-drawer-autofocus —— 打开即聚焦首字段', () => {
    const offenders: string[] = []
    for (const { file, text } of vueFiles()) {
      for (const block of drawerBlocks(text)) {
        // 「里面有可写表单」的判据:出现 FormField / el-form / .form-grid 任一
        if (!/<FormField|<el-form\b|form-grid/.test(block)) continue
        if (block.includes('v-drawer-autofocus')) continue
        if (file in AUTOFOCUS_EXEMPT) continue
        const line = text.slice(0, text.indexOf(block)).split('\n').length
        offenders.push(`${file}:${line}`)
      }
    }
    expect(
      offenders,
      '把 v-drawer-autofocus 挂在抽屉里包表单的那个元素上(不是挂在 <el-drawer> 上 —— 它的根是 Teleport)。' +
        '确实不该聚焦的(只读详情、第一步是选文件的导入台)往 AUTOFOCUS_EXEMPT 加一行并写明理由。',
    ).toEqual([])
  })

  it('页面里不许再写 <h1> —— 页面标题由顶栏的导航项 label 驱动', () => {
    const offenders: string[] = []
    for (const { file, text } of vueFiles()) {
      if (file in H1_ALLOWLIST) continue
      const n = [...text.matchAll(/<h1[\s>]/g)].length
      if (n > 0) offenders.push(`${file}: ${n} 处 <h1>`)
    }
    expect(
      offenders,
      '顶栏已经有一个 <h1>(UI_SPEC §2.5)。页内区块标题用 <h2>/.panel-title,' +
        '引导语用 <p>;确实是「一份文档的抬头」才往 H1_ALLOWLIST 加一行并写明理由。',
    ).toEqual([])
  })

  // ⑤ 2026-08-27 加。手机上 <FilterBar> 把字段收进底部抽屉了 —— 收起态**看不见任何筛选条件**,
  //    页面必须把「当前生效了什么」报上来(:active),否则列表只剩两条时页面上没有任何交代,
  //    用户只会以为数据没了。这条不写成断言的话,下一个新列表页 100% 会忘,
  //    而忘了的表现是「筛选功能一切正常,只是看不出在筛」——不报错、不失败、没人报 bug。
  it('★每个 <FilterBar> 都要么传 :active,要么显式声明自己不是筛选(:collapsible="false")', () => {
    const offenders: string[] = []
    for (const { file, text } of vueFiles()) {
      if (file === 'core/ui-kit/FilterBar.vue') continue // 组件自己
      for (const m of text.matchAll(/<FilterBar\b[^>]*>/g)) {
        const tag = m[0]
        if (/:active\s*=/.test(tag)) continue
        if (/:collapsible\s*=\s*"false"/.test(tag)) continue
        offenders.push(`${file}: ${tag.replace(/\s+/g, ' ')}`)
      }
    }
    expect(
      offenders,
      '这些筛选栏在手机上会「筛了但看不出在筛」:\n' +
        offenders.join('\n') +
        '\n补一个 activeFilters computed 传给 :active(写法见 core/ui-kit/FilterBar.vue 的 active 注释);' +
        '若这一条其实是页面主控件而非可选筛选(如工资页「选员工→调薪」),传 :collapsible="false"。',
    ).toEqual([])
  })
})
