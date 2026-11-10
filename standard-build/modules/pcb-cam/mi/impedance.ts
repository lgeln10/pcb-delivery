// 阻抗参数助手(《CAM工程技能培训》第 15 章 p185–201)。
// 不算阻抗值 —— 那是 Polar/Si9000 的事;这里只把书上给 MI 单用的"取值规则"落成表:
// 线底/线面宽度补偿(W1=W2+Δ,p190)、铜厚 T1 取值(p191)、阻焊厚度 C1/C2/C3 与 CEr(p192)、
// 按层位/类型选计算模型(p193–199)。全部确定性,数值出自 knowledge/rules/impedance.yaml。

export type ImpedanceReq = { target_ohm?: unknown; type?: unknown; layer?: unknown; trace_mil?: unknown; space_mil?: unknown }

export type ImpedanceRow = {
  layer: string
  type: 'single' | 'differential' | 'coplanar'
  targetOhm: number | null
  /** 原稿阻抗线宽 W1(线底)mil */
  w1Mil: number | null
  /** 线面宽度 W2 = W1 − Δ mil(p190) */
  w2Mil: number | null
  /** 差分线间隙 S1 mil */
  s1Mil: number | null
  /** T1 铜厚 um(p191) */
  t1Um: number
  t1Note: string
  /** 计算模型(p193–199) */
  model: string
  /** 阻焊前/后 */
  soldermask: string
}

export type ImpedanceSheet = {
  rows: ImpedanceRow[]
  /** 阻焊参数(p192):一次印刷 */
  soldermask: { c1Um: number; c2Um: number; c3Um: number; cer: number; note: string }
  notes: string[]
}

type Oz = 'HOZ' | '1OZ' | '2OZ'

/** 铜厚写法五花八门:1 / 0.5 / "1oz" / "H/H" / "1/1" / "35um" → 归到 HOZ / 1OZ / 2OZ */
export function copperOz(v: unknown): Oz | null {
  if (v == null || v === '') return null
  let n: number | null = null
  if (typeof v === 'number') n = v
  else if (typeof v === 'string') {
    const s = v.trim().toUpperCase()
    if (/^H(OZ)?(\/H)?$/.test(s) || s === '0.5' || s === '1/2') n = 0.5
    else {
      const m = s.match(/([\d.]+)\s*(UM|ΜM|MICRON)?/)
      if (m) {
        const x = Number(m[1])
        n = m[2] ? x / 35 : x // 35 um ≈ 1 oz
      }
    }
  }
  if (n == null || !Number.isFinite(n)) return null
  if (n < 0.75) return 'HOZ'
  if (n < 1.5) return '1OZ'
  return '2OZ'
}

