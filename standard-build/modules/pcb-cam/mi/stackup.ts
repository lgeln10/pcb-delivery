// modules/pcb-cam/mi/stackup.ts
// 叠层压合结构图(SVG,自包含):铜层 / PP / 芯板交替 + 盲埋孔 span。示意图,不是工厂压合图纸;
// 样式参考培训文档第 16 章 p206–207(铜层横条 + 竖向孔柱)。尺寸/材料来自 order_spec.stackup(若有),否则按层数推默认结构。
import type { PcbCamJob } from '../model'
import { boardFacts } from './flows'

export type StackupLayer = { name: string; kind: 'copper' | 'pp' | 'core'; note: string }
export type StackupModel = { layers: StackupLayer[]; spans: Array<{ from: number; to: number; label: string }>; copperLayers: number; warnings: string[] }

function parseSpan(s: string): { from: number; to: number } | null {
  const m = s.match(/L?(\d+)\s*[-–~]\s*L?(\d+)/i)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  return a > 0 && b > 0 ? { from: Math.min(a, b), to: Math.max(a, b) } : null
}

/** 默认结构:2 层 = 芯板;4 层 = 箔 / PP / 芯板 / PP / 箔;6 层及以上 = 芯板与 PP 交替(与 p207 例图一致)。 */
export function buildStackup(job: Pick<PcbCamJob, 'layerMap' | 'orderSpec' | 'orderSpecCandidate'>): StackupModel {
  const facts = boardFacts(job)
  const warnings: string[] = []
  const n = facts.copperLayers && facts.copperLayers >= 1 ? facts.copperLayers : 2
  if (!facts.copperLayers) warnings.push('层数未知,按 2 层画')
  const spec = (job.orderSpec ?? job.orderSpecCandidate ?? {}) as { stackup?: Array<{ layer?: string; type?: string; note?: string }>; copper_oz?: { outer?: number; inner?: number } }
  const specLayers = Array.isArray(spec.stackup) ? spec.stackup : []
  const outerOz = spec.copper_oz?.outer ?? null
  const innerOz = spec.copper_oz?.inner ?? null
  const copperNote = (i: number) => {
    const s = specLayers.find((l) => (l.layer ?? '').toUpperCase() === `L${i}`)
    const oz = i === 1 || i === n ? outerOz : innerOz
    return [s?.type, s?.note, oz ? `${oz}oz` : null].filter(Boolean).join(' · ')
  }
  const layers: StackupLayer[] = []
  for (let i = 1; i <= n; i++) {
    layers.push({ name: i === 1 ? 'GTL(L1)' : i === n ? `GBL(L${n})` : `L${i}`, kind: 'copper', note: copperNote(i) })
    if (i === n) break
    // 介质:2 层 → 芯板;偶数层板:外侧 PP,内侧从 L2 起 芯板/PP 交替(L2-L3 芯板、L3-L4 PP …)
    let kind: 'pp' | 'core'
    if (n === 2) kind = 'core'
    else if (i === 1 || i === n - 1) kind = 'pp'
    else kind = i % 2 === 0 ? 'core' : 'pp'
    layers.push({ name: kind === 'pp' ? 'PP' : '芯板', kind, note: '' })
  }
  if (n % 2 === 1) warnings.push(`铜层数 ${n} 为奇数,结构按示意画,请核对层识别`)
  const spans = facts.blindSpans
    .map((s) => ({ s, p: parseSpan(s) }))
    .filter((x): x is { s: string; p: { from: number; to: number } } => x.p !== null && x.p.to <= n)
    .map((x) => ({ from: x.p.from, to: x.p.to, label: x.s }))
  if (spans.length === 0 && facts.hasBlindBuried) warnings.push('规格写了盲埋孔但钻孔文件没有可解析的层跨度,图中只画通孔')
  return { layers, spans, copperLayers: n, warnings }
}

/** 渲染 SVG:左侧层名,中间横条(铜=橙,PP=浅蓝,芯板=蓝),右侧备注;孔柱从 span 起层画到止层,通孔贯穿。 */
export function renderStackupSvg(model: StackupModel, title = '叠层压合结构示意'): string {
  const rowH = 22
  const padTop = 36
  const labelW = 90
  const barX = labelW + 10
  const barW = 260
  const noteX = barX + barW + 90
  const width = noteX + 200
  const height = padTop + model.layers.length * rowH + 30
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const rowY = (idx: number) => padTop + idx * rowH
  const copperRowIndex = (layerNo: number) => model.layers.findIndex((l, i) => l.kind === 'copper' && model.layers.slice(0, i + 1).filter((x) => x.kind === 'copper').length === layerNo)
  const rows = model.layers
    .map((l, i) => {
      const y = rowY(i)
      const h = l.kind === 'copper' ? 8 : rowH - 8
      const fill = l.kind === 'copper' ? '#d97706' : l.kind === 'pp' ? '#bfdbfe' : '#3b82f6'
      const yBar = l.kind === 'copper' ? y + (rowH - h) / 2 : y + 4
      return `<text x="${labelW}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11">${esc(l.name)}</text>`
        + `<rect x="${barX}" y="${yBar}" width="${barW}" height="${h}" fill="${fill}" />`
        + (l.note ? `<text x="${noteX}" y="${y + rowH / 2 + 4}" font-size="10" fill="#444">${esc(l.note)}</text>` : '')
    })
    .join('')
  // 孔柱:通孔一根(贯穿全部),每个 span 一根
  const pillars: string[] = []
  const pillar = (fromRow: number, toRow: number, x: number, label: string, color: string) => {
    const y1 = rowY(fromRow) + rowH / 2
    const y2 = rowY(toRow) + rowH / 2
    pillars.push(`<rect x="${x - 5}" y="${y1 - 4}" width="10" height="${y2 - y1 + 8}" fill="${color}" opacity="0.85" />`
      + `<text x="${x}" y="${rowY(toRow) + rowH + 6}" text-anchor="middle" font-size="9" fill="#222">${esc(label)}</text>`)
  }
  pillar(copperRowIndex(1), copperRowIndex(model.copperLayers), barX + barW - 24, '通孔', '#dc2626')
  model.spans.forEach((s, i) => {
    const a = copperRowIndex(s.from)
    const b = copperRowIndex(s.to)
    if (a >= 0 && b >= 0) pillar(a, b, barX + 30 + i * 28, s.label, '#b91c1c')
  })
  const warn = model.warnings.length ? `<text x="${barX}" y="${height - 8}" font-size="10" fill="#b45309">⚠ ${esc(model.warnings.join(';'))}</text>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">`
    + `<rect width="100%" height="100%" fill="#fff"/>`
    + `<text x="${barX}" y="20" font-size="13" font-weight="600">${esc(title)}(${model.copperLayers} 层)</text>`
    + rows + pillars.join('') + warn + '</svg>'
}
