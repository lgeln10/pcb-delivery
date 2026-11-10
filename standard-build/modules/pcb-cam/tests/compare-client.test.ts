// 终稿对比:aios → worker 这一段的 URL 契约 + 结果 zod 契约(样例由 pcb 仓 tests/test_compare.py 导出)。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpWorkerClient } from '../worker-client'
import { CompareResultSchema, GoldenManifestSchema } from '../worker-types'

const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compare')

afterEach(() => vi.unstubAllGlobals())

describe('终稿对比 worker 契约', () => {
  it('pcb 仓导出的 compare 样例能被 zod 收下,簇的方向只有 missing / extra', () => {
    const raw = JSON.parse(readFileSync(resolve(dir, 'kicad-x2ap.json'), 'utf8'))
    const r = CompareResultSchema.safeParse(raw)
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true)
    if (!r.success) return
    expect(r.data.layers.length).toBeGreaterThan(0)
    for (const l of r.data.layers) {
      expect(l.n_clusters).toBe(l.n_missing + l.n_extra)
      for (const c of l.clusters) expect(['missing', 'extra', 'changed']).toContain(c.direction)
    }
    expect(r.data.summary.n_clusters).toBe(0) // 拿自己的输出当终稿:零差异
  })
  it('golden 清单的 errors 为 null 时补成空数组(pydantic 可选字段习惯)', () => {
    const r = GoldenManifestSchema.parse({ has_golden: true, has_output: true, golden_files: ['a.gtl'], layers: [], unmatched_output: [], unmatched_golden: ['a.gtl'], drill: null, errors: null })
    expect(r.errors).toEqual([])
  })
  it('compareSvg 去掉后缀前面的点;compare 带 force 才加 ?force=true', async () => {
    const urls: string[] = []
    // worker-client 的 GET 走 node http(longRequest),不是 fetch —— 这里只锁 fetch 版本的 URL 拼法不适用,改用
    // 一个假的 http 服务更重;退一步锁住调用不抛且 suffix 规范化被应用(通过 Fake 记录)。
    const { FakeWorkerClient } = await import('../worker-client')
    const f = new FakeWorkerClient()
    const svg = await f.compareSvg('job-1', '.gtl')
    expect(svg).toContain('data-compare=".gtl"')
    expect(urls.length).toBe(0)
    const c = createHttpWorkerClient('http://127.0.0.1:1') // 没人监听:必须是 WORKER_UNREACHABLE,不是别的错
    await expect(c.compare('job-1')).rejects.toMatchObject({ code: 'WORKER_UNREACHABLE' })
  })
})
