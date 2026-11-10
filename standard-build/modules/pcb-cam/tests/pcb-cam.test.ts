// pcb-cam 不变量测试(对应 MODULE.md「关键不变量」1–8)。worker 用 FakeWorkerClient,不起网络。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { syncPermissions } from '../../../core/org/api'
import type { Ctx } from '../../../core/db/client'
import { PCB_CAM_PERMISSIONS } from '../permissions'
import { pcbCamJobs, pcbCamStageRuns } from '../model'
import { PCB_CAM_STAGES, stageIndex } from '../stages'
import { putObject } from '../../../core/storage/api'
import { inflateRawSync } from 'node:zlib'
import { advanceAll, advanceOne, mergeLlmLayerGuesses } from '../automation'
import { FakeWorkerClient } from '../worker-client'
import {
  cancelJob,
  claimNextStageRun,
  confirmLayers,
  confirmOrderSpec,
  createJob,
  createProject,
  completeStageRun,
  decideEqItem,
  deriveJobStatusFromReport,
  failStageRun,
  getJob,
  listEqItems,
  listJobs,
  packArtifacts,
  pendingGenesisAction,
  listArtifacts,
  MAX_AUTO_RETRY,
  retryStage,
  storagePrefix,
  submitEq,
  upsertFactoryProfile,
} from '../logic'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db, 'PCB CAM 测试租户')
  ctx = seeded.ownerCtx
  await syncPermissions(t.db, PCB_CAM_PERMISSIONS)
})
afterAll(async () => t.close())

/** routes 的真实流程:上传到 pcb-cam/<tenant>/<jobId>/input/ 再 createJob;这里只验前缀属于本租户(不变量 5)。 */
async function createJobWithKeys(projectId: string): Promise<string> {
  const jobId = crypto.randomUUID()
  const job = await createJob(t.db, ctx, projectId, { jobId, inputKeys: [`${storagePrefix(ctx.tenantId, jobId)}input/board.zip`] })
  return job.id
}

function okReport(stage: (typeof PCB_CAM_STAGES)[number]) {
  return { stage, status: 'ok' as const, summary: `${stage} ok`, items: [], artifacts: [] }
}

describe('不变量 5:存储 key 必须带租户前缀', () => {
  it('其他租户/无前缀的 key 被拒绝(PCB_UPLOAD_INVALID)', async () => {
    const p = await createProject(t.db, ctx, { name: 'prefix' })
    await expect(createJob(t.db, ctx, p.id, { inputKeys: ['uploads/x.zip'] })).rejects.toMatchObject({ code: 'PCB_UPLOAD_INVALID' })
    await expect(createJob(t.db, ctx, p.id, { inputKeys: [`pcb-cam/other-tenant/x/input/x.zip`] })).rejects.toMatchObject({ code: 'PCB_UPLOAD_INVALID' })
    await expect(createJob(t.db, ctx, p.id, { inputKeys: [] })).rejects.toMatchObject({ code: 'PCB_UPLOAD_INVALID' })
  })
})

