// 工作队列 / 决策记忆 / 批量决策 / 客户答复 / 放行下发 / 查板问句翻译
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { syncPermissions } from '../../../core/org/api'
import type { Ctx } from '../../../core/db/client'
import { PCB_CAM_PERMISSIONS } from '../permissions'
import { completeStageRun, createJob, createProject, claimNextStageRun, decideEqBatch, decideEqItem, eqSuggestions, getJob, jobStats, kindOfItemId, listEqItems, listJobs, recordCustomerReply, releaseJob, storagePrefix, submitEq } from '../logic'
import { describeAnswer, parseBoardQuestion, parseLength } from '../ask'
import { renderEqSheetHtml } from '../mi/eq-sheet'
import { putObject } from '../../../core/storage/api'

let t: OrgTestDb
let ctx: Ctx
beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db, 'PCB CAM 队列测试租户')
  ctx = seeded.ownerCtx
  await syncPermissions(t.db, PCB_CAM_PERMISSIONS)
})
afterAll(async () => t.close())

async function newJob(projectId: string): Promise<string> {
  const jobId = crypto.randomUUID()
  await createJob(t.db, ctx, projectId, { jobId, inputKeys: [`${storagePrefix(ctx.tenantId, jobId)}input/board.zip`] })
  return jobId
}
/** 把 job 推到 intake 完成且带两条同类型 EQ(hole_separation)+ 一条 drill_oversize */
async function runToEq(jobId: string, kinds: string[] = ['hole_separation', 'hole_separation', 'drill_oversize']) {
  const claimed = (await claimNextStageRun(t.db, jobId))!
  await completeStageRun(t.db, claimed.run.id, {
    stage: 'intake',
    status: 'needs_review',
    summary: 'x',
    items: kinds.map((k, i) => ({ id: `${k}_${i}`, kind: k, severity: 'error' as const, layer: 'top.gbr', location: { x: i, y: i, bbox: [i, i, i + 1, i + 1] as [number, number, number, number] }, measured: null, threshold: null, message: `${k} ${i}`, fix: null, eq_question: `确认 ${k}?` })),
    artifacts: [],
  })
}

describe('工作队列', () => {
  it('queue 排序:待确认在前、同档等得久的在前;每行带待判条数;newest 排序仍按创建时间', async () => {
    const p = await createProject(t.db, ctx, { name: '队列项目', customerName: '甲客户' })
    const a = await newJob(p.id) // pending
    const b = await newJob(p.id)
    await runToEq(b) // needs_review,3 条待判
    const c = await newJob(p.id)
    await runToEq(c, ['hole_separation']) // needs_review,1 条,晚于 b
    const q = await listJobs(t.db, ctx, { limit: 10, projectId: p.id, sort: 'queue' })
    expect(q.items.map((j) => j.id)).toEqual([b, c, a])
    expect(q.items[0]!.eqPending).toBe(3)
    expect(q.items[2]!.eqPending).toBe(0)
    expect(q.items[0]!.customerName).toBe('甲客户')
    const n = await listJobs(t.db, ctx, { limit: 10, projectId: p.id, sort: 'newest' })
    expect(n.items.map((j) => j.id)).toEqual([c, b, a])
    // 队列游标翻页
    const page1 = await listJobs(t.db, ctx, { limit: 2, projectId: p.id, sort: 'queue' })
    expect(page1.items.map((j) => j.id)).toEqual([b, c])
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await listJobs(t.db, ctx, { limit: 2, projectId: p.id, sort: 'queue', cursor: page1.nextCursor! })
    expect(page2.items.map((j) => j.id)).toEqual([a])
    expect(page2.nextCursor).toBeNull()
  })
  it('统计:待我处理的单数与决策数', async () => {
    const s = await jobStats(t.db, ctx)
    expect(s.mine.jobs).toBeGreaterThanOrEqual(2)
    expect(s.mine.decisions).toBeGreaterThanOrEqual(4)
    expect(s.mine.oldestWaitingAt).toBeInstanceOf(Date)
    expect(s.running).toBeGreaterThanOrEqual(1)
  })
})

