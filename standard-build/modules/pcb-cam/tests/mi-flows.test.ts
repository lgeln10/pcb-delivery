// MI 流程单:板型判定是确定性规则,模板工序顺序不可被改动(与第 17 章一致)。
import { describe, expect, it } from 'vitest'
import { boardFacts, buildMiSheet, MI_FLOW_TEMPLATES, renderMiSheetHtml, selectFlow } from '../mi/flows'
import { buildImpedanceSheet, copperOz } from '../mi/impedance'

function facts(over: Partial<ReturnType<typeof boardFacts>> = {}) {
  return { copperLayers: 2, hasBlindBuried: false, blindSpans: [], polarity: 'positive' as const, special: [], surfaceFinish: null, viaPlugging: null, ...over }
}

describe('MI 模板数据', () => {
  it('每个模板有 id/页码/非空工序,id 唯一,首工序为开料或钻盘中孔', () => {
    const ids = new Set<string>()
    for (const t of MI_FLOW_TEMPLATES) {
      expect(ids.has(t.id)).toBe(false)
      ids.add(t.id)
      expect(t.sourcePage).toBeGreaterThanOrEqual(212)
      expect(t.steps.length).toBeGreaterThan(5)
      expect(['开料', '钻盘中孔']).toContain(t.steps[0])
    }
    expect(MI_FLOW_TEMPLATES.length).toBe(18)
  })
})

describe('selectFlow 板型判定', () => {
  it('双面正片 → 图形电镀;负片 → 整板电镀', () => {
    expect(selectFlow(facts()).template.id).toBe('mi.flow.pattern_plating.double_side')
    expect(selectFlow(facts({ polarity: 'negative' })).template.id).toBe('mi.flow.panel_plating.double_side')
  })
  it('多层正片/负片', () => {
    expect(selectFlow(facts({ copperLayers: 6 })).template.id).toBe('mi.flow.pattern_plating.multilayer')
    expect(selectFlow(facts({ copperLayers: 8, polarity: 'negative' })).template.id).toBe('mi.flow.panel_plating.multilayer')
  })
  it('特殊工艺优先:电金+沉金 / 电金 / 金属包边 / 半孔 / 盘中孔 / 二钻', () => {
    expect(selectFlow(facts({ surfaceFinish: '电金+沉金' })).template.id).toBe('mi.flow.hard_gold_plus_enig')
    expect(selectFlow(facts({ special: ['金手指'], surfaceFinish: '电金' })).template.id).toBe('mi.flow.hard_gold')
    expect(selectFlow(facts({ special: ['金属包边'] })).template.id).toBe('mi.flow.metal_edge')
    expect(selectFlow(facts({ special: ['半孔'] })).template.id).toBe('mi.flow.half_hole')
    expect(selectFlow(facts({ special: ['盘中孔'] })).template.id).toBe('mi.flow.via_in_pad')
    expect(selectFlow(facts({ special: ['二钻'] })).template.id).toBe('mi.flow.second_drill.positive')
    expect(selectFlow(facts({ special: ['二钻'], polarity: 'negative' })).template.id).toBe('mi.flow.second_drill.negative')
  })
  it('盲埋孔:4 层按是否含 L2-L3 埋孔分;6 层按是否二阶分;其他层数给警告', () => {
    expect(selectFlow(facts({ copperLayers: 4, hasBlindBuried: true, blindSpans: ['L1-L2', 'L2-L3', 'L3-L4'] })).template.id).toBe('mi.flow.hdi.4L_blind_buried')
    expect(selectFlow(facts({ copperLayers: 4, hasBlindBuried: true, blindSpans: ['L1-L2', 'L3-L4'] })).template.id).toBe('mi.flow.hdi.4L_blind')
    expect(selectFlow(facts({ copperLayers: 6, hasBlindBuried: true, blindSpans: ['L1-L2', 'L2-L3'] })).template.id).toBe('mi.flow.hdi.6L_2stage')
    expect(selectFlow(facts({ copperLayers: 6, hasBlindBuried: true, blindSpans: ['L1-L2', 'L2-L5'] })).template.id).toBe('mi.flow.hdi.6L_1stage')
    const r = selectFlow(facts({ copperLayers: 8, hasBlindBuried: true, blindSpans: ['L1-L2'] }))
    expect(r.template.id).toBe('mi.flow.pattern_plating.multilayer')
    expect(r.warnings.length).toBe(1)
  })
  it('金手指未写电金 → 警告;奇数层 → 警告;层数未知 → 默认双面并警告', () => {
    expect(selectFlow(facts({ special: ['金手指'] })).warnings[0]).toContain('电金')
    expect(selectFlow(facts({ copperLayers: 5 })).warnings[0]).toContain('奇数')
    const r = selectFlow(facts({ copperLayers: null }))
    expect(r.template.id).toBe('mi.flow.pattern_plating.double_side')
    expect(r.warnings[0]).toContain('未知')
  })
})