describe('不变量 1/2:stage 顺序单调,停等点必须由人解锁', () => {
  it('intake 后停在层确认;不确认就不推进;确认后进 order_spec 再停;确认后一路跑到 done', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'flow' })).id)
    const w = new FakeWorkerClient().on('intake', (i) => ({ ...okReport('intake'), layer_map: { 'top.gbr': { type: 'top_copper' } }, attempt: i.attempt }))
    w.on('order_spec', () => ({ ...okReport('order_spec'), order_spec_candidate: { thickness_mm: 1.6 } }))

    expect(await advanceOne(t.db, w, jobId)).toBe('intake')
    let j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('needs_review')
    expect(j.reviewReason).toBe('layers')
    expect(j.layerMap).toEqual({ 'top.gbr': { type: 'top_copper' } })
    expect(j.layerMapConfirmedAt).toBeNull()

    // 停等中不推进
    expect(await advanceOne(t.db, w, jobId)).toBeNull()
    expect(w.calls.length).toBe(1)

    // 错误的解锁路径被拒
    await expect(confirmOrderSpec(t.db, ctx, jobId, {})).rejects.toMatchObject({ code: 'PCB_INVALID_STATE' })
    await expect(submitEq(t.db, ctx, jobId)).rejects.toMatchObject({ code: 'PCB_INVALID_STATE' })

    j = await confirmLayers(t.db, ctx, jobId, { 'top.gbr': { type: 'top_copper', confirmed: true } })
    expect(j.status).toBe('running')
    expect(j.layerMapConfirmedAt).not.toBeNull()

    expect(await advanceOne(t.db, w, jobId)).toBe('order_spec')
    j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('needs_review')
    expect(j.reviewReason).toBe('order_spec')
    expect(j.orderSpecCandidate).toEqual({ thickness_mm: 1.6 })
    expect(j.orderSpec).toBeNull() // 不变量 4:候选不是事实

    await confirmOrderSpec(t.db, ctx, jobId, { thickness_mm: 1.6, confirmed: true })
    // 一路跑完
    for (let i = 0; i < PCB_CAM_STAGES.length; i++) await advanceOne(t.db, w, jobId)
    j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('done')
    expect(j.stages.map((s) => s.stage)).toEqual([...PCB_CAM_STAGES])

    // 顺序单调:每个 ok 的 stage,其前一个 stage 也 ok
    const runs = await t.db.select().from(pcbCamStageRuns).where(eq(pcbCamStageRuns.jobId, jobId))
    const okStages = new Set(runs.filter((r) => r.status === 'ok').map((r) => r.stage))
    for (const s of okStages) {
      const idx = stageIndex(s as (typeof PCB_CAM_STAGES)[number])
      if (idx > 0) expect(okStages.has(PCB_CAM_STAGES[idx - 1]!)).toBe(true)
    }
    // done 之后不再推进
    expect(await advanceOne(t.db, w, jobId)).toBeNull()
  })

  it('层未确认时不允许越过 order_spec 进入 align(不变量 4)', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'unconfirmed' })).id)
    // 直接把 job 摆成「intake ok 但没确认层、状态 running」的异常态
    const w = new FakeWorkerClient()
    await advanceOne(t.db, w, jobId) // intake → needs_review layers
    await t.db.update(pcbCamJobs).set({ status: 'running', reviewReason: null }).where(eq(pcbCamJobs.id, jobId))
    expect(await advanceOne(t.db, w, jobId)).toBe('order_spec') // order_spec 允许(不依赖层)
    await t.db.update(pcbCamJobs).set({ status: 'running', reviewReason: null }).where(eq(pcbCamJobs.id, jobId))
    expect(await advanceOne(t.db, w, jobId)).toBeNull() // align 被拦
    const j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('needs_review')
    expect(j.reviewReason).toBe('layers')
  })
})