describe('批量决策与决策记忆', () => {
  it('同类型一组一次判掉;记忆按同客户优先取上次的判法并数次数;重复 3 次提示写进厂规', async () => {
    const p = await createProject(t.db, ctx, { name: '记忆项目', customerName: '乙客户' })
    const j1 = await newJob(p.id)
    await runToEq(j1)
    const items = await listEqItems(t.db, ctx, j1)
    expect(items.every((i) => i.kind === 'hole_separation' || i.kind === 'drill_oversize')).toBe(true)
    const holes = items.filter((i) => i.kind === 'hole_separation').map((i) => i.id)
    const r = await decideEqBatch(t.db, ctx, j1, [...holes, crypto.randomUUID()], { decision: 'ignore', note: '客户确认过' })
    expect(r.changed).toBe(2)
    expect(r.items.filter((i) => i.decision === 'ignore').length).toBe(2)
    await decideEqItem(t.db, ctx, j1, items.find((i) => i.kind === 'drill_oversize')!.id, { decision: 'accept_fix' })
    await submitEq(t.db, ctx, j1)
    // 第二块板(同客户)
    const j2 = await newJob(p.id)
    await runToEq(j2)
    const s = await eqSuggestions(t.db, ctx, j2)
    const hole = s.items.find((x) => x.kind === 'hole_separation')!
    expect(hole.suggestion?.decision).toBe('ignore')
    expect(hole.suggestion?.sameCustomer).toBe(true)
    expect(hole.suggestion?.count).toBe(2)
    expect(hole.suggestion?.note).toBe('客户确认过')
    expect(s.items.find((x) => x.kind === 'drill_oversize')!.suggestion?.decision).toBe('accept_fix')
    // 再判两次 → 同判法累计 ≥3 → repeated 里出现
    const items2 = await listEqItems(t.db, ctx, j2)
    await decideEqBatch(t.db, ctx, j2, items2.filter((i) => i.kind === 'hole_separation').map((i) => i.id), { decision: 'ignore' })
    const j3 = await newJob(p.id)
    await runToEq(j3, ['hole_separation'])
    const s3 = await eqSuggestions(t.db, ctx, j3)
    expect(s3.repeated.find((x) => x.kind === 'hole_separation' && x.decision === 'ignore')?.count).toBeGreaterThanOrEqual(3)
    // 别的客户:没有同客户记录时退到任何客户的最近一次
    const p2 = await createProject(t.db, ctx, { name: '丙项目', customerName: '丙客户' })
    const j4 = await newJob(p2.id)
    await runToEq(j4, ['hole_separation'])
    const s4 = await eqSuggestions(t.db, ctx, j4)
    expect(s4.items[0]!.suggestion?.sameCustomer).toBe(false)
    expect(s4.items[0]!.suggestion?.decision).toBe('ignore')
  })
  it('老行没存 kind 时按 item_id 前缀推', () => {
    expect(kindOfItemId('annular_ring_Flashpads-F_Cu.gbr_summary', null)).toBe('annular_ring')
    expect(kindOfItemId('hole_separation_12', undefined)).toBe('hole_separation')
    expect(kindOfItemId('whatever_3', 'stored_kind')).toBe('stored_kind')
  })
  it('客户答复落在那条发现上,不改决策', async () => {
    const p = await createProject(t.db, ctx, { name: '答复项目' })
    const j = await newJob(p.id)
    await runToEq(j, ['hole_separation'])
    const it0 = (await listEqItems(t.db, ctx, j))[0]!
    await decideEqItem(t.db, ctx, j, it0.id, { decision: 'ask_customer' })
    const items = await recordCustomerReply(t.db, ctx, j, it0.id, '按现状生产')
    expect(items[0]!.customerReply).toBe('按现状生产')
    expect(items[0]!.customerReplyAt).toBeInstanceOf(Date)
    expect(items[0]!.decision).toBe('ask_customer')
  })
})

describe('放行下发', () => {
  it('只有 done 的任务能下发;包里有成果物 + 附加的流程单/问单;记 releasedAt', async () => {
    const p = await createProject(t.db, ctx, { name: '下发项目' })
    const j = await newJob(p.id)
    await expect(releaseJob(t.db, ctx, j, [])).rejects.toThrow(/放行下发/)
    // 造一个 done 的任务:走一遍所有 stage(ok 报告),output 步带一个 gerber_panel 成果物
    for (;;) {
      const claimed = await claimNextStageRun(t.db, j)
      if (!claimed) break
      let artifacts: Array<{ kind: string; path: string; filename: string; size: number }> = []
      if (claimed.stage === 'output') {
        const stored = await putObject(t.db, ctx, { bytes: Buffer.from('G04'), filename: 'top.gtl', contentType: 'text/plain', keyPrefix: `${storagePrefix(ctx.tenantId, j)}output/output`, visibility: 'private' })
        artifacts = [{ kind: 'gerber_panel', path: stored.key, filename: 'top.gtl', size: 3 }]
      }
      await completeStageRun(t.db, claimed.run.id, { stage: claimed.stage, status: 'ok', summary: 'ok', items: [], artifacts })
      const job = await getJob(t.db, ctx, j)
      if (job.status === 'needs_review') {
        if (job.reviewReason === 'layers') await (await import('../logic')).confirmLayers(t.db, ctx, j, { files: [] })
        else if (job.reviewReason === 'order_spec') await (await import('../logic')).confirmOrderSpec(t.db, ctx, j, { layers: 2 })
        else await submitEq(t.db, ctx, j)
      }
      if (job.status === 'done') break
    }
    expect((await getJob(t.db, ctx, j)).status).toBe('done')
    const pack = await releaseJob(t.db, ctx, j, [{ name: 'mi_sheet/MI.html', data: Buffer.from('<html/>'), mtime: new Date() }])
    expect(pack.filename).toMatch(/^release-/)
    expect(pack.count).toBe(2)
    expect((await getJob(t.db, ctx, j)).releasedAt).toBeInstanceOf(Date)
    expect((await jobStats(t.db, ctx)).releasedToday).toBeGreaterThanOrEqual(1)
  })
})

