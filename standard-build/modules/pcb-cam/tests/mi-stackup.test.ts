import { describe, expect, it } from 'vitest'
import { buildStackup, renderStackupSvg } from '../mi/stackup'

describe('叠层结构', () => {
  it('2 层 = 铜/芯板/铜;4 层 = 铜/PP/铜/芯板/铜/PP/铜;6 层介质交替', () => {
    const two = buildStackup({ layerMap: null, orderSpec: { layers: 2 }, orderSpecCandidate: null })
    expect(two.layers.map((l) => l.kind)).toEqual(['copper', 'core', 'copper'])
    const four = buildStackup({ layerMap: null, orderSpec: { layers: 4 }, orderSpecCandidate: null })
    expect(four.layers.map((l) => l.kind)).toEqual(['copper', 'pp', 'copper', 'core', 'copper', 'pp', 'copper'])
    const six = buildStackup({ layerMap: null, orderSpec: { layers: 6 }, orderSpecCandidate: null })
    expect(six.layers.filter((l) => l.kind === 'copper').length).toBe(6)
    expect(six.layers.map((l) => l.kind)).toEqual(['copper', 'pp', 'copper', 'core', 'copper', 'pp', 'copper', 'core', 'copper', 'pp', 'copper'])
  })
  it('盲埋孔 span 解析;超出层数的 span 丢弃;层数未知警告', () => {
    const m = buildStackup({
      layerMap: { files: [{ type: 'drill_blind', drill_span: 'L1-L2' }, { type: 'drill_blind', drill_span: '2-3' }, { type: 'drill_blind', drill_span: 'L5-L6' }], stackup: { copper_layers: 4 } },
      orderSpec: null,
      orderSpecCandidate: null,
    })
    expect(m.spans.map((s) => `${s.from}-${s.to}`)).toEqual(['1-2', '2-3'])
    const unknown = buildStackup({ layerMap: null, orderSpec: null, orderSpecCandidate: null })
    expect(unknown.copperLayers).toBe(2)
    expect(unknown.warnings[0]).toContain('未知')
  })
  it('SVG 自包含且转义', () => {
    const m = buildStackup({ layerMap: null, orderSpec: { layers: 4, copper_oz: { outer: 1, inner: 0.5 }, stackup: [{ layer: 'L2', type: 'plane', note: '<GND>' }] }, orderSpecCandidate: null })
    const svg = renderStackupSvg(m)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('&lt;GND&gt;')
    expect(svg).toContain('通孔')
    expect(svg).toContain('1oz')
    expect(svg).not.toContain('<script')
  })
})