describe('不变量 2:EQ 全部决策完才能放行', () => {
  it('error 项生成 EQ → needs_review(eq);有 pending 时 submit 抛 PCB_EQ_PENDING;决策完放行', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'eq' })).id)
    const w = new FakeWorkerClient()
      .on('intake', () => ({ ...okReport('intake'), layer_map: {} }))
      // align 先登记同 kind 同名、不同 storage key 的产物(模拟每个 stage 写在各自 output/<stage>/ 下重生成的 genesis 脚本):drill 再登记时只保留一条
      .on('align', () => ({ ...okReport('align'), artifacts: [{ kind: 'drill', path: `pcb-cam/${ctx.tenantId}/x/output/align/board.drl`, filename: 'board.drl', size: 5 }] }))
      .on('drill', () => ({
        stage: 'drill' as const,
        status: 'needs_review' as const, // 真实 worker 有 error 时报 needs_review;放行后必须前进而不是重跑 drill
        summary: '2 issues',
        items: [
          { id: 'extra-1', kind: 'extra_hole', severity: 'error' as const, message: '多余孔', fix: { type: 'delete', params: {}, auto_fixable: false, applied: false } },
          { id: 'slot-1', kind: 'slot', severity: 'warn' as const, message: '槽孔只在外形层', eq_question: '槽孔是否需要钻?' },
          { id: 'size-1', kind: 'oversize', severity: 'info' as const, message: '预大 0.15', fix: { type: 'resize', params: { d: 0.15 }, auto_fixable: true, applied: true } },
          // 本地引擎已做掉的项:哪怕发现时带了 EQ 文案,也没什么可决策的,不进 EQ(2026-09-07 演示里一半 EQ 是这种)
          { id: 'ring-1', kind: 'annular_ring', severity: 'error' as const, message: '隔离环 8mil(本地引擎已执行)', eq_question: '隔离环加大到 10mil?', fix: { type: 'resize', params: {}, auto_fixable: true, applied: true } },
          // 厂规开关的 ask 档(pcb 仓 Fix.confirm):引擎照做了,但这类改动工程师要求必须有人点过 → 已执行也进 EQ
          { id: 'plug-1', kind: 'drill_via_plug', severity: 'info' as const, message: '塞孔分组:3339 塞 / 23 开(本地引擎已执行,待确认)', eq_question: '塞孔分组按厂规做了,请确认', fix: { type: 'split', params: {}, auto_fixable: true, applied: true, confirm: true } },
        ],
        artifacts: [{ kind: 'drill', path: `pcb-cam/${ctx.tenantId}/x/output/drill/board.drl`, filename: 'board.drl', size: 10 }],
      }))
    await advanceOne(t.db, w, jobId)
    await confirmLayers(t.db, ctx, jobId, {})
    await advanceOne(t.db, w, jobId)
    await confirmOrderSpec(t.db, ctx, jobId, {})
    expect(await advanceOne(t.db, w, jobId)).toBe('align')
    expect(await advanceOne(t.db, w, jobId)).toBe('drill')

    let j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('needs_review')
    expect(j.reviewReason).toBe('eq')
    expect(j.eqTotal).toBe(3) // error 未修复 + 带 eq_question 的 warn + 已执行但 confirm 的 ask 档;已被执行器修掉且不要求确认的(不管有没有 eq_question)不进 EQ
    expect(j.eqPending).toBe(3)
    expect((await listArtifacts(t.db, ctx, jobId)).map((a) => a.kind)).toEqual(['drill'])

    await expect(submitEq(t.db, ctx, jobId)).rejects.toMatchObject({ code: 'PCB_EQ_PENDING' })
    expect(await advanceOne(t.db, w, jobId)).toBeNull()

    const items = await listEqItems(t.db, ctx, jobId)
    for (const it of items) await decideEqItem(t.db, ctx, jobId, it.id, { decision: it.itemId === 'slot-1' ? 'ask_customer' : 'manual', note: 'ok' })
    j = await submitEq(t.db, ctx, jobId)
    expect(j.status).toBe('running')
    expect(j.eqPending).toBe(0)
    expect(await advanceOne(t.db, w, jobId)).toBe('inner')
  })
})

describe('不变量 3:推进幂等,同一 (job, stage) 同时最多一个 running', () => {
  it('并发认领只产生一条 run;in-flight 期间再扫不重复调 worker', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'concurrent' })).id)
    const results = await Promise.all([claimNextStageRun(t.db, jobId), claimNextStageRun(t.db, jobId), claimNextStageRun(t.db, jobId)])
    expect(results.filter(Boolean).length).toBe(1)
    const runs = await t.db.select().from(pcbCamStageRuns).where(and(eq(pcbCamStageRuns.jobId, jobId), eq(pcbCamStageRuns.stage, 'intake')))
    expect(runs.length).toBe(1)
    expect(runs[0]!.status).toBe('running')
    // run 在跑:advanceAll 不会再调 worker
    const w = new FakeWorkerClient()
    await advanceAll(t.db, w)
    expect(w.calls.filter((c) => c.jobId === jobId).length).toBe(0)
  })
})

