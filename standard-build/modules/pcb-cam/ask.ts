// modules/pcb-cam/ask.ts — 自然语言查板:「把内层小于 4mil 的线标出来」「这块板哪里改动最多」
// 先用规则把常见问法翻成 worker 的结构化查询(不用模型、零延迟);翻不出来才问大模型(场景 pcb_cam),
// 模型只输出结构化查询,不直接成为事实(MODULE.md 不变量 4:结果永远来自几何引擎的实测)。
import type { Ctx, Db } from '../../core/db/client'
import { buildTenantLLMCaller, type ChatMessage, type LLMCaller } from '../../core/llm/api'

export type BoardQuery = {
  what: 'features' | 'changes'
  layers?: string[]
  layer_types?: string[]
  feature?: 'line' | 'pad' | 'surface' | 'any'
  width_lt_mm?: number
  width_gt_mm?: number
  size_lt_mm?: number
  size_gt_mm?: number
  polarity?: 'dark' | 'clear'
  net?: string
  bbox?: [number, number, number, number]
  limit?: number
}

const LAYER_WORDS: Array<[RegExp, string[]]> = [
  [/内层/, ['inner_copper']],
  [/外层/, ['top_copper', 'bottom_copper']],
  [/顶层线路|顶层铜|顶层|正面|TOP/i, ['top_copper']],
  [/底层线路|底层铜|底层|反面|BOT/i, ['bottom_copper']],
  [/顶层阻焊|正面阻焊/, ['top_mask']],
  [/底层阻焊|反面阻焊/, ['bottom_mask']],
  [/阻焊|开窗|绿油/, ['top_mask', 'bottom_mask']],
  [/字符|丝印/, ['top_silk', 'bottom_silk']],
  [/铜层|线路层|所有层|全部层|整板/, ['top_copper', 'inner_copper', 'bottom_copper']],
]

/** 数字 + 单位 → mm;「4mil」「0.1mm」「4 mil」「0.15」(无单位:>2 当 mil,否则 mm) */
export function parseLength(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(mil|mm|毫米|密尔|um|微米)?/i)
  if (!m) return null
  const v = Number(m[1])
  const u = (m[2] ?? '').toLowerCase()
  if (u === 'mil' || u === '密尔') return v * 0.0254
  if (u === 'um' || u === '微米') return v / 1000
  if (u === 'mm' || u === '毫米') return v
  return v > 2 ? v * 0.0254 : v
}

/**
 * 规则翻译。识别:改动/动了/改了(→ changes);线/线宽/走线 + 小于/大于/窄于/宽于 N(→ line width);
 * 盘/焊盘/pad + 小于/大于 N(→ pad size);层名词;网名「XX 网」。认不出来返回 null。
 */
export function parseBoardQuestion(q: string): BoardQuery | null {
  const t = q.trim()
  if (!t) return null
  const types = LAYER_WORDS.filter(([re]) => re.test(t)).flatMap(([, ts]) => ts)
  const layer_types = types.length ? [...new Set(types)] : undefined
  if (/改动|改了|动了|动过|改过|变化|变动|修改/.test(t)) return { what: 'changes', ...(layer_types ? { layer_types } : {}) }
  const lt = /(小于|窄于|细于|不到|低于|少于|<|＜)\s*([\d.]+\s*(?:mil|mm|毫米|密尔|um|微米)?)/i.exec(t)
  const gt = /(大于|宽于|粗于|超过|高于|多于|>|＞)\s*([\d.]+\s*(?:mil|mm|毫米|密尔|um|微米)?)/i.exec(t)
  const isLine = /线宽|走线|导线|线路|的线|细线|线径|条线/.test(t) || (/线/.test(t) && !/网/.test(t))
  const isPad = /焊盘|盘径|pad|过孔盘|环宽|的盘|圆盘/i.test(t)
  const net = /([A-Za-z0-9_+\-]+)\s*网/.exec(t)?.[1]
  const q2: BoardQuery = { what: 'features', ...(layer_types ? { layer_types } : {}) }
  if (isPad) {
    q2.feature = 'pad'
    if (lt) q2.size_lt_mm = parseLength(lt[2]!) ?? undefined
    if (gt) q2.size_gt_mm = parseLength(gt[2]!) ?? undefined
  } else if (isLine) {
    q2.feature = 'line'
    if (lt) q2.width_lt_mm = parseLength(lt[2]!) ?? undefined
    if (gt) q2.width_gt_mm = parseLength(gt[2]!) ?? undefined
  } else if (/铺铜|铜皮|大铜|surface/i.test(t)) q2.feature = 'surface'
  if (net) q2.net = net
  if (/(clear|负|透明|白)/i.test(t) && /极性|clear/i.test(t)) q2.polarity = 'clear'
  const specific = q2.feature || q2.net || q2.width_lt_mm !== undefined || q2.width_gt_mm !== undefined || q2.size_lt_mm !== undefined || q2.size_gt_mm !== undefined
  return specific ? q2 : null
}

