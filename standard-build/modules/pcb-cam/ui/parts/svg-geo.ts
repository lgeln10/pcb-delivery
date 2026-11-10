// modules/pcb-cam/ui/parts/svg-geo.ts
// 板图 SVG 的坐标换算:worker 出的 SVG viewBox 是 mm、y 向上(通过 <g scale(1,-1)> 翻转,viewBox.y = -y1)。
// 屏幕像素 ↔ 板坐标(mm),按 preserveAspectRatio 默认的 xMidYMid meet 算。
export type ViewBox = { x: number; y: number; w: number; h: number }

export function viewBoxOf(svg: string | null | undefined): ViewBox | null {
  const m = svg?.match(/viewBox="([^"]+)"/)
  if (!m) return null
  const [x, y, w, h] = m[1]!.trim().split(/[\s,]+/).map(Number)
  if ([x, y, w, h].some((v) => !Number.isFinite(v)) || !w || !h) return null
  return { x: x!, y: y!, w: w!, h: h! }
}

/** 屏幕坐标 → 板坐标(mm,y 向上)。el 是内联 <svg> 元素 */
export function clientToMm(el: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const vb = el.viewBox.baseVal
  if (!vb || !vb.width || !vb.height) return null
  const r = el.getBoundingClientRect()
  const scale = Math.min(r.width / vb.width, r.height / vb.height)
  const ox = (r.width - vb.width * scale) / 2
  const oy = (r.height - vb.height * scale) / 2
  const xv = vb.x + (clientX - r.left - ox) / scale
  const yv = vb.y + (clientY - r.top - oy) / scale
  return { x: xv, y: -yv }
}

/** 把 viewBox 缩到一个 mm bbox(留 pad 倍边距) */
export function zoomViewBox(svg: string, bbox: [number, number, number, number], padFactor = 1.5): string {
  const [x0, y0, x1, y1] = bbox
  const pad = Math.max(x1 - x0, y1 - y0, 1) * padFactor
  return svg.replace(/viewBox="[^"]*"/, `viewBox="${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}"`)
}

/** 在 </svg> 前插入一组框(mm 坐标,自带 y 翻转) */
export function withBoxes(svg: string, boxes: Array<{ bbox: [number, number, number, number]; cls: string; title?: string; id?: string }>): string {
  if (!boxes.length) return svg
  const esc = (t: string) => t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
  const rects = boxes
    .map((b) => {
      const [x0, y0, x1, y1] = b.bbox
      return `<rect class="${b.cls}"${b.id ? ` data-id="${esc(b.id)}"` : ''} x="${x0}" y="${y0}" width="${Math.max(x1 - x0, 0.05)}" height="${Math.max(y1 - y0, 0.05)}" vector-effect="non-scaling-stroke">${b.title ? `<title>${esc(b.title)}</title>` : ''}</rect>`
    })
    .join('')
  return svg.replace(/<\/svg>\s*$/, `<g class="pcb-overlay" transform="scale(1,-1)" fill="none">${rects}</g></svg>`)
}

/** 改写 worker SVG 根 <g> 的层色 */
export function recolorSvg(svg: string, color: string): string {
  return svg.replace(/(<g transform="scale\(1,-1\)"[^>]*?)fill="#[0-9a-fA-F]{3,8}"/, `$1fill="${color}"`)
}