describe('不变量 6:worker 失败有界重试,不吞异常', () => {
  it(`失败 ${MAX_AUTO_RETRY} 次内自动重试(attempt 递增),超过后 job failed;人工 retry 后可继续`, async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'retry' })).id)
    const w = new FakeWorkerClient()
    for (let i = 0; i <= MAX_AUTO_RETRY; i++) {
      w.failNext = new Error(`boom ${i}`)
      expect(await advanceOne(t.db, w, jobId)).toBe('intake')
      const j = await getJob(t.db, ctx, jobId)
      expect(j.errorMessage).toContain(`boom ${i}`)
      expect(j.status).toBe(i < MAX_AUTO_RETRY ? 'running' : 'failed')
    }
    const runs = await t.db.select().from(pcbCamStageRuns).where(and(eq(pcbCamStageRuns.jobId, jobId), eq(pcbCamStageRuns.stage, 'intake')))
    expect(runs.map((r) => r.attempt).sort()).toEqual([1, 2, 3])
    expect(runs.every((r) => r.status === 'failed')).toBe(true)
    expect(await advanceOne(t.db, w, jobId)).toBeNull() // failed 不推进

    await retryStage(t.db, ctx, jobId, 'intake')
    w.on('intake', () => ({ ...okReport('intake'), layer_map: {} }))
    expect(await advanceOne(t.db, w, jobId)).toBe('intake')
    expect((await getJob(t.db, ctx, jobId)).status).toBe('needs_review')
  })

  it('worker 返回非法报告 → 记 failed 而不是崩溃', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'badreport' })).id)
    const w = new FakeWorkerClient().on('intake', () => ({ stage: 'drill', status: 'ok', summary: '', items: [], artifacts: [] }) as never)
    await advanceOne(t.db, w, jobId)
    const j = await getJob(t.db, ctx, jobId)
    expect(j.stages[0]?.status).toBe('failed')
    expect(j.status).toBe('running') // 第一次失败,还在自动重试窗口内
  })
})

describe('不变量 7:profile 快照', () => {
  it('job 创建后修改工厂标准,job 快照不变', async () => {
    const prof = await upsertFactoryProfile(t.db, ctx, { name: '厂A', yaml: 'drill:\n  plated: 0.15\n', isDefault: true })
    const p = await createProject(t.db, ctx, { name: 'snap', factoryProfileId: prof.id })
    const jobId = await createJobWithKeys(p.id)
    await upsertFactoryProfile(t.db, ctx, { id: prof.id, name: '厂A', yaml: 'drill:\n  plated: 0.20\n', isDefault: true })
    const rows = await t.db.select().from(pcbCamJobs).where(eq(pcbCamJobs.id, jobId))
    expect((rows[0]!.profileSnapshot as { yaml: string }).yaml).toContain('0.15')
  })
})

describe('不变量 8:禁物理删除;取消是状态', () => {
  it('cancel 后状态 cancelled,行仍在;done 后不能取消', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'cancel' })).id)
    const j = await cancelJob(t.db, ctx, jobId)
    expect(j.status).toBe('cancelled')
    expect((await t.db.select().from(pcbCamJobs).where(eq(pcbCamJobs.id, jobId))).length).toBe(1)
    await expect(cancelJob(t.db, ctx, jobId)).rejects.toMatchObject({ code: 'PCB_INVALID_STATE' })
    expect(await advanceOne(t.db, new FakeWorkerClient(), jobId)).toBeNull()
  })
})