describe('自然语言查板:规则翻译', () => {
  it('长度单位', () => {
    expect(parseLength('4mil')).toBeCloseTo(0.1016, 4)
    expect(parseLength('0.15mm')).toBe(0.15)
    expect(parseLength('4')).toBeCloseTo(0.1016, 4) // 无单位 >2 当 mil
    expect(parseLength('0.2')).toBe(0.2)
    expect(parseLength('abc')).toBeNull()
  })
  it('常见问法', () => {
    expect(parseBoardQuestion('把内层小于 4mil 的线都标出来')).toEqual({ what: 'features', layer_types: ['inner_copper'], feature: 'line', width_lt_mm: 0.1016 })
    expect(parseBoardQuestion('顶层大于 2mm 的焊盘')).toEqual({ what: 'features', layer_types: ['top_copper'], feature: 'pad', size_gt_mm: 2 })
    expect(parseBoardQuestion('这块板哪里改动最多')).toEqual({ what: 'changes' })
    expect(parseBoardQuestion('阻焊改了什么')).toEqual({ what: 'changes', layer_types: ['top_mask', 'bottom_mask'] })
    expect(parseBoardQuestion('GND 网的线')).toMatchObject({ what: 'features', feature: 'line', net: 'GND' })
    expect(parseBoardQuestion('今天天气怎么样')).toBeNull()
    expect(parseBoardQuestion('')).toBeNull()
  })
  it('一句回答', () => {
    expect(describeAnswer({ what: 'features', feature: 'line', width_lt_mm: 0.1016 }, { total: 0, by_layer: {} })).toMatch(/没有找到线宽 < 0.102 mm的线/)
    expect(describeAnswer({ what: 'features', feature: 'pad' }, { total: 12, by_layer: { 'a.gtl': 8, 'b.gbl': 4 }, truncated: 2 })).toMatch(/找到 12 个焊盘\(a.gtl 8,b.gbl 4\);图上只标了前 10 个/)
    expect(describeAnswer({ what: 'changes' }, { total: 30, by_layer: { 'a.gtl': 20, 'b.gbl': 10 }, by_op: { LineCompensation: 25, NfpRemoval: 5 } })).toMatch(/共 30 处改动;最多的层:a.gtl 20 处,b.gbl 10 处;主要是 LineCompensation 25、NfpRemoval 5/)
  })
})

describe('问单 HTML', () => {
  it('问客户/人工处理分节,带局部图(层 SVG 只内嵌一次),没图的层写「无图」', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -50 100 50"><g transform="scale(1,-1)" fill="#c8322b"><path d="M0 0h10v10h-10z"/></g></svg>'
    const base = { id: 'x', stage: 'drill' as const, severity: 'error' as const, suggestedFix: null, decidedBy: null, decidedAt: null, note: null, customerReply: null, customerReplyAt: null }
    const html = renderEqSheetHtml(
      [
        { ...base, id: '1', itemId: 'hole_separation_1', kind: 'hole_separation', message: '孔距不足', decision: 'ask_customer', layer: 'top.gtl', location: { x: 5, y: 5, bbox: [4, 4, 6, 6] } },
        { ...base, id: '2', itemId: 'npth_to_rout_1', kind: 'npth_to_rout', message: '近板边', decision: 'manual', layer: 'nope.gbl', location: { x: 1, y: 1 } },
        { ...base, id: '3', itemId: 'drill_oversize_1', kind: 'drill_oversize', message: '预大', decision: 'accept_fix', customerReply: '好' },
      ],
      new Map([['top.gtl', svg]]),
      { projectName: '测试', customerName: '甲', jobId: '12345678-0000', generatedAt: new Date('2026-09-22T00:00:00Z'), engineer: '张工' },
    )
    expect(html).toContain('一、请客户确认(1)')
    expect(html).toContain('二、生产人工处理(1)')
    expect(html).toContain('三、已由工程师判定(1)')
    expect((html.match(/<symbol /g) ?? []).length).toBe(1)
    expect(html).toContain('<use href="#L0"')
    expect(html).toContain('无图')
    expect(html).toContain('孔间距(重叠/接触/过近)')
    expect(html).toContain('工程师:张工')
  })
})
