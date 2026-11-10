// modules/pcb-cam/automation.ts
// 推进器:定时扫 pending/running 的 job,认领下一 stage → 调 pcb-worker → 落报告。
// 幂等/并发安全由 logic.claimNextStageRun 的行锁 + stage_runs 唯一索引保证(不变量 3);
// 本进程内再加一把 inFlight 锁,避免 10s 间隔与 5 分钟的 stage 叠出多个扫描循环。
import type { Db } from '../../core/db/client'
import { registerJob } from '../../core/scheduler'
import type { Ctx } from '../../core/db/client'
import { claimNextStageRun, completeStageRun, confirmLayers, confirmOrderSpec, decideEqItem, failStageRun, getJob, listAdvancableJobIds, listEqItems, storagePrefix, submitEq } from './logic'
import type { PcbCamJob } from './model'
import { extractOrderSpec, guessLayersWithLlm, type LlmLayerGuess, type OrderSpecExtractor } from './llm'
import type { PcbCamStage } from './stages'
import { createHttpWorkerClient, WorkerClientError, type PcbWorkerClient } from './worker-client'

export const ADVANCE_JOB_NAME = 'pcb-cam:advance'
export const ADVANCE_INTERVAL_MS = 10_000

let inFlight = false

export type AdvanceDeps = { extractOrderSpec?: OrderSpecExtractor; guessLayers?: LayerGuesser }

/**
 * 推进一个 job 一步。返回跑了哪个 stage;null = 没有可推进的。
 * order_spec 阶段:Node 侧先用 LLM 读附件出候选(不抛错,不可用时降级),再把候选交给 worker 与 Excellon 比对;
 * worker 没回填候选时用 Node 的候选。候选只进 order_spec_candidate,不进事实(不变量 4)。
 */
export async function advanceOne(db: Db, client: PcbWorkerClient, jobId: string, deps: AdvanceDeps = {}): Promise<PcbCamStage | null> {
  const claimed = await claimNextStageRun(db, jobId)
  if (!claimed) return null
  const { job, run, stage } = claimed
  const snapshot = job.profileSnapshot as { yaml?: string } | null
  try {
    const candidate = stage === 'order_spec' ? await (deps.extractOrderSpec ?? extractOrderSpec)(db, job) : null
    const report = await client.runStage({
      jobId: job.id,
      tenantId: job.tenantId,
      stage,
      attempt: run.attempt,
      inputKeys: job.inputKeys,
      layerMap: job.layerMap ?? null,
      // order_spec 阶段把候选放在 orderSpec 位上给 worker 比对(worker 契约:该阶段 order_spec = 候选)
      orderSpec: stage === 'order_spec' ? candidate : (job.orderSpec ?? null),
      profileYaml: typeof snapshot?.yaml === 'string' ? snapshot.yaml : null,
      outputPrefix: `${storagePrefix(job.tenantId, job.id)}output/${stage}/`,
    })
    // 契约防线(不依赖具体 client 实现):报告必须是本 stage 的,否则按 worker 失败处理
    if (report.stage !== stage) {
      throw new WorkerClientError('WORKER_BAD_REPORT', `pcb-worker 返回了别的 stage 的报告(${report.stage},期望 ${stage})`)
    }
    if (stage === 'order_spec' && !report.order_spec_candidate && candidate) report.order_spec_candidate = candidate
    // intake 阶段:规则识别不到 / 低置信的文件交给 LLM 兜底(core/llm 场景 pcb_cam);LLM 不可用或答非所问就保持规则结果,
    // 人工在层确认表里定。LLM 只出「候选」:写进 layer_map 的 confidence/reason,仍需人确认(不变量 4)
    if (stage === 'intake' && report.layer_map) {
      await mergeLlmLayerGuesses(db, job, report.layer_map as LayerMapLike, deps.guessLayers ?? guessLayersWithLlm)
    }
    await completeStageRun(db, run.id, report)
  } catch (err) {
    await failStageRun(db, run.id, err instanceof Error ? err.message : String(err))
  }
  return stage
}

type LayerMapLike = {
  files?: Array<{ file: string; type: string; index?: number | null; confidence?: number; reason?: string; needs_llm?: boolean; head?: string }>
  unmapped?: Array<{ file: string; reason?: string; needs_llm?: boolean; confidence?: number; head?: string }>
}
export type LayerGuesser = (db: Db, job: PcbCamJob, files: Array<{ file: string; head?: string; reason?: string }>) => Promise<LlmLayerGuess[]>

/**
 * 把 LLM 的层识别建议合并进 intake 的 layer_map(就地修改,返回采纳条数)。
 * 只碰 needs_llm 的条目;只有 LLM 置信度高于规则结果才覆盖;unmapped 里被认出的搬进 files。
 */