describe('A 线:回读校验等 Genesis 主机 / 段确认点续投(A4.2)', () => {
  async function runToGatekeeper(w: FakeWorkerClient): Promise<string> {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'genesis' })).id)
    await advanceOne(t.db, w, jobId)
    await confirmLayers(t.db, ctx, jobId, {})
    await advanceOne(t.db, w, jobId)
    await confirmOrderSpec(t.db, ctx, jobId, {})
    for (let i = 0; i < PCB_CAM_STAGES.length; i++) {
      const j = await getJob(t.db, ctx, jobId)
      if (j.status !== 'running') break
      await advanceOne(t.db, w, jobId)
    }
    return jobId
  }
  const paused = (fromPart: number) => ({
    ...okReport('gatekeeper'),
    status: 'needs_review' as const,
    items: [
      {
        id: 'genesis_paused',
        kind: 'genesis_paused',
        severity: 'warn' as const,
        message: 'Genesis 在第 2/6 段末尾的确认点停下',
        eq_question: '请核对第 2 段后放行,系统投递第 3 段继续',
        fix: { type: 'genesis_resume', params: { from_part: fromPart, total_parts: 6 }, auto_fixable: false, applied: false },
      },
    ],
  })

  it('主机在段确认点停下 → EQ;接受并放行 → worker 续投该段,回读校验重跑一次而不是任务完成', async () => {
    let gate = 0
    const w = new FakeWorkerClient().on('gatekeeper', () => (++gate === 1 ? paused(3) : okReport('gatekeeper')))
    const jobId = await runToGatekeeper(w)
    let j = await getJob(t.db, ctx, jobId)
    expect(j.currentStage).toBe('gatekeeper')
    expect(j.status).toBe('needs_review')
    expect(j.eqTotal).toBe(1)
    // 还没决策:不会先把段投出去
    expect(await pendingGenesisAction(t.db, ctx, jobId)).toBeNull()
    const [eq] = await listEqItems(t.db, ctx, jobId)
    await decideEqItem(t.db, ctx, jobId, eq!.id, { decision: 'accept_fix' })
    expect(await pendingGenesisAction(t.db, ctx, jobId)).toEqual({ type: 'resume', fromPart: 3 })
    // routes 的顺序:先放行(校验状态)再续投 —— 反过来并发放行会删掉还没回填的主机结果
    j = await submitEq(t.db, ctx, jobId, { rerun: 'gatekeeper' })
    await w.genesisResume(jobId, 3)
    // 第二个人再放行会被拒(状态已经不是 needs_review),所以不会有第二次 resume
    await expect(submitEq(t.db, ctx, jobId, { rerun: 'gatekeeper' })).rejects.toMatchObject({ code: 'PCB_INVALID_STATE' })
    expect(w.genesisResumeCalls.length).toBe(1)
    expect(j.status).toBe('running')
    expect(j.currentStage).toBe('output')
    expect(await advanceOne(t.db, w, jobId)).toBe('gatekeeper')
    expect(gate).toBe(2)
    expect(w.genesisResumeCalls).toEqual([{ jobId, fromPart: 3 }])
    await advanceOne(t.db, w, jobId)
    j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('done')
    expect(j.stages.filter((s) => s.stage === 'gatekeeper').length).toBeGreaterThanOrEqual(1)
  })

  it('接受「等主机」→ 只重跑回读,不续投;「人工处理」→ 什么也不做,任务照常完成', async () => {
    const wait = () => ({
      ...okReport('gatekeeper'),
      status: 'needs_review' as const,
      items: [{ id: 'genesis_delivery', kind: 'genesis_delivery', severity: 'info' as const, message: '已投递', eq_question: '等主机跑完后放行', fix: { type: 'genesis_wait', params: {}, auto_fixable: false, applied: false } }],
    })
    let gate = 0
    const w = new FakeWorkerClient().on('gatekeeper', () => (++gate === 1 ? wait() : okReport('gatekeeper')))
    const jobId = await runToGatekeeper(w)
    const [eq] = await listEqItems(t.db, ctx, jobId)
    await decideEqItem(t.db, ctx, jobId, eq!.id, { decision: 'accept_fix' })
    expect(await pendingGenesisAction(t.db, ctx, jobId)).toEqual({ type: 'wait' })
    await submitEq(t.db, ctx, jobId, { rerun: 'gatekeeper' })
    expect(await advanceOne(t.db, w, jobId)).toBe('gatekeeper')
    expect(w.genesisResumeCalls).toEqual([])
    await advanceOne(t.db, w, jobId)
    expect((await getJob(t.db, ctx, jobId)).status).toBe('done')

    let gate2 = 0
    const w2 = new FakeWorkerClient().on('gatekeeper', () => (++gate2 === 1 ? paused(2) : okReport('gatekeeper')))
    const job2 = await runToGatekeeper(w2)
    const [eq2] = await listEqItems(t.db, ctx, job2)
    await decideEqItem(t.db, ctx, job2, eq2!.id, { decision: 'manual' })
    expect(await pendingGenesisAction(t.db, ctx, job2)).toBeNull()
    await submitEq(t.db, ctx, job2)
    await advanceOne(t.db, w2, job2)
    expect((await getJob(t.db, ctx, job2)).status).toBe('done')
    expect(gate2).toBe(1)
  })
})

