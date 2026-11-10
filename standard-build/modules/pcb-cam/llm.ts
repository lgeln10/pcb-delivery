// modules/pcb-cam/llm.ts — 本模块所有大模型调用的唯一出口(场景 `pcb_cam`,见 core/llm/scenes.ts)。
// ★LLM 只出「候选」:数值由 worker 与 Excellon 实测比对,人确认后才成事实(MODULE.md 不变量 4)。
// ★没配模型 / 调用失败 → 返回带 `_llm: 'unavailable'` 的降级候选,流程照走,由工程师手填;绝不让整条 pipeline 因 AI 不可用而停。
import { PDFParse } from 'pdf-parse'
import * as XLSX from 'xlsx'
import type { Ctx, Db } from '../../core/db/client'
import { buildTenantLLMCaller, describeImage, type ChatMessage, type LLMCaller } from '../../core/llm/api'
import { readObject } from '../../core/storage/api'
import type { PcbCamJob } from './model'

export const PCB_CAM_SCENE = 'pcb_cam'
/** 送给模型的附件正文上限(字符)。制作要求通常 1–3 页;超出的截断并标注。 */
const MAX_ATTACHMENT_CHARS = 24_000
const MAX_IMAGE_ATTACHMENTS = 4

export type OrderSpecCandidate = Record<string, unknown> & {
  _llm?: 'ok' | 'unavailable' | 'failed'
  _sources?: Array<{ file: string; kind: 'pdf' | 'excel' | 'image' | 'text'; chars: number; truncated?: boolean; error?: string }>
  _note?: string
}

/** 注入点:automation 在 order_spec 阶段调用;测试可替换。 */
export type OrderSpecExtractor = (db: Db, job: PcbCamJob) => Promise<OrderSpecCandidate>

const SYSTEM_PROMPT = `你是 PCB 工厂的 CAM 工程师助手。用户给你客户「制作要求」文档的文字内容(可能来自 PDF、Excel 或图片转文字),你要把制板规格抽成 JSON。
规则:
1. 只输出一个 JSON 对象,不要解释,不要 markdown 围栏。
2. 文档里没写的字段填 null,不要猜。数值带单位换算成毫米(mm)、盎司(oz)、mil 按字段要求。
3. 钻孔表若有,逐行抄进 drill_table,不要合并、不要四舍五入。
4. 拿不准的地方写进 uncertainties 数组,让工程师核对。
JSON 结构:
{
  "layers": 层数(整数)|null,
  "board_thickness_mm": 成品板厚|null,
  "copper_oz": {"outer": 外层铜厚 oz|null, "inner": 内层铜厚 oz|null},
  "material": 板材(如 FR-4 TG150)|null,
  "surface_finish": 表面处理(沉金/喷锡/OSP/电金/沉银…)|null,
  "solder_mask_color": 阻焊颜色|null,
  "silkscreen_color": 字符颜色|null,
  "min_trace_space_mil": {"trace": 最小线宽 mil|null, "space": 最小线距 mil|null},
  "min_hole_mm": 最小孔径|null,
  "impedance": [{"target_ohm": 数, "type": "single|differential", "layer": "L1", "trace_mil": 数, "space_mil": 数|null}],
  "special_process": ["金手指","半孔","盲埋孔","阻抗","塞孔","金属包边","V-CUT" 中出现的],
  "via_plugging": "none|resin|solder_mask"|null,
  "gold_finger": {"bevel_deg": 30|45|60|null, "hard_gold_uin": 数|null}|null,
  "panelization": 拼板要求原文|null,
  "drill_table": [{"tool": "T01", "size_mm": 数, "count": 整数|null, "plated": true|false|null, "note": "…"}],
  "stackup": [{"layer": "L1", "type": "signal|plane|mixed", "note": "…"}]|null,
  "customer_notes": [客户的其他特别要求原句],
  "uncertainties": ["…"]
}`

function extractJsonObject(reply: string): string | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1]! : reply
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  return body.slice(start, end + 1)
}

