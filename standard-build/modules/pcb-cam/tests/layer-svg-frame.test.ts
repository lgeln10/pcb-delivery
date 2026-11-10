// 多层叠加对照的前提:各层必须按同一个画框(板外形)出图。worker 侧有 test_geom 覆盖;
// 这里锁住 aios 到 worker 这一段 —— `frame=board` 必须真的出现在请求 URL 上,
// 少了就变成"每层按自己范围出图",叠加会静默错位(图还在,只是对不齐,很难发现)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpWorkerClient } from '../worker-client'

const urls: string[] = []
afterEach(() => {
  urls.length = 0
  vi.unstubAllGlobals()
})

function stubFetch() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } })
  })
}

describe('层预览画框透传', () => {
  it("frame='board' 出现在 URL 上;不传则不带该参数", async () => {
    stubFetch()
    const c = createHttpWorkerClient('http://worker:8000')
    await c.layerSvg('job-1', 'F_Cu', 'board')
    await c.layerSvg('job-1', 'F_Cu')
    expect(urls[0]).toBe('http://worker:8000/jobs/job-1/layers/F_Cu.svg?frame=board')
    expect(urls[1]).toBe('http://worker:8000/jobs/job-1/layers/F_Cu.svg')
  })

  it("rev='orig' 与 frame 一起透传(对原稿:看客户文件而不是 edit 副本)", async () => {
    stubFetch()
    const c = createHttpWorkerClient('http://worker:8000')
    await c.layerSvg('job-1', 'F_Cu', 'board', 'orig')
    await c.layerSvg('job-1', 'F_Cu', undefined, 'orig')
    expect(urls[0]).toBe('http://worker:8000/jobs/job-1/layers/F_Cu.svg?frame=board&rev=orig')
    expect(urls[1]).toBe('http://worker:8000/jobs/job-1/layers/F_Cu.svg?rev=orig')
  })

  it('层名里的特殊字符仍被转义(路径注入)', async () => {
    stubFetch()
    await createHttpWorkerClient('http://worker:8000').layerSvg('job-1', '../secret', 'board')
    expect(urls[0]).toBe('http://worker:8000/jobs/job-1/layers/..%2Fsecret.svg?frame=board')
  })
})