// p190:线底与线面宽度的关系(W1 = W2 + Δ)
const W_DELTA_MIL: Record<'inner' | 'outer', Record<Oz, number>> = {
  inner: { HOZ: 0.3, '1OZ': 0.5, '2OZ': 1.2 },
  outer: { HOZ: 0.8, '1OZ': 1.2, '2OZ': 1.6 },
}
// p191:T1 —— 内层为基板铜厚;外层为铜箔 + 镀铜,按孔铜规格(默认 平均 20UM/最小 18UM 档)
const T1_INNER_UM: Record<Oz, number> = { HOZ: 15, '1OZ': 30, '2OZ': 65 }
const T1_OUTER_UM: Record<Oz, { hole20: number; hole25: number; holeMin25: number }> = {
  HOZ: { hole20: 45, hole25: 50, holeMin25: 55 },
  '1OZ': { hole20: 55, hole25: 60, holeMin25: 65 },
  '2OZ': { hole20: 90, hole25: 95, holeMin25: 100 }, // 书上未给 2OZ 外层,按 1OZ 规律 +35um 推算,MI 签核时核对
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function layerIndex(layer: string, copperLayers: number | null): number | null {
  const m = layer.toUpperCase().match(/L\s*(\d+)/)
  if (m) return Number(m[1])
  if (/TOP|GTL|F\.?CU/i.test(layer)) return 1
  if (/BOT|GBL|B\.?CU/i.test(layer)) return copperLayers ?? null
  return null
}

function kindOf(v: unknown): ImpedanceRow['type'] {
  const s = String(v ?? '').toLowerCase()
  if (/diff|差/.test(s)) return 'differential'
  if (/coplanar|共面/.test(s)) return 'coplanar'
  return 'single'
}

/** p193–199 模型选择:外层 → microstrip(阻焊后按 coated);次外层 → offset stripline(与外层相邻);其余内层 → 两平面夹 */
function modelFor(type: ImpedanceRow['type'], idx: number | null, copperLayers: number | null): { model: string; soldermask: string } {
  const outer = idx === 1 || (copperLayers != null && idx === copperLayers) || (idx == null && (copperLayers ?? 2) <= 2)
  const nextToOuter = idx != null && copperLayers != null && (idx === 2 || idx === copperLayers - 1)
  if (type === 'coplanar') {
    if (outer) return { model: 'Coated coplanar waveguide with ground(阻焊后,参考同层 GND + 次外层平面)', soldermask: '阻焊后' }
    return { model: 'Embedded coplanar waveguide with ground(内层,参考同层 GND 及相邻平面)', soldermask: '—' }
  }
  const pre = type === 'differential' ? 'Edge-coupled ' : ''
  if (outer) return { model: `${pre}Coated Microstrip(外层阻焊后;阻焊前用 ${pre}Surface Microstrip)`, soldermask: '阻焊后' }
  if (nextToOuter) return { model: `${pre}Offset stripline(与外层相邻的第二个线路层,L3 为平面)`, soldermask: '—' }
  return { model: `${pre}Offset stripline(两个 GND/VCC 夹线路层)`, soldermask: '—' }
}

export function buildImpedanceSheet(spec: Record<string, unknown> | null | undefined, copperLayers: number | null): ImpedanceSheet | null {
  const reqs = Array.isArray(spec?.impedance) ? (spec!.impedance as ImpedanceReq[]) : []
  if (reqs.length === 0) return null
  const oz = (spec?.copper_oz ?? {}) as { outer?: unknown; inner?: unknown }
  const outerOz = copperOz(oz.outer) ?? '1OZ'
  const innerOz = copperOz(oz.inner) ?? outerOz
  const notes: string[] = []
  if (copperOz(oz.outer) == null) notes.push('附件未写外层铜厚,W2/T1 按 1OZ 取值,MI 签核时核对')
  if (copperOz(oz.inner) == null && (copperLayers ?? 2) > 2) notes.push('附件未写内层铜厚,按外层铜厚取值')
  notes.push('外层 T1 按孔铜「平均 20UM/最小 18UM」档取值;孔铜 25UM 时外层 T1 +5UM,单点最小 25UM 时 +10UM(p191)')
  notes.push('阻抗值用 Polar/Si9000 按下表参数计算;本表只给取值,不算阻抗(p185)')
  const rows: ImpedanceRow[] = reqs.map((r) => {
    const layer = String(r.layer ?? '').trim() || '未写明'
    const idx = layerIndex(layer, copperLayers)
    const isOuter = idx === 1 || (copperLayers != null && idx === copperLayers) || (idx == null && (copperLayers ?? 2) <= 2)
    const type = kindOf(r.type)
    const ozHere = isOuter ? outerOz : innerOz
    const w1 = num(r.trace_mil)
    const delta = W_DELTA_MIL[isOuter ? 'outer' : 'inner'][ozHere]
    const t1 = isOuter ? T1_OUTER_UM[ozHere].hole20 : T1_INNER_UM[ozHere]
    const { model, soldermask } = modelFor(type, idx, copperLayers)
    return {
      layer,
      type,
      targetOhm: num(r.target_ohm),
      w1Mil: w1,
      w2Mil: w1 == null ? null : Math.round((w1 - delta) * 100) / 100,
      s1Mil: num(r.space_mil),
      t1Um: t1,
      t1Note: isOuter ? `外层 ${ozHere} 底铜 + 镀铜(p191)` : `内层 ${ozHere} 基板铜厚(p191)`,
      model,
      soldermask,
    }
  })
  return { rows, soldermask: { c1Um: 30, c2Um: 12, c3Um: 30, cer: 3.4, note: '印一次阻焊油墨的取值;印两次为 C1 60 / C2 25 / C3 60(p192)' }, notes }
}