describe('boardFacts / buildMiSheet / render', () => {
  it('从 layer_map + order_spec 提取事实;规格未确认时用候选并警告', () => {
    const job = {
      layerMap: { files: [{ type: 'top_copper' }, { type: 'inner_copper' }, { type: 'inner_copper' }, { type: 'bottom_copper' }, { type: 'drill_blind', drill_span: 'L1-L2' }], stackup: { copper_layers: 4 } },
      orderSpec: null,
      orderSpecCandidate: { layers: 4, surface_finish: '沉金', special_process: ['盲埋孔'] },
    }
    const f = boardFacts(job)
    expect(f.copperLayers).toBe(4)
    expect(f.hasBlindBuried).toBe(true)
    expect(f.blindSpans).toEqual(['L1-L2'])
    const sheet = buildMiSheet(job)
    expect(sheet.flowId).toBe('mi.flow.hdi.4L_blind')
    expect(sheet.warnings.some((w) => w.includes('尚未确认'))).toBe(true)
    const html = renderMiSheetHtml(sheet, { projectName: '<板>', jobId: '12345678-abcd', generatedAt: new Date('2026-09-05T00:00:00Z') })
    expect(html).toContain('&lt;板&gt;')
    expect(html).toContain('四层盲孔')
    expect(html).toContain('p215')
    expect(html.split('<tr>').length - 1).toBeGreaterThan(sheet.steps.length)
  })
})

describe('第 15 章阻抗取值表(只取值,不算阻抗)', () => {
  it('铜厚写法归一', () => {
    expect(copperOz('H/H')).toBe('HOZ')
    expect(copperOz(0.5)).toBe('HOZ')
    expect(copperOz('1oz')).toBe('1OZ')
    expect(copperOz('35um')).toBe('1OZ')
    expect(copperOz(2)).toBe('2OZ')
    expect(copperOz(null)).toBeNull()
  })
  it('外层 1OZ:W2 = W1 − 1.2,T1 55;内层 HOZ:W2 = W1 − 0.3,T1 15;模型按层位', () => {
    const spec = {
      copper_oz: { outer: 1, inner: 'H' },
      impedance: [
        { target_ohm: 50, type: 'single', layer: 'L1', trace_mil: 6 },
        { target_ohm: 100, type: 'differential', layer: 'L3', trace_mil: 5, space_mil: 7 },
        { target_ohm: 90, type: 'diff', layer: 'L2', trace_mil: 4.5, space_mil: 6 },
      ],
    }
    const sheet = buildImpedanceSheet(spec, 6)! // 6 层:L2/L5 与外层相邻,L3 在两平面之间
    expect(sheet.rows.map((r) => [r.w2Mil, r.t1Um])).toEqual([[4.8, 55], [4.7, 15], [4.2, 15]])
    expect(sheet.rows[0]!.model).toContain('Coated Microstrip')
    expect(sheet.rows[1]!.model).toContain('Edge-coupled Offset stripline(两个')
    expect(sheet.rows[2]!.model).toContain('与外层相邻')
    expect(sheet.soldermask).toMatchObject({ c1Um: 30, c2Um: 12, c3Um: 30, cer: 3.4 })
    expect(buildImpedanceSheet({ impedance: [] }, 2)).toBeNull()
  })
  it('流程单带阻抗表,HTML 有该段;无阻抗要求则为 null', () => {
    const withImp = buildMiSheet({ layerMap: null, orderSpec: { layers: 2, impedance: [{ target_ohm: 50, layer: 'TOP', trace_mil: 8 }] }, orderSpecCandidate: null })
    expect(withImp.impedance?.rows[0]?.w2Mil).toBe(6.8)
    expect(renderMiSheetHtml(withImp, { projectName: 'p', jobId: 'j', generatedAt: new Date() })).toContain('阻抗取值')
    expect(buildMiSheet({ layerMap: null, orderSpec: { layers: 2 }, orderSpecCandidate: null }).impedance).toBeNull()
  })
})