function extOf(key: string): string {
  const name = key.split('/').pop() ?? key
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
function fileNameOf(key: string): string {
  // key = <prefix>/<uuid>-<safeName>;去掉 uuid 前缀给模型看原名
  const name = key.split('/').pop() ?? key
  return name.replace(/^[0-9a-f-]{36}-/i, '')
}

async function pdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) })
  try {
    const res = await parser.getText()
    return (res.text ?? '').trim()
  } finally {
    await parser.destroy().catch(() => {})
  }
}
function excelText(bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: 'buffer', cellDates: false })
  return wb.SheetNames.map((n) => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n]!)}`).join('\n\n').trim()
}

/** 把 job 的附件(非压缩包)转成文字,给模型。图片走 vision 旁路转录。 */
export async function collectAttachmentTexts(
  db: Db,
  ctx: Ctx,
  inputKeys: string[],
): Promise<{ texts: Array<{ file: string; kind: 'pdf' | 'excel' | 'image' | 'text'; text: string }>; sources: NonNullable<OrderSpecCandidate['_sources']> }> {
  const texts: Array<{ file: string; kind: 'pdf' | 'excel' | 'image' | 'text'; text: string }> = []
  const sources: NonNullable<OrderSpecCandidate['_sources']> = []
  let images = 0
  for (const key of inputKeys) {
    const ext = extOf(key)
    const file = fileNameOf(key)
    let kind: 'pdf' | 'excel' | 'image' | 'text' | null = null
    if (ext === 'pdf') kind = 'pdf'
    else if (ext === 'xlsx' || ext === 'xls') kind = 'excel'
    else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') kind = 'image'
    else if (ext === 'txt' || ext === 'csv') kind = 'text'
    if (!kind) continue
    try {
      const bytes = await readObject(db, ctx, key)
      let text = ''
      if (kind === 'pdf') text = await pdfText(bytes)
      else if (kind === 'excel') text = excelText(bytes)
      else if (kind === 'text') text = bytes.toString('utf8')
      else {
        if (images >= MAX_IMAGE_ATTACHMENTS) {
          sources.push({ file, kind, chars: 0, error: `图片附件超过 ${MAX_IMAGE_ATTACHMENTS} 张,未读取` })
          continue
        }
        images++
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
        const r = await describeImage(db, ctx, `data:${mime};base64,${bytes.toString('base64')}`, '这是 PCB 制作要求 / 叠层图 / 钻孔表的截图。请把图中所有文字、表格逐行抄录出来(保持表格行列),不要总结。')
        text = r.text
      }
      const truncated = text.length > MAX_ATTACHMENT_CHARS
      if (truncated) text = text.slice(0, MAX_ATTACHMENT_CHARS) + '\n…(已截断)'
      texts.push({ file, kind, text })
      sources.push({ file, kind, chars: text.length, ...(truncated ? { truncated } : {}) })
    } catch (err) {
      sources.push({ file, kind, chars: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) })
    }
  }
  return { texts, sources }
}

/**
 * 附件 → 规格候选。没有附件 → `_llm: 'ok'` 且各字段 null(工程师手填);模型不可用 → `_llm: 'unavailable'`。
 * 不抛错:这一步失败不该拦住 pipeline。
 */
export async function extractOrderSpec(db: Db, job: PcbCamJob, caller?: LLMCaller): Promise<OrderSpecCandidate> {
  const ctx: Ctx = { tenantId: job.tenantId, employeeId: job.createdBy ?? '' }
  const { texts, sources } = await collectAttachmentTexts(db, ctx, job.inputKeys)
  if (texts.length === 0) {
    return { _llm: 'ok', _sources: sources, _note: '没有可读的制作要求附件;请工程师按客户要求手填。', drill_table: [], uncertainties: [] }
  }
  let llm: LLMCaller
  try {
    llm = caller ?? (await buildTenantLLMCaller(db, ctx, PCB_CAM_SCENE))
  } catch (err) {
    return {
      _llm: 'unavailable',
      _sources: sources,
      _note: `大模型未配置或不可用(${(err instanceof Error ? err.message : String(err)).slice(0, 120)});附件已读出文字,请工程师手填规格。`,
      attachment_text_preview: texts.map((t) => `# ${t.file}\n${t.text.slice(0, 2000)}`).join('\n\n'),
    }
  }
  const user = texts.map((t) => `# 文件:${t.file}(${t.kind})\n${t.text}`).join('\n\n---\n\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
  try {
    const res = await llm(messages)
    const raw = extractJsonObject(res.reply)
    if (!raw) return { _llm: 'failed', _sources: sources, _note: '模型回复里没有 JSON,请工程师手填。', raw_reply: res.reply.slice(0, 2000) }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { _llm: 'failed', _sources: sources, _note: '模型回复不是 JSON 对象,请工程师手填。' }
    }
    return { ...parsed, _llm: 'ok', _sources: sources }
  } catch (err) {
    return { _llm: 'failed', _sources: sources, _note: `模型调用失败:${(err instanceof Error ? err.message : String(err)).slice(0, 160)}` }
  }
}

