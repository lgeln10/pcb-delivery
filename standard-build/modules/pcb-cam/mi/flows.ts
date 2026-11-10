// modules/pcb-cam/mi/flows.ts
// MI 工艺流程单:板型判定(确定性规则)→ 工序链模板。模板数据抄自 pcb 仓 knowledge/rules/mi_flow_templates.yaml
// (《CAM工程技能培训》第 17 章 p212–219),每条带 sourcePage;LLM 不参与工序增删,只可在别处润色说明文字。
import type { PcbCamJob } from '../model'

export type MiFlowTemplate = {
  id: string
  boardType: string
  category: string
  sourcePage: number
  steps: string[]
  requirements?: string[]
  note?: string
}

export const MI_FLOW_TEMPLATES: MiFlowTemplate[] = [
  { id: 'mi.flow.bare_board', boardType: '光板', category: '1、光板、单面板（包括假双面板）加工流程', sourcePage: 212,
    steps: ['开料', '钻孔', '负片蚀刻', '成型', '终检', '包装', '入库出货'],
    note: '光板开单面料蚀刻成光板，单面板开单面料，假双面开双面料，铜厚按照成品铜厚开料。不需要做电镀。' },
  { id: 'mi.flow.single_side', boardType: '单面板（包括假双面板）', category: '1、光板、单面板（包括假双面板）加工流程', sourcePage: 212,
    steps: ['开料', '钻孔', '图形转移', '负片蚀刻', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '光板开单面料蚀刻成光板，单面板开单面料，假双面开双面料，铜厚按照成品铜厚开料。不需要做电镀。' },
  { id: 'mi.flow.pattern_plating.double_side', boardType: '双面板（普通喷锡/沉金工艺为例）', category: '2、图形电镀加工流程（正片）', sourcePage: 212,
    steps: ['开料', '钻孔', '沉铜/板电', '图形转移', '图形电镀', '蚀刻/退锡', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '双面板开料按成品板厚减0.1mm成品铜厚减去H/HOZ，多层板看内层铜厚板厚去开料。图形电镀注意写电镀面积' },
  { id: 'mi.flow.pattern_plating.multilayer', boardType: '多层板（普通喷锡/沉金工艺为例）', category: '2、图形电镀加工流程（正片）', sourcePage: 212,
    steps: ['开料', '内层线路', '蚀刻', 'AOI测试', '压合', '钻孔', '除胶渣', '沉铜/板电', '图形转移', '图形电镀', '蚀刻/退锡', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '双面板开料按成品板厚减0.1mm成品铜厚减去H/HOZ，多层板看内层铜厚板厚去开料。图形电镀注意写电镀面积' },
  { id: 'mi.flow.panel_plating.double_side', boardType: '双面板（普通喷锡/沉金工艺为例）', category: '3、整板电镀加工流程（负片）', sourcePage: 212,
    steps: ['开料', '钻孔', '沉铜', '整板电镀', '图形转移', '蚀刻', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '双面板开料按成品板厚减0.1mm成品铜厚减去H/Hzo，多层板看内层铜厚板厚去开料。' },
  { id: 'mi.flow.panel_plating.multilayer', boardType: '多层板（普通喷锡/沉金工艺为例）', category: '3、整板电镀加工流程（负片）', sourcePage: 212,
    steps: ['开料', '内层线路', '蚀刻', 'AOI测试', '压合', '钻孔', '除胶渣', '沉铜', '整板电镀', '图形转移', '蚀刻', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '双面板开料按成品板厚减0.1mm成品铜厚减去H/Hzo，多层板看内层铜厚板厚去开料。' },
  { id: 'mi.flow.second_drill.positive', boardType: '正片（双面板为例）', category: '4、干膜关于二钻流程', sourcePage: 212,
    steps: ['开料', '钻孔', '沉铜/板电', '图形转移', '图形电镀', '二钻/锣半孔', '蚀刻/退锡', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '正片二钻或者锣半孔的流程在蚀刻前，二钻与锣半孔拉起来的铜皮毛刺，后面才能把它蚀刻掉' },
  { id: 'mi.flow.second_drill.negative', boardType: '负片（双面板为例）', category: '4、干膜关于二钻流程', sourcePage: 212,
    steps: ['开料', '钻孔', '沉铜', '整板电镀', '图形转移', '蚀刻', '阻焊', '字符', '二钻', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '负片的二钻不能放在蚀刻前，因负片不用镀锡，线路没有锡保护会刮伤线路，所以负片的二钻在表面处理前钻孔。' },
  { id: 'mi.flow.half_hole', boardType: '半孔', category: '5、半孔与金属包边流程', sourcePage: 212,
    steps: ['开料', '钻孔', '沉铜/板电', '图形转移', '图形电镀', '二钻/锣半孔', '蚀刻/退锡', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '半孔与金属包边的都需做正片' },
  { id: 'mi.flow.metal_edge', boardType: '金属包边', category: '5、半孔与金属包边流程', sourcePage: 212,
    steps: ['开料', '钻孔', '金属包边', '沉铜/板电', '图形转移', '图形电镀', '二钻/锣半孔', '蚀刻/退锡', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '半孔与金属包边的都需做正片' },
  { id: 'mi.flow.stack_bare_board', boardType: '叠层加光板（假八层负片为例）', category: '6、叠层加光板流程', sourcePage: 213,
    steps: ['开料', '蚀刻成光板', '钻铆钉孔', '内层线路', '蚀刻', 'AOI测试', '压合', '钻孔', '除胶渣', '沉铜', '整板电镀', '图形转移', '蚀刻', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '多层板中间加光板，需先开光板厚度的料，蚀刻成光板再把铆钉与靶孔钻出来，否则光板压合无法铆合。' },
  { id: 'mi.flow.via_in_pad', boardType: '盘中孔（双面板负片为例）', category: '7、盘中孔流程', sourcePage: 213,
    steps: ['钻盘中孔', '1次沉铜', '1次整板电镀', '树脂塞孔', '打磨', '减铜', '开料', '钻孔', '2沉铜', '2整板电镀', '图形转移', '蚀刻', '阻焊', '字符', '表面处理', '成型', '测试', '终检', '包装', '入库出货'],
    note: '塞完树脂打磨，注意减铜' },
  { id: 'mi.flow.hard_gold', boardType: '电金（双面板正片为例）', category: '8、整版电金流程', sourcePage: 213,
    steps: ['开料', '钻孔', '沉铜/板电', '图形转移', '图形电镀', '镀金', '蚀刻/退锡', '阻焊', '字符', '成型', '测试', '终检', '包装', '入库出货'],
    note: '电金菲林，需把其他地方盖住，流出要电金的位置焊盘' },
  { id: 'mi.flow.hard_gold_plus_enig', boardType: '电金+沉金（双面板正片为例）', category: '9、整版电金+沉金流程', sourcePage: 213,
    steps: ['开料', '钻孔', '沉铜/板电', '图形转移', '图形电镀', '镀金', '蚀刻/退锡', '阻焊', '字符', '印选化油', '沉镍金', '退选化油', '成型', '测试', '终检', '包装', '入库出货'],
    note: '电金菲林按照线路焊盘一比一掏开，其他地方盖住，印选化油菲林比线路焊盘大单边2mil' },
  { id: 'mi.flow.hdi.4L_blind_buried', boardType: '四层盲埋孔板', category: '4层一阶盲埋孔（激光/机械）混合型', sourcePage: 214,
    steps: ['开料', '钻埋孔', '沉铜', '整板电镀', '树脂塞孔', '内层线路', '蚀刻', '测试', '压合', '铣毛边', '激光钻孔', '电镀填孔', '钻孔', '以下正常流程'],
    requirements: ['开料：开一张芯板（要求内层成品铜厚1/1oz时正常镀埋孔，内层成品铜厚H/Hoz，需开料后减铜至1/3oz）', '钻埋孔：钻带L2-L3：程序', '沉铜：背光9级', '整板电镀：注意成品铜厚', '树脂塞孔：树脂塞埋孔（打磨树脂，磨平）', '内层线路：注意写线宽线距，L2,L3线路文件', '测试：AOI测试!', '压合：注意成品板厚', '铣毛边：工艺边控制10mm', '激光钻孔：钻带L1-L2，L3-L4：程序（此过程分清L1-L2：L3-L4钻带，避免钻错）', '电镀填孔：电镀填平', '钻孔：钻带通孔程序'] },
  { id: 'mi.flow.hdi.4L_blind', boardType: '四层盲孔', category: '4层一阶盲孔（机械钻孔）', sourcePage: 215,
    steps: ['开料', '钻孔', '沉铜', '整板电镀', '树脂塞孔', '内层线路', '蚀刻', '测试', '压合', '铣毛边', '减铜', '钻孔', '以下正常流程'],
    requirements: ['开料：开2张芯板', '钻孔：钻带L1-2;L3-4)：程序', '沉铜：背光9级', '整板电镀：注意成品铜厚', '树脂塞孔：树脂塞埋孔（打磨树脂，磨平）', '内层线路：注意写线宽线距，L2,L3线路文件（GTL/GBL做保护菲林）', '测试：AOI测试!', '压合：注意成品板厚', '铣毛边：工艺边控制10mm', '减铜：GTL/GBL减至1/3OZ', '钻孔：钻带通孔程序'] },
  { id: 'mi.flow.hdi.6L_2stage', boardType: '六层板 盲埋孔板', category: '6层二阶盲孔（激光/机械）混合型', sourcePage: 216,
    steps: ['开料', '一次钻埋孔', '沉铜', '整板电镀', '树脂塞孔', '内层线路', '蚀刻', '测试', '一次压合', '铣毛边', '一次激光钻孔', '电镀填孔', '二次钻埋孔', '沉铜', '整板电镀', '树脂塞孔', '内层线路', '蚀刻', '测试', '二次压合', '铣毛边', '二次激光钻孔', '电镀填孔', '钻孔', '以下正常流程'],
    requirements: ['开料：开一张芯板（要求内层成品铜厚1/1oz时正常镀埋孔，内层成品铜厚H/Hoz，需开料后减铜至1/3oz）', '一次钻埋孔：钻带L3-L4：程序', '沉铜：背光9级', '整板电镀：注意成品铜厚', '树脂塞孔：树脂塞埋孔（打磨树脂，磨平）', '内层线路：注意写线宽线距，L3,L4线路文件', '测试：AOI测试!', '一次压合：注意成品板厚（L2压L3层,L5压L4层,工艺边注意多加一套靶孔）', '铣毛边：工艺边控制12mm', '一次激光钻孔：钻带L2-L3，L4-L5：程序（此过程分清L2-L3：L4-L5钻带，避免钻错）', '电镀填孔：电镀填平', '二次钻埋孔：钻带L3-L4：程序', '内层线路：注意写线宽线距，L2,L5线路文件', '二次压合：注意成品板厚（L1压L2层,L6压L5层）', '二次激光钻孔：钻带L1-L2，L5-L6：程序（此过程分清L1-L2：L5-L6钻带，避免钻错）', '钻孔：钻带通孔程序'] },
  { id: 'mi.flow.hdi.6L_1stage', boardType: '六层板 盲埋孔', category: '6层一阶盲孔（激光/机械）混合型', sourcePage: 218,
    steps: ['开料', '内层线路', '蚀刻', '测试', '一次压合', '铣毛边', '钻埋孔', '沉铜/板电', '树脂塞孔', '内层线路', '蚀刻', '测试', '二次压合', '铣毛边', '激光钻孔', '电镀填孔', '钻孔', '以下正常流程'],
    requirements: ['开料：开一张芯板', '内层线路：注意写线宽线距，L3,L4线路文件', '测试：AOI测试!', '一次压合：注意成品板厚', '铣毛边：工艺边控制12mm', '钻埋孔：钻带L2-5埋孔：程序', '沉铜/板电：背光9级', '树脂塞孔：钻带L2-5：程序', '内层线路：L2&L5线路', '二次压合：注意成品板厚（L1压L2层,L6压L5层）', '激光钻孔：钻带L1-L2，L5-L6：程序（此过程分清L1-L2：L5-L6钻带，避免钻错）', '电镀填孔：电镀填平', '钻孔：钻带通孔程序'] },
]

const BY_ID = new Map(MI_FLOW_TEMPLATES.map((t) => [t.id, t]))

import { buildImpedanceSheet, type ImpedanceSheet } from './impedance'

export type BoardFacts = {
  copperLayers: number | null
  hasBlindBuried: boolean
  blindSpans: string[]
  polarity: 'positive' | 'negative'
  special: string[]
  surfaceFinish: string | null
  viaPlugging: string | null
}

export type MiSheet = {
  flowId: string
  boardType: string
  category: string
  sourcePage: number
  steps: string[]
  requirements: string[]
  note: string | null
  facts: BoardFacts
  reasons: string[]
  warnings: string[]
  /** 第 15 章阻抗取值表;附件无阻抗要求时为 null */
  impedance: ImpedanceSheet | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 从 layer_map(worker 产出,人确认后)+ order_spec(人确认后)提取判定事实。任一缺失都能跑,只是置信度低。 */
export function boardFacts(job: Pick<PcbCamJob, 'layerMap' | 'orderSpec' | 'orderSpecCandidate'>): BoardFacts {
  const lm = (job.layerMap ?? {}) as { files?: Array<{ type?: string; drill_span?: string | number[] | null }>; stackup?: { copper_layers?: number } }
  const spec = (job.orderSpec ?? job.orderSpecCandidate ?? {}) as Record<string, unknown>
  const files = Array.isArray(lm.files) ? lm.files : []
  const copperFromMap = num(lm.stackup?.copper_layers) ?? (files.filter((f) => f.type === 'top_copper' || f.type === 'bottom_copper' || f.type === 'inner_copper').length || null)
  const copperLayers = num(spec.layers) ?? copperFromMap
  // worker 存的是 [a, b];String([2,3]) 会变成 "2,3",下面的模板判定按 "2-3" 匹配,所以统一成 a-b
  const blindSpans = files.filter((f) => f.type === 'drill_blind' && f.drill_span).map((f) => (Array.isArray(f.drill_span) ? f.drill_span.join('-') : String(f.drill_span)))
  const special = arr(spec.special_process)
  const specialText = [...special, str(spec.surface_finish) ?? '', str(spec.panelization) ?? '', ...arr(spec.customer_notes)].join(' ')
  const hasBlindBuried = blindSpans.length > 0 || /盲|埋|HDI/i.test(specialText)
  const polarity: 'positive' | 'negative' = /负片|整板电镀/.test(specialText) || str(spec.polarity) === 'negative' ? 'negative' : 'positive'
  return {
    copperLayers,
    hasBlindBuried,
    blindSpans,
    polarity,
    special,
    surfaceFinish: str(spec.surface_finish),
    viaPlugging: str(spec.via_plugging),
  }
}

/** 板型 → 模板(纯函数,规则来自第 17 章)。规则顺序 = 优先级:特殊工艺先于普通板型。 */
export function selectFlow(f: BoardFacts): { template: MiFlowTemplate; reasons: string[]; warnings: string[] } {
  const reasons: string[] = []
  const warnings: string[] = []
  const text = [...f.special, f.surfaceFinish ?? '', f.viaPlugging ?? ''].join(' ')
  const has = (re: RegExp) => re.test(text)
  const pick = (id: string, why: string) => {
    reasons.push(why)
    return BY_ID.get(id)!
  }

  if (f.hasBlindBuried) {
    if (f.copperLayers === 4) {
      const buried = f.blindSpans.some((s) => /2-3|L2-L3/i.test(s))
      const t = buried ? pick('mi.flow.hdi.4L_blind_buried', '4 层且含 L2-L3 埋孔 → 4 层一阶盲埋孔(p214)') : pick('mi.flow.hdi.4L_blind', '4 层盲孔无埋孔 → 4 层一阶盲孔(p215)')
      return { template: t, reasons, warnings }
    }
    if (f.copperLayers === 6) {
      const twoStage = f.blindSpans.some((s) => /2-3|4-5|L2-L3|L4-L5/i.test(s))
      const t = twoStage ? pick('mi.flow.hdi.6L_2stage', '6 层且含 L2-L3/L4-L5 盲孔 → 6 层二阶(p216)') : pick('mi.flow.hdi.6L_1stage', '6 层一阶盲埋孔(p218)')
      return { template: t, reasons, warnings }
    }
    warnings.push(`盲埋孔板 ${f.copperLayers ?? '?'} 层:培训文档只给了 4/6 层模板,按多层正片流程出单,叠层分步流程需工程师按第 16 章 p207 手工编写`)
    return { template: pick('mi.flow.pattern_plating.multilayer', '盲埋孔但层数无对应模板 → 多层正片(p212)'), reasons, warnings }
  }
  if (has(/电金|硬金|镀金/) && has(/沉金|ENIG/i)) return { template: pick('mi.flow.hard_gold_plus_enig', '电金 + 沉金 → 整版电金+沉金(p213)'), reasons, warnings }
  if (has(/电金|硬金|金手指/)) {
    if (has(/金手指/) && !has(/电金|硬金/)) warnings.push('金手指通常需电镀硬金(第 12 章 p160);表面处理未写明电金,请与客户确认')
    return { template: pick('mi.flow.hard_gold', '电金/金手指 → 整版电金(p213)'), reasons, warnings }
  }
  if (has(/金属包边/)) return { template: pick('mi.flow.metal_edge', '金属包边 → 需做正片(p212)'), reasons, warnings }
  if (has(/半孔/)) return { template: pick('mi.flow.half_hole', '半孔 → 需做正片(p212)'), reasons, warnings }
  if (has(/盘中孔|via.?in.?pad/i)) return { template: pick('mi.flow.via_in_pad', '盘中孔 → 盘中孔流程(p213)'), reasons, warnings }
  if (has(/二钻/)) {
    return f.polarity === 'negative'
      ? { template: pick('mi.flow.second_drill.negative', '二钻 + 负片 → 二钻在表面处理前(p212)'), reasons, warnings }
      : { template: pick('mi.flow.second_drill.positive', '二钻 + 正片 → 二钻在蚀刻前(p212)'), reasons, warnings }
  }
  if (has(/光板/) || f.copperLayers === 0) return { template: pick('mi.flow.bare_board', '光板(p212)'), reasons, warnings }
  if (f.copperLayers === 1) return { template: pick('mi.flow.single_side', '单面板(p212)'), reasons, warnings }
  if (f.copperLayers === null) {
    warnings.push('层数未知(层识别或规格里都没有),按双面正片出单,请确认')
    return { template: pick('mi.flow.pattern_plating.double_side', '层数未知 → 默认双面正片(p212)'), reasons, warnings }
  }
  if (f.copperLayers === 2) {
    return f.polarity === 'negative'
      ? { template: pick('mi.flow.panel_plating.double_side', '双面负片 → 整板电镀(p212)'), reasons, warnings }
      : { template: pick('mi.flow.pattern_plating.double_side', '双面正片 → 图形电镀(p212)'), reasons, warnings }
  }
  if (f.copperLayers % 2 === 1) warnings.push(`铜层数 ${f.copperLayers} 为奇数,多半是层识别有误,请回到「层确认」核对`)
  return f.polarity === 'negative'
    ? { template: pick('mi.flow.panel_plating.multilayer', `${f.copperLayers} 层负片 → 整板电镀(p212)`), reasons, warnings }
    : { template: pick('mi.flow.pattern_plating.multilayer', `${f.copperLayers} 层正片 → 图形电镀(p212)`), reasons, warnings }
}

export function buildMiSheet(job: Pick<PcbCamJob, 'layerMap' | 'orderSpec' | 'orderSpecCandidate'>): MiSheet {
  const facts = boardFacts(job)
  const { template, reasons, warnings } = selectFlow(facts)
  if (!job.orderSpec) warnings.push('制作规格尚未确认,流程单按候选/默认值生成,确认规格后会重算')
  return {
    flowId: template.id,
    boardType: template.boardType,
    category: template.category,
    sourcePage: template.sourcePage,
    steps: [...template.steps],
    requirements: [...(template.requirements ?? [])],
    note: template.note ?? null,
    facts,
    reasons,
    warnings,
    impedance: buildImpedanceSheet((job.orderSpec ?? job.orderSpecCandidate ?? null) as Record<string, unknown> | null, facts.copperLayers),
  }
}

/** 给人看/下载的 HTML(自包含,无外链;样式只用内联,打印即 PDF)。 */
export function renderMiSheetHtml(sheet: MiSheet, meta: { projectName: string; jobId: string; customerName?: string | null; generatedAt: Date }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const steps = sheet.steps.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s)}</td><td>${esc(sheet.requirements.find((r) => r.startsWith(s + '：') || r.startsWith(s + ':'))?.split(/[：:]/).slice(1).join('：') ?? '')}</td></tr>`).join('')
  const f = sheet.facts
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>MI 工艺流程单 · ${esc(meta.projectName)}</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px 8px;font-size:13px;text-align:left;vertical-align:top}th{background:#f2f2f2}.meta{font-size:12px;color:#444}.warn{color:#b45309}.small{font-size:12px;color:#555}@media print{body{margin:10mm}}</style></head><body>
<h1>MI 工艺流程单</h1>
<p class="meta">项目:${esc(meta.projectName)}${meta.customerName ? ` · 客户:${esc(meta.customerName)}` : ''} · 任务:${esc(meta.jobId.slice(0, 8))} · 生成:${meta.generatedAt.toISOString().replace('T', ' ').slice(0, 16)}</p>
<h2>板型判定</h2>
<table><tr><th>板型</th><td>${esc(sheet.boardType)}</td><th>流程类别</th><td>${esc(sheet.category)}(培训文档 p${sheet.sourcePage})</td></tr>
<tr><th>铜层数</th><td>${f.copperLayers ?? '未知'}</td><th>极性</th><td>${f.polarity === 'negative' ? '负片(整板电镀)' : '正片(图形电镀)'}</td></tr>
<tr><th>表面处理</th><td>${esc(f.surfaceFinish ?? '未写明')}</td><th>特殊工艺</th><td>${esc(f.special.join('、') || '无')}${f.blindSpans.length ? ` · 盲埋孔 ${esc(f.blindSpans.join(', '))}` : ''}</td></tr></table>
<p class="small">判定依据:${esc(sheet.reasons.join(';') || '-')}</p>
${sheet.warnings.length ? `<p class="warn">⚠ ${sheet.warnings.map(esc).join('<br>⚠ ')}</p>` : ''}
<h2>工序流程</h2>
<table><tr><th style="width:3em">序号</th><th style="width:12em">工序</th><th>制作要求 / 备注</th></tr>${steps}</table>
${sheet.note ? `<p class="small">备注:${esc(sheet.note)}</p>` : ''}
${sheet.impedance ? `<h2>阻抗取值(第 15 章)</h2>
<table><tr><th>层</th><th>类型</th><th>目标 Ω</th><th>W1 线底 mil</th><th>W2 线面 mil</th><th>S1 mil</th><th>T1 um</th><th>计算模型</th></tr>${sheet.impedance.rows
    .map((r) => `<tr><td>${esc(r.layer)}</td><td>${r.type}</td><td>${r.targetOhm ?? '-'}</td><td>${r.w1Mil ?? '-'}</td><td>${r.w2Mil ?? '-'}</td><td>${r.s1Mil ?? '-'}</td><td>${r.t1Um}<br><span class="small">${esc(r.t1Note)}</span></td><td>${esc(r.model)}</td></tr>`)
    .join('')}</table>
<p class="small">阻焊:C1 ${sheet.impedance.soldermask.c1Um} / C2 ${sheet.impedance.soldermask.c2Um} / C3 ${sheet.impedance.soldermask.c3Um} um,CEr ${sheet.impedance.soldermask.cer};${esc(sheet.impedance.soldermask.note)}</p>
<p class="small">${sheet.impedance.notes.map(esc).join('<br>')}</p>` : ''}
<p class="small">本单由 PCB CAM 模块按《CAM工程技能培训》第 17 章模板生成,工序顺序未经 AI 改动;工厂标准与客户要求以 MI 签核为准。</p>
</body></html>`
}
