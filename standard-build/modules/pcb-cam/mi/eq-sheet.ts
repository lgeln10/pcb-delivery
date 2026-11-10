// modules/pcb-cam/mi/eq-sheet.ts
// 问单(EQ 问题点确认单):发给客户的「问客户」条目 + 给生产的「人工处理」条目,每条带一张板图局部
// (层 SVG 按问题点位置裁 viewBox;整张层图只内嵌一次,每条用 <use> 引用,包不会因为 30 条问题点膨胀 30 倍)。
// 纯字符串拼接、无外链,能直接打印;答复栏留空给客户手填,或在页面「客户答复」里回收。
import type { EqItemDTO } from '../logic'
import { kindLabel } from '../ui/labels'

export type EqSheetItem = EqItemDTO & { location?: { x: number; y: number; bbox?: [number, number, number, number] | null } | null; layer?: string | null }
export type EqSheetMeta = { projectName: string; customerName?: string | null; jobId: string; generatedAt: Date; engineer?: string | null }

const DECISION_LABEL: Record<string, string> = { pending: '待判', accept_fix: '接受修复方案', ignore: '接受现状', manual: '人工处理', ask_customer: '问客户' }

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
/** worker 的层 SVG:根 <svg viewBox="x -y1 w h"> + <g transform="scale(1,-1)">…</g>;取 <g> 的内容进 <symbol> */
function symbolOf(svg: string, id: string): string | null {
  const m = svg.match(/<svg[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/)
  if (!m) return null
  return `<symbol id="${id}" viewBox="${esc(m[1]!)}" overflow="visible">${m[2]!}</symbol>`
}
function cropView(it: EqSheetItem): string | null {
  const loc = it.location
  if (!loc) return null
  const [x0, y0, x1, y1] = loc.bbox ?? [loc.x - 2, loc.y - 2, loc.x + 2, loc.y + 2]
  const pad = Math.max(x1 - x0, y1 - y0, 1.5) * 1.2
  return `${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`
}

/**
 * @param svgByLayer 层文件名 → worker 层 SVG(frame=board);拿不到图的层留空(表格仍出,只是没图)
 */
export function renderEqSheetHtml(items: EqSheetItem[], svgByLayer: Map<string, string>, meta: EqSheetMeta): string {
  const symbols: string[] = []
  const symId = new Map<string, string>()
  for (const [layer, svg] of svgByLayer) {
    const id = `L${symId.size}`
    const sym = symbolOf(svg, id)
    if (sym) {
      symbols.push(sym)
      symId.set(layer, id)
    }
  }
  const row = (it: EqSheetItem, i: number) => {
    const view = cropView(it)
    const sid = it.layer ? symId.get(it.layer) : undefined
    // <use> 只画符号本身;裁剪靠外层 svg 的 viewBox;symbol 用 overflow=visible 保证 <g scale(1,-1)> 的负 y 内容不被裁
    const pic = view && sid ? `<svg class="pic" viewBox="${view}" preserveAspectRatio="xMidYMid meet"><use href="#${sid}" x="0" y="0" width="100%" height="100%"/><rect class="mark" x="${view.split(' ')[0]}" y="${view.split(' ')[1]}" width="${view.split(' ')[2]}" height="${view.split(' ')[3]}" fill="none"/></svg>` : '<div class="pic pic--none">无图</div>'
    return `<tr><td>${i + 1}</td><td><b>${esc(kindLabel(it.kind))}</b><div class="small">${esc(it.stage)} · ${esc(it.itemId)}${it.layer ? ` · ${esc(it.layer)}` : ''}${it.location ? ` · (${it.location.x.toFixed(2)}, ${it.location.y.toFixed(2)}) mm` : ''}</div><div class="msg">${esc(it.message)}</div>${it.note ? `<div class="small">工程师备注:${esc(it.note)}</div>` : ''}</td><td>${pic}</td><td class="ans">${it.customerReply ? esc(it.customerReply) : '&nbsp;'}</td></tr>`
  }
  const ask = items.filter((i) => i.decision === 'ask_customer')
  const manual = items.filter((i) => i.decision === 'manual')
  const decided = items.filter((i) => !['ask_customer', 'manual', 'pending'].includes(i.decision))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>EQ 问单 · ${esc(meta.projectName)}</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px 8px;font-size:13px;text-align:left;vertical-align:top}th{background:#f2f2f2}.meta,.small{font-size:12px;color:#555}.msg{margin-top:4px}.pic{width:180px;height:120px;background:#fafafa;border:1px solid #ddd}.pic--none{display:flex;align-items:center;justify-content:center;color:#999}.mark{stroke:#dc2626;stroke-width:0.3;vector-effect:non-scaling-stroke}.ans{min-width:14em}svg use{fill:#333}@media print{body{margin:10mm}.pic{width:150px;height:100px}}</style></head><body>
<svg width="0" height="0" style="position:absolute"><defs>${symbols.join('')}</defs></svg>
<h1>EQ 问单(问题点确认单)</h1>
<p class="meta">项目:${esc(meta.projectName)}${meta.customerName ? ` · 客户:${esc(meta.customerName)}` : ''} · 任务:${esc(meta.jobId.slice(0, 8))} · 生成:${meta.generatedAt.toISOString().replace('T', ' ').slice(0, 16)}${meta.engineer ? ` · 工程师:${esc(meta.engineer)}` : ''}</p>
<h2>一、请客户确认(${ask.length})</h2>
${ask.length ? `<table><tr><th style="width:3em">#</th><th>问题点</th><th style="width:190px">板图局部</th><th>客户答复</th></tr>${ask.map(row).join('')}</table>` : '<p class="small">没有需要客户确认的问题点。</p>'}
<h2>二、生产人工处理(${manual.length})</h2>
${manual.length ? `<table><tr><th style="width:3em">#</th><th>问题点</th><th style="width:190px">板图局部</th><th>处理记录</th></tr>${manual.map(row).join('')}</table>` : '<p class="small">没有需要人工处理的问题点。</p>'}
<h2>三、已由工程师判定(${decided.length})</h2>
${decided.length ? `<table><tr><th style="width:3em">#</th><th>问题点</th><th style="width:10em">判法</th></tr>${decided.map((it, i) => `<tr><td>${i + 1}</td><td><b>${esc(kindLabel(it.kind))}</b><div class="small">${esc(it.stage)} · ${esc(it.itemId)}</div><div class="msg">${esc(it.message)}</div></td><td>${esc(DECISION_LABEL[it.decision] ?? it.decision)}${it.note ? `<div class="small">${esc(it.note)}</div>` : ''}</td></tr>`).join('')}</table>` : '<p class="small">无。</p>'}
<p class="small">本单由 PCB CAM 模块自动生成;局部图为系统输出的层图按问题点位置裁切,坐标为板坐标(mm,y 向上)。</p>
</body></html>`
}