const LAYER_TYPES = [
  'top_copper', 'inner_copper', 'bottom_copper', 'top_mask', 'bottom_mask', 'top_silk', 'bottom_silk',
  'top_paste', 'bottom_paste', 'outline', 'drill_pth', 'drill_npth', 'drill_unknown', 'drill_blind', 'drawing', 'unknown',
] as const
export type LlmLayerGuess = { file: string; type: (typeof LAYER_TYPES)[number]; index: number | null; confidence: number; reason: string }

/**
 * 层名兜底识别:只对 worker 标了 `needs_llm` 的文件调用。输入文件名 + 文件头几行(worker 已放进 layer_map.files[].head)。
 * 返回值仍是候选:UI 上高亮让工程师确认,不直接写事实。
 */
export async function guessLayersWithLlm(
  db: Db,
  job: PcbCamJob,
  files: Array<{ file: string; head?: string; reason?: string }>,
  caller?: LLMCaller,
): Promise<LlmLayerGuess[]> {
  if (files.length === 0) return []
  const ctx: Ctx = { tenantId: job.tenantId, employeeId: job.createdBy ?? '' }
  let llm: LLMCaller
  try {
    llm = caller ?? (await buildTenantLLMCaller(db, ctx, PCB_CAM_SCENE))
  } catch {
    return []
  }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是 PCB CAM 工程师。根据 Gerber/钻孔文件的文件名和文件头几行,判断每个文件是哪一层。只输出 JSON 数组,每项 {"file","type","index","confidence","reason"}。type 只能取:${LAYER_TYPES.join(', ')}。index 是铜层序号(顶层 1,底层 = 层数),非铜层填 null。confidence 0–1。常见:GTL/Top/F_Cu=top_copper;GBL/Bottom/B_Cu=bottom_copper;G1/G2/L2/In1_Cu=inner_copper;GTS/GBS/*_Mask=阻焊;GTO/GBO/*_SilkS=字符;GKO/GM1/Edge_Cuts/outline=outline;drl/txt(M48 头)=钻孔,NPTH 字样=drill_npth。`,
    },
    { role: 'user', content: JSON.stringify(files.map((f) => ({ file: f.file, head: (f.head ?? '').slice(0, 400), hint: f.reason ?? '' }))) },
  ]
  try {
    const res = await llm(messages)
    const body = res.reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? res.reply
    const start = body.indexOf('[')
    const end = body.lastIndexOf(']')
    if (start < 0 || end < start) return []
    const arr = JSON.parse(body.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []
    return arr.flatMap((x) => {
      if (!x || typeof x !== 'object') return []
      const o = x as Record<string, unknown>
      const type = (LAYER_TYPES as readonly string[]).includes(String(o.type)) ? (o.type as LlmLayerGuess['type']) : 'unknown'
      return [{
        file: String(o.file ?? ''),
        type,
        index: typeof o.index === 'number' ? o.index : null,
        confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
        reason: String(o.reason ?? '').slice(0, 200),
      }]
    })
  } catch {
    return []
  }
}