export async function mergeLlmLayerGuesses(db: Db, job: PcbCamJob, lm: LayerMapLike, guess: LayerGuesser): Promise<number> {
  const files = lm.files ?? []
  const unmapped = lm.unmapped ?? []
  const ask = [...files.filter((f) => f.needs_llm), ...unmapped.filter((u) => u.needs_llm !== false)].map((f) => ({ file: f.file, head: f.head, reason: f.reason }))
  if (ask.length === 0) return 0
  let guesses: LlmLayerGuess[] = []
  try {
    guesses = await guess(db, job, ask)
  } catch {
    return 0 // 降级:没有 LLM 就保持规则结果
  }
  const askedSet = new Set(ask.map((a) => a.file))
  let adopted = 0
  for (const g of guesses) {
    if (!g.file || !askedSet.has(g.file) || g.type === 'unknown' || g.confidence <= 0) continue // 没问的文件不接受建议
    const f = files.find((x) => x.file === g.file)
    if (f) {
      if ((f.confidence ?? 0) >= g.confidence) continue
      Object.assign(f, { type: g.type, index: g.index ?? f.index ?? null, confidence: g.confidence, reason: `LLM 建议:${g.reason}`, needs_llm: g.confidence < 0.8 })
      adopted++
      continue
    }
    const ui = unmapped.findIndex((x) => x.file === g.file)
    if (ui >= 0) {
      unmapped.splice(ui, 1)
      files.push({ file: g.file, type: g.type, index: g.index ?? null, confidence: g.confidence, reason: `LLM 建议:${g.reason}`, needs_llm: g.confidence < 0.8 })
      adopted++
    }
  }
  lm.files = files
  lm.unmapped = unmapped
  return adopted
}

// ── 演示自动驾驶(seed.ts 造的案例任务)──
// 真实任务每到人工节点都停;演示任务替人点「确认层 / 确认规格 / 接受问题点」,直到设计好的停点。
// 只存在于本进程内存(演示模式的库也是内存的),生产环境没有人往这里登记,等于不存在。
export type DemoStop = 'layers' | 'order_spec' | `eq:${PcbCamStage}` | 'none'
export type DemoAutopilot = { ctx: Ctx; stopAt: DemoStop; orderSpec?: Record<string, unknown> | null }
const demoJobs = new Map<string, DemoAutopilot>()
export function registerDemoAutopilot(jobId: string, a: DemoAutopilot): void {
  demoJobs.set(jobId, a)
}
export function demoAutopilotSize(): number {
  return demoJobs.size
}
/** 每个登记的演示任务推一把;返回动了几个。停点、终态、阻断都不再碰。 */
export async function runDemoAutopilot(db: Db): Promise<number> {
  let moved = 0
  for (const [jobId, a] of [...demoJobs]) {
    try {
      const job = await getJob(db, a.ctx, jobId)
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'blocked') {
        demoJobs.delete(jobId)
        continue
      }
      if (job.status !== 'needs_review') continue
      if (job.reviewReason === 'layers') {
        if (a.stopAt === 'layers') continue
        await confirmLayers(db, a.ctx, jobId, { ...(job.layerMap ?? {}), confirmed: true })
      } else if (job.reviewReason === 'order_spec') {
        if (a.stopAt === 'order_spec') continue
        await confirmOrderSpec(db, a.ctx, jobId, { ...((job.orderSpecCandidate as Record<string, unknown> | null) ?? {}), ...(a.orderSpec ?? {}), confirmed: true })
      } else if (job.reviewReason === 'eq') {
        if (a.stopAt === `eq:${job.currentStage}`) continue
        for (const it of await listEqItems(db, a.ctx, jobId)) {
          if (it.decision !== 'pending') continue
          const fix = (it.suggestedFix ?? null) as { type?: string; auto_fixable?: boolean } | null
          // 主机类问题点(等待/续投)在演示环境没有 Genesis 主机可等 → 走人工,任务按本地结果收尾
          const genesis = fix?.type === 'genesis_wait' || fix?.type === 'genesis_resume'
          const decision = !genesis && fix?.auto_fixable ? 'accept_fix' : 'manual'
          await decideEqItem(db, a.ctx, jobId, it.id, { decision, note: '演示自动驾驶' })
        }
        await submitEq(db, a.ctx, jobId)
      } else {
        continue
      }
      moved++
    } catch (err) {
      console.error(`[pcb-cam] demo autopilot ${jobId}: ${err instanceof Error ? err.message : String(err)}`)
      demoJobs.delete(jobId)
    }
  }
  return moved
}

/** 扫一轮:每个可推进 job 推一步。抛错由 scheduler 记入 lastError;单个 job 出错不影响其他。 */
export async function advanceAll(db: Db, client: PcbWorkerClient, limit = 20, deps: AdvanceDeps = {}): Promise<{ advanced: number; errors: number }> {
  if (inFlight) return { advanced: 0, errors: 0 }
  inFlight = true
  let advanced = 0
  let errors = 0
  try {
    const ids = await listAdvancableJobIds(db, limit)
    for (const id of ids) {
      try {
        if (await advanceOne(db, client, id, deps)) advanced++
      } catch (err) {
        errors++
        console.error(`[pcb-cam] advance job ${id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (demoJobs.size > 0) await runDemoAutopilot(db)
  } finally {
    inFlight = false
  }
  return { advanced, errors }
}

/** server.ts 在 startScheduler 之前调用一次。测试不经 server.ts,直接调 advanceAll/advanceOne。 */
export function registerPcbCamJobs(client: PcbWorkerClient = createHttpWorkerClient()): void {
  registerJob({
    name: ADVANCE_JOB_NAME,
    intervalMs: ADVANCE_INTERVAL_MS,
    run: async (db) => {
      await advanceAll(db, client)
    },
  })
}