describe('deriveJobStatusFromReport', () => {
  it('failed/blocked/eq/intake/order_spec/普通 的推导', () => {
    const base = { summary: '', items: [], artifacts: [] }
    expect(deriveJobStatusFromReport('drill', { stage: 'drill', status: 'failed', ...base })).toEqual({ status: 'failed', reviewReason: null })
    expect(deriveJobStatusFromReport('net_compare', { stage: 'net_compare', status: 'blocked', ...base })).toEqual({ status: 'blocked', reviewReason: 'blocked' })
    expect(deriveJobStatusFromReport('intake', { stage: 'intake', status: 'ok', ...base })).toEqual({ status: 'needs_review', reviewReason: 'layers' })
    expect(deriveJobStatusFromReport('order_spec', { stage: 'order_spec', status: 'ok', ...base })).toEqual({ status: 'needs_review', reviewReason: 'order_spec' })
    expect(deriveJobStatusFromReport('align', { stage: 'align', status: 'ok', ...base })).toEqual({ status: 'running', reviewReason: null })
    expect(
      deriveJobStatusFromReport('mask', {
        stage: 'mask',
        status: 'ok',
        ...base,
        items: [{ id: 'a', kind: 'bridge', severity: 'error', message: 'x', layer: null, location: null, measured: null, threshold: null, fix: null, eq_question: null }],
      }),
    ).toEqual({ status: 'needs_review', reviewReason: 'eq' })
  })
})

describe('LLM 层识别兜底(降级路径)', () => {
  const lm = () => ({
    files: [
      { file: 'top.gbr', type: 'top_copper', confidence: 0.98, reason: '%TF', needs_llm: false },
      { file: 'x.pho', type: 'unknown', confidence: 0.4, reason: 'no rule', needs_llm: true },
    ],
    unmapped: [{ file: 'y.art', reason: 'unrecognised', needs_llm: true }],
  })
  const job = { tenantId: 't', createdBy: 'e' } as never
  it('LLM 不可用/抛错 → 保持规则结果', async () => {
    const m = lm()
    const n = await mergeLlmLayerGuesses(null as never, job, m, async () => { throw new Error('no llm') })
    expect(n).toBe(0)
    expect(m.files[1]!.type).toBe('unknown')
    expect(m.unmapped).toHaveLength(1)
  })
  it('只问 needs_llm 的文件;高置信建议覆盖,unmapped 被认出的搬进 files,低于 0.8 仍标 needs_llm', async () => {
    const m = lm()
    let asked: string[] = []
    const n = await mergeLlmLayerGuesses(null as never, job, m, async (_db, _job, files) => {
      asked = files.map((f) => f.file)
      return [
        { file: 'x.pho', type: 'bottom_copper', index: 2, confidence: 0.9, reason: 'pho=光绘,x 像底层' },
        { file: 'y.art', type: 'top_silk', index: null, confidence: 0.6, reason: 'art' },
        { file: 'top.gbr', type: 'bottom_mask', index: null, confidence: 0.99, reason: '不该被问到' },
      ]
    })
    expect(asked).toEqual(['x.pho', 'y.art'])
    expect(n).toBe(2)
    expect(m.files.find((f) => f.file === 'x.pho')).toMatchObject({ type: 'bottom_copper', index: 2, confidence: 0.9, needs_llm: false })
    expect(m.files.find((f) => f.file === 'y.art')).toMatchObject({ type: 'top_silk', confidence: 0.6, needs_llm: true })
    expect(m.files.find((f) => f.file === 'top.gbr')!.type).toBe('top_copper')
    expect(m.unmapped).toHaveLength(0)
  })
})