const SYSTEM = `你把 PCB CAM 工程师的一句话翻成 JSON 查询,只输出一个 JSON 对象,不要解释。
字段:what("features" 找物件 | "changes" 问改动分布)、layer_types(数组,取值 top_copper/inner_copper/bottom_copper/top_mask/bottom_mask/top_silk/bottom_silk/outline)、feature("line"|"pad"|"surface"|"any")、width_lt_mm/width_gt_mm(线宽上下限,mm)、size_lt_mm/size_gt_mm(焊盘尺寸上下限,mm)、net(网名)、polarity("dark"|"clear")。
1 mil = 0.0254 mm。没提到的字段省略。问不出物件的话输出 {"what":"features","feature":"any"}。`

/** 翻译一句话:规则优先;规则失败且有模型才问模型。返回 null = 两条路都没结果。 */
export async function translateQuestion(db: Db, ctx: Ctx, question: string, caller?: LLMCaller): Promise<{ query: BoardQuery; via: 'rules' | 'llm' } | null> {
  const byRules = parseBoardQuestion(question)
  if (byRules) return { query: byRules, via: 'rules' }
  let llm: LLMCaller
  try {
    llm = caller ?? (await buildTenantLLMCaller(db, ctx, 'pcb_cam'))
  } catch {
    return null
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: question.slice(0, 500) },
  ]
  try {
    const res = await llm(messages)
    const body = res.reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? res.reply
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end < start) return null
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>
    const q: BoardQuery = { what: o.what === 'changes' ? 'changes' : 'features' }
    if (Array.isArray(o.layer_types)) q.layer_types = o.layer_types.filter((x): x is string => typeof x === 'string')
    if (typeof o.feature === 'string' && ['line', 'pad', 'surface', 'any'].includes(o.feature)) q.feature = o.feature as BoardQuery['feature']
    for (const k of ['width_lt_mm', 'width_gt_mm', 'size_lt_mm', 'size_gt_mm'] as const) if (typeof o[k] === 'number' && Number.isFinite(o[k])) q[k] = o[k] as number
    if (typeof o.net === 'string' && o.net) q.net = o.net.slice(0, 60)
    if (o.polarity === 'dark' || o.polarity === 'clear') q.polarity = o.polarity
    return { query: q, via: 'llm' }
  } catch {
    return null
  }
}

/** 给人看的一句回答:「顶层线路 21 条线宽小于 0.15 mm 的线,底层 3 条」 */
export function describeAnswer(q: BoardQuery, result: { total: number; by_layer: Record<string, number>; by_op?: Record<string, number>; truncated?: number }): string {
  if (q.what === 'changes') {
    const top = Object.entries(result.by_layer).sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (result.total === 0) return '本地引擎没有改过这块板的图。'
    const ops = Object.entries(result.by_op ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([op, n]) => `${op} ${n}`).join('、')
    return `共 ${result.total} 处改动;最多的层:${top.map(([l, n]) => `${l} ${n} 处`).join(',')}${ops ? `;主要是 ${ops}` : ''}。`
  }
  const what = q.feature === 'line' ? '线' : q.feature === 'pad' ? '焊盘' : q.feature === 'surface' ? '铜皮' : '物件'
  const cond = [
    q.width_lt_mm !== undefined ? `线宽 < ${q.width_lt_mm.toFixed(3)} mm` : '',
    q.width_gt_mm !== undefined ? `线宽 > ${q.width_gt_mm.toFixed(3)} mm` : '',
    q.size_lt_mm !== undefined ? `尺寸 < ${q.size_lt_mm.toFixed(3)} mm` : '',
    q.size_gt_mm !== undefined ? `尺寸 > ${q.size_gt_mm.toFixed(3)} mm` : '',
    q.net ? `网 ${q.net}` : '',
  ].filter(Boolean).join('、')
  if (result.total === 0) return `没有找到${cond ? cond + '的' : ''}${what}。`
  const per = Object.entries(result.by_layer).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l} ${n}`).join(',')
  return `找到 ${result.total} 个${cond ? cond + '的' : ''}${what}(${per})${result.truncated ? `;图上只标了前 ${result.total - result.truncated} 个` : ''}。`
}
