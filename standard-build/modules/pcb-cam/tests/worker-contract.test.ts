// worker 契约:pcb 仓 tests/fixtures/report_samples/*.json(pydantic 序列化结果)必须能被这里的 zod 收下。
// ★两边同源:改 engine/model/report.py 的字段要把样例重导一份到 tests/fixtures/;改 worker-types.ts 要跑这条。
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StageReportSchema } from '../worker-types'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../pcb-worker/tests/fixtures/report_samples')

describe('StageReport 契约(pydantic → zod)', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  it('至少有 3 份样例', () => expect(files.length).toBeGreaterThanOrEqual(3))
  for (const f of files) {
    it(`${f} 可解析`, () => {
      const raw = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
      const parsed = StageReportSchema.safeParse(raw)
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true)
      if (parsed.success) {
        expect(Array.isArray(parsed.data.items)).toBe(true)
        expect(typeof parsed.data.summary).toBe('string')
      }
    })
  }
  it('pydantic 的 null 可选字段(genesis_script / bbox / filename)不会让报告被拒', () => {
    const r = StageReportSchema.safeParse({
      stage: 'drill',
      status: 'ok',
      summary: null,
      items: [{ id: 'a', kind: 'k', severity: 'info', layer: null, location: { x: 1, y: 2, bbox: null }, measured: null, threshold: null, message: 'm', fix: { type: 'resize', params: null, auto_fixable: true, applied: null, genesis_script: null }, eq_question: null, needs_decision: false }],
      artifacts: [{ kind: 'drill', path: 'p/x.drl', filename: null, size: null, content_type: null }],
      duration_ms: null,
    })
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true)
    if (r.success) {
      expect(r.data.summary).toBe('')
      expect(r.data.items[0]!.fix!.params).toEqual({})
      expect(r.data.items[0]!.fix!.applied).toBe(false)
    }
  })
})