describe('健壮性:非法 id 与未生成的层', () => {
  it('不是 uuid 的任务/项目/标准 id 当作找不到(404),不是 500', async () => {
    await expect(getJob(t.db, ctx, 'not-a-uuid')).rejects.toMatchObject({ code: 'PCB_JOB_NOT_FOUND' })
    await expect(getJob(t.db, ctx, '')).rejects.toMatchObject({ code: 'PCB_JOB_NOT_FOUND' })
    await expect(getJob(t.db, ctx, "'; drop table pcb_cam_jobs; --")).rejects.toMatchObject({ code: 'PCB_JOB_NOT_FOUND' })
    // 合法 uuid 但不存在 → 同一句话(不泄露存在性)
    await expect(getJob(t.db, ctx, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'PCB_JOB_NOT_FOUND' })
  })
})

describe('取消要生效:stage 还在跑的时候取消,回填不能把任务复活', () => {
  it('取消后 worker 回填报告 → 报告/产物落库,但任务仍是 cancelled,推进器不再接手', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'cancel-race' })).id)
    const w = new FakeWorkerClient()
    // 认领 intake(模拟"正在跑"),期间人点取消
    const claimed = await claimNextStageRun(t.db, jobId)
    expect(claimed).toBeTruthy()
    await cancelJob(t.db, ctx, jobId)
    expect((await getJob(t.db, ctx, jobId)).status).toBe('cancelled')
    // worker 这时才回来
    await completeStageRun(t.db, claimed!.run.id, {
      ...okReport('intake'),
      layer_map: { files: [] },
      artifacts: [{ kind: 'dfm_report', path: `${storagePrefix(ctx.tenantId, jobId)}output/intake/x.json`, filename: 'x.json', size: 3 }],
    })
    const j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('cancelled')
    expect(j.stages.find((s) => s.stage === 'intake')?.status).toBe('ok') // 跑过的记录留着
    expect((await listArtifacts(t.db, ctx, jobId)).length).toBe(1) // 产物也留着
    expect(await advanceOne(t.db, w, jobId)).toBeNull() // 不再被推进
  })

  it('取消后 worker 报错回填,也不把任务拉回 running', async () => {
    const jobId = await createJobWithKeys((await createProject(t.db, ctx, { name: 'cancel-race-2' })).id)
    const claimed = await claimNextStageRun(t.db, jobId)
    await cancelJob(t.db, ctx, jobId)
    await failStageRun(t.db, claimed!.run.id, 'worker 超时')
    const j = await getJob(t.db, ctx, jobId)
    expect(j.status).toBe('cancelled')
    expect(j.stages.find((s) => s.stage === 'intake')?.status).toBe('failed')
  })
})

