// 中文化护栏:worker 报的每个 kind、每种层类型/成果物类型都要有中文名,新增了忘记翻就变红。
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PCB_CAM_ARTIFACT_KINDS } from '../model'
import { ARTIFACT_KIND_LABEL, ITEM_KIND_LABEL, LAYER_TYPE_LABEL, artifactKindLabel, eqItemLabel, kindLabel, layerTypeLabel, opLabel, severityLabel } from '../ui/labels'

/** 页面上层类型下拉的取值(与 PcbCamWorkspace.vue 的 LAYER_TYPES 同源) */
const WORKSPACE = readFileSync(new URL('../ui/PcbCamWorkspace.vue', import.meta.url), 'utf8')

describe('中文标签完整性', () => {
  it('层类型下拉每一项都有中文名', () => {
    const block = WORKSPACE.match(/const LAYER_TYPES = \[([\s\S]*?)\]/)![1]!
    const types = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
    expect(types.length).toBeGreaterThan(10)
    expect(types.filter((t) => !LAYER_TYPE_LABEL[t])).toEqual([])
  })

  it('每种成果物类型都有中文名', () => {
    expect(PCB_CAM_ARTIFACT_KINDS.filter((k) => !ARTIFACT_KIND_LABEL[k])).toEqual([])
  })

  it('中文名不残留英文标识符,且不为空', () => {
    for (const [k, v] of Object.entries({ ...ITEM_KIND_LABEL, ...LAYER_TYPE_LABEL, ...ARTIFACT_KIND_LABEL })) {
      expect(v.trim(), k).not.toBe('')
      expect(v, k).not.toBe(k)
    }
  })

  it('未知值回落到原文,不显示 undefined', () => {
    expect(kindLabel('brand_new_kind')).toBe('brand_new_kind')
    expect(artifactKindLabel('zzz')).toBe('zzz')
    expect(layerTypeLabel('zzz')).toBe('zzz')
    expect(severityLabel('fatal')).toBe('fatal')
    expect(layerTypeLabel('top_copper')).toBe('顶层线路 (top_copper)')
  })

  it('worker 报告里出现的 kind 都要有中文名(本仓引擎源码为准)', () => {
    const root = new URL('../../../../pcb-worker/engine/', import.meta.url)
    let kinds: string[] = []
    try {
      const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
        if (e.isDirectory()) return e.name === '__pycache__' ? [] : walk(u)
        return e.name.endsWith('.py') ? [...readFileSync(u, 'utf8').matchAll(/kind="([a-z_0-9]+)"/g)].map((m) => m[1]!) : []
      })
      kinds = [...new Set(walk(root))]
    } catch (error) {
      throw new Error(`本仓几何引擎源码不可读: ${String(error)}`)
    }
    // 走到这里说明确实扫到了 engine 源码
    expect(kinds.length).toBeGreaterThan(50)
    expect(kinds.filter((k) => !ITEM_KIND_LABEL[k]).sort()).toEqual([])
  })

  it('问题点 id 取最长匹配的 kind:net_open_after_reduce 不能被 net_open 抢走', () => {
    const keys = Object.keys(ITEM_KIND_LABEL)
    expect(eqItemLabel('annular_ring_Flashpads-F_Cu.gbr_summary', keys)).toBe('焊盘环宽不足')
    expect(eqItemLabel('net_open_after_reduce_In1.gbr_summary', keys)).toBe('减铜后开路(细连铜)')
    expect(eqItemLabel('silk_height_ratio_s.gbr_summary', keys)).toBe('字高与笔画比偏小')
    expect(eqItemLabel('unknown_thing_1', keys)).toBe('unknown_thing_1')
  })
})

/** Every bundled engine operation needs a platform label. */
describe('CamOp 中文标签', () => {
  it('每个 CamOp 都有中文名', () => {
    const src = readFileSync(new URL('../../../../pcb-worker/engine/adapters/base.py', import.meta.url), 'utf8')
    const ops = [...src.matchAll(/^\s{4}[A-Z0-9_]+ = "(\w+)"/gm)].map((m) => m[1]!)
    expect(ops.length).toBeGreaterThan(20)
    expect(ops.filter((op) => opLabel(op) === op)).toEqual([])
  })
})