describe('列表筛选:多状态 + 关键词', () => {
  it('status 数组按 IN 过滤,q 匹配项目名 / 客户名 / 任务 id 前缀', async () => {
    const p1 = await createProject(t.db, ctx, { name: '列表筛选-甲板', customerName: '华强电子' })
    const p2 = await createProject(t.db, ctx, { name: '列表筛选-乙板', customerName: null })
    const j1 = await createJobWithKeys(p1.id)
    const j2 = await createJobWithKeys(p2.id)
    await t.db.update(pcbCamJobs).set({ status: 'needs_review' }).where(eq(pcbCamJobs.id, j1))
    await t.db.update(pcbCamJobs).set({ status: 'blocked' }).where(eq(pcbCamJobs.id, j2))

    const mine = await listJobs(t.db, ctx, { limit: 50, status: ['needs_review', 'blocked'] })
    const ids = mine.items.map((j) => j.id)
    expect(ids).toContain(j1)
    expect(ids).toContain(j2)
    expect(mine.items.every((j) => j.status === 'needs_review' || j.status === 'blocked')).toBe(true)

    const single = await listJobs(t.db, ctx, { limit: 50, status: 'blocked' })
    expect(single.items.map((j) => j.id)).toContain(j2)
    expect(single.items.map((j) => j.id)).not.toContain(j1)

    expect((await listJobs(t.db, ctx, { limit: 50, q: '华强' })).items.map((j) => j.id)).toEqual([j1])
    expect((await listJobs(t.db, ctx, { limit: 50, q: '乙板' })).items.map((j) => j.id)).toEqual([j2])
    expect((await listJobs(t.db, ctx, { limit: 50, q: j2.slice(0, 8).toUpperCase() })).items.map((j) => j.id)).toEqual([j2])
    // LIKE 通配符按字面匹配,不当通配
    expect((await listJobs(t.db, ctx, { limit: 50, q: '%' })).items).toEqual([])
  })
})

describe('成果物打包', () => {
  it('deliverables 只打交付类,按 kind/ 分目录;all 连过程数据;没东西打抛 PCB_NO_ARTIFACTS', async () => {
    const p = await createProject(t.db, ctx, { name: '打包' })
    const jobId = await createJobWithKeys(p.id)
    await expect(packArtifacts(t.db, ctx, jobId, 'deliverables')).rejects.toMatchObject({ code: 'PCB_NO_ARTIFACTS' })

    const keyPrefix = `${storagePrefix(ctx.tenantId, jobId)}output/drill`
    const drl = await putObject(t.db, ctx, { bytes: Buffer.from('M48\nT1C0.3\n%\nT1\nX1Y1\nM30\n'), filename: 'board.TXT', contentType: 'text/plain', keyPrefix, visibility: 'private' })
    const json = await putObject(t.db, ctx, { bytes: Buffer.from('{"holes":1}'), filename: 'drill_table.json', contentType: 'application/json', keyPrefix, visibility: 'private' })
    const claimed = await claimNextStageRun(t.db, jobId)
    await completeStageRun(t.db, claimed!.run.id, {
      ...okReport('intake'),
      artifacts: [
        { kind: 'drill', path: drl.key, filename: `${jobId}_panel.TXT`, size: 30 },
        { kind: 'dfm_report', path: json.key, filename: 'drill_table.json', size: 11 },
      ],
    })

    const names = (zip: Buffer) => {
      const count = zip.readUInt16LE(zip.length - 12)
      let q = zip.readUInt32LE(zip.length - 6)
      const out: string[] = []
      for (let i = 0; i < count; i++) {
        const nlen = zip.readUInt16LE(q + 28)
        out.push(zip.subarray(q + 46, q + 46 + nlen).toString('utf8'))
        q += 46 + nlen + zip.readUInt16LE(q + 30) + zip.readUInt16LE(q + 32)
      }
      return out
    }
    const d = await packArtifacts(t.db, ctx, jobId, 'deliverables')
    expect(d.count).toBe(1)
    expect(d.filename).toBe(`cam-${jobId.slice(0, 8)}-deliverables.zip`)
    // 文件名里的任务 uuid 在包内缩成 8 位
    expect(names(d.bytes)).toEqual([`drill/${jobId.slice(0, 8)}_panel.TXT`])
    // 第一个本地头后面就是 deflate 数据,解出来得是钻带原文
    const nlen = d.bytes.readUInt16LE(26)
    const csize = d.bytes.readUInt32LE(18)
    expect(inflateRawSync(d.bytes.subarray(30 + nlen, 30 + nlen + csize)).toString()).toContain('M48')

    const a = await packArtifacts(t.db, ctx, jobId, 'all')
    expect(names(a.bytes)).toEqual([`drill/${jobId.slice(0, 8)}_panel.TXT`, 'dfm_report/drill_table.json'])
  })
})
