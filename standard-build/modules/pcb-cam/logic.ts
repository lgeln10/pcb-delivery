// modules/pcb-cam/logic.ts
// PCB CAM:项目/任务 CRUD + job 状态机 + stage 推进(供 automation.ts 调用)+ 人工停等点解锁。
// 不变量见 MODULE.md;每条在 tests/pcb-cam.test.ts 有断言。
// 数据范围:CAM 资料是工程部共享资产,按租户隔离即可(不按 created_by 过滤);getDataScope 留到多工厂推广时再接。
import { randomUUID } from 'node:crypto'
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../../core/db/client'
import { auditedUpdate, scope } from '../../core/db/soft-delete'
import { PcbCamError, jobNotFound } from './errors'
import {
  pcbCamArtifacts,
  pcbCamEqItems,
  pcbCamFactoryProfiles,
  pcbCamJobs,
  pcbCamProjects,
  pcbCamStageRuns,
  type PcbCamArtifactKind,
  type PcbCamEqDecision,
  type PcbCamEqItem,
  type PcbCamJob,
  type PcbCamJobStatus,
  type PcbCamProject,
  type PcbCamStageRun,
  PCB_CAM_ARTIFACT_KINDS,
  PCB_CAM_DELIVERABLE_KINDS,
} from './model'
import { nextStage, prevStage, PCB_CAM_STAGES, STAGES_REQUIRE_REVIEW_AFTER, type PcbCamStage } from './stages'
import type { StageReport } from './worker-types'
import { readObject } from '../../core/storage/api'
import { getEmployeeNames } from '../../core/org/api'
import { buildZip, type ZipEntry } from './zip'
import { ITEM_KIND_LABEL } from './ui/labels'

/** worker 调用失败的自动重试上限(超过后 job → failed,只能人工重跑)。 */
export const MAX_AUTO_RETRY = 2

// ── DTO ────────────────────────────────────────────────────────────────────────

export type StageRunSummary = {
  id: string
  stage: PcbCamStage
  attempt: number
  status: PcbCamStageRun['status']
  summary: string
  itemCount: number
  errorCount: number
  warnCount: number
  /** 要人拍板的项(与 itemNeedsDecision 同规则;处理过的也算,表示这步停过) */
  decisionCount: number
  /** 报告项里 fix.applied 的条数(本地引擎 / Genesis 已做掉的发现) */
  appliedCount: number
  /** 本地几何引擎在这步执行的改图操作数(报告项 native_applied 的 measured) */
  nativeOps: number
  startedAt: Date
  finishedAt: Date | null
  durationMs: number | null
  errorMessage: string | null
}

export type JobDTO = {
  id: string
  projectId: string
  /** 随行带出项目名:列表页不必再用有上限的项目列表 .find() 反查 */
  projectName: string
  status: PcbCamJobStatus
  currentStage: PcbCamStage | null
  reviewReason: string | null
  inputKeys: string[]
  layerMap: Record<string, unknown> | null
  layerMapConfirmedAt: Date | null
  orderSpecCandidate: Record<string, unknown> | null
  orderSpec: Record<string, unknown> | null
  retryCount: number
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
  stages: StageRunSummary[]
  eqPending: number
  eqTotal: number
  /** 一键「放行并下发」过的时间(null = 还没下发) */
  releasedAt: Date | null
}

export type EqItemDTO = {
  id: string
  stage: PcbCamStage
  itemId: string
  severity: PcbCamEqItem['severity']
  message: string
  suggestedFix: Record<string, unknown> | null
  decision: PcbCamEqDecision
  decidedBy: string | null
  decidedAt: Date | null
  note: string | null
  /** 报告项类型(决策记忆、批量按组判都靠它) */
  kind: string
  customerReply: string | null
  customerReplyAt: Date | null
}

/** 老行没存 kind:按 item_id 前缀推(与 ui/labels.ts eqItemLabel 同一规则,取最长匹配)。 */
export function kindOfItemId(itemId: string, stored?: string | null): string {
  if (stored) return stored
  const hit = Object.keys(ITEM_KIND_LABEL).filter((k) => itemId.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return hit ?? itemId.replace(/_\d+$/, '')
}

export type ArtifactDTO = {
  id: string
  stageRunId: string | null
  /** 出这个文件的 stage(drill 阶段的过程钻带 vs output 阶段按厂规命名的钻带都是 kind=drill) */
  stage: string | null
  kind: PcbCamArtifactKind
  storageKey: string
  filename: string
  size: number
  contentType: string | null
  createdAt: Date
}

// ── 游标分页(created_at desc, id desc)────────────────────────────────────────

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}
function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const i = raw.indexOf('|')
  if (i < 0) return null
  const d = new Date(raw.slice(0, i))
  if (Number.isNaN(d.getTime())) return null
  return { createdAt: d, id: raw.slice(i + 1) }
}

// ── 项目 ───────────────────────────────────────────────────────────────────────

export async function createProject(
  db: Db,
  ctx: Ctx,
  input: { name: string; customerName?: string | null; factoryProfileId?: string | null },
): Promise<PcbCamProject> {
  const name = input.name.trim()
  if (!name) throw new PcbCamError('PCB_UPLOAD_INVALID', '项目名称不能为空。')
  if (input.factoryProfileId) {
    const p = await db
      .select({ id: pcbCamFactoryProfiles.id })
      .from(pcbCamFactoryProfiles)
      .where(and(scope(pcbCamFactoryProfiles, ctx.tenantId), eq(pcbCamFactoryProfiles.id, input.factoryProfileId)))
      .limit(1)
    if (!p[0]) throw new PcbCamError('PCB_PROFILE_INVALID', '指定的工厂标准不存在。')
  }
  const rows = await db
    .insert(pcbCamProjects)
    .values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      name,
      customerName: input.customerName?.trim() || null,
      factoryProfileId: input.factoryProfileId ?? null,
      status: 'active',
    })
    .returning()
  return rows[0]!
}

export async function listProjects(
  db: Db,
  ctx: Ctx,
  opts: { limit: number; cursor?: string; status?: PcbCamProject['status'] },
): Promise<{ items: PcbCamProject[]; nextCursor: string | null }> {
  const conds = [scope(pcbCamProjects, ctx.tenantId)]
  if (opts.status) conds.push(eq(pcbCamProjects.status, opts.status))
  const c = decodeCursor(opts.cursor)
  if (c) conds.push(sql`(${pcbCamProjects.createdAt}, ${pcbCamProjects.id}) < (${c.createdAt}, ${c.id}::uuid)`)
  const rows = await db
    .select()
    .from(pcbCamProjects)
    .where(and(...conds))
    .orderBy(desc(pcbCamProjects.createdAt), desc(pcbCamProjects.id))
    .limit(opts.limit + 1)
  const items = rows.slice(0, opts.limit)
  const last = items[items.length - 1]
  return { items, nextCursor: rows.length > opts.limit && last ? encodeCursor(last.createdAt, last.id) : null }
}

export async function getProject(db: Db, ctx: Ctx, id: string): Promise<PcbCamProject> {
  const rows = await db
    .select()
    .from(pcbCamProjects)
    .where(and(scope(pcbCamProjects, ctx.tenantId), eq(pcbCamProjects.id, assertId(id))))
    .limit(1)
  if (!rows[0]) throw jobNotFound()
  return rows[0]
}

// ── 工厂标准 ───────────────────────────────────────────────────────────────────

export async function listFactoryProfiles(db: Db, ctx: Ctx): Promise<Array<Pick<typeof pcbCamFactoryProfiles.$inferSelect, 'id' | 'name' | 'schemaVersion' | 'isDefault' | 'updatedAt'>>> {
  return db
    .select({
      id: pcbCamFactoryProfiles.id,
      name: pcbCamFactoryProfiles.name,
      schemaVersion: pcbCamFactoryProfiles.schemaVersion,
      isDefault: pcbCamFactoryProfiles.isDefault,
      updatedAt: pcbCamFactoryProfiles.updatedAt,
    })
    .from(pcbCamFactoryProfiles)
    .where(scope(pcbCamFactoryProfiles, ctx.tenantId))
    .orderBy(desc(pcbCamFactoryProfiles.isDefault), desc(pcbCamFactoryProfiles.updatedAt))
    .limit(50)
}

export async function getFactoryProfile(db: Db, ctx: Ctx, id: string) {
  const rows = await db
    .select()
    .from(pcbCamFactoryProfiles)
    .where(and(scope(pcbCamFactoryProfiles, ctx.tenantId), eq(pcbCamFactoryProfiles.id, assertId(id))))
    .limit(1)
  if (!rows[0]) throw new PcbCamError('PCB_PROFILE_INVALID', '工厂标准不存在。')
  return rows[0]
}

export async function upsertFactoryProfile(
  db: Db,
  ctx: Ctx,
  input: { id?: string; name: string; yaml: string; schemaVersion?: string; isDefault?: boolean },
) {
  const name = input.name.trim()
  if (!name) throw new PcbCamError('PCB_PROFILE_INVALID', '工厂标准名称不能为空。')
  if (!input.yaml.trim()) throw new PcbCamError('PCB_PROFILE_INVALID', '工厂标准内容不能为空。')
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx
        .update(pcbCamFactoryProfiles)
        .set({ isDefault: false, updatedBy: ctx.employeeId, updatedAt: new Date() })
        .where(and(scope(pcbCamFactoryProfiles, ctx.tenantId), eq(pcbCamFactoryProfiles.isDefault, true)))
    }
    if (input.id) {
      await getFactoryProfile(tx, ctx, input.id)
      await auditedUpdate(tx, pcbCamFactoryProfiles, ctx.tenantId, input.id, ctx.employeeId, {
        name,
        yaml: input.yaml,
        schemaVersion: input.schemaVersion ?? '1',
        isDefault: input.isDefault ?? false,
      })
      return getFactoryProfile(tx, ctx, input.id)
    }
    const rows = await tx
      .insert(pcbCamFactoryProfiles)
      .values({
        id: randomUUID(),
        tenantId: ctx.tenantId,
        createdBy: ctx.employeeId,
        updatedBy: ctx.employeeId,
        name,
        yaml: input.yaml,
        schemaVersion: input.schemaVersion ?? '1',
        isDefault: input.isDefault ?? false,
      })
      .returning()
    return rows[0]!
  })
}

// ── Job:创建 / 查询 ─────────────────────────────────────────────────────────────

/**
 * 建 job。profile 快照在此固化(不变量 7):优先项目指定的 profile,其次租户默认,都没有则 null(worker 用内置 default.yaml)。
 * 上传文件由 routes 先 putObject,再把 storage key 传进来;key 必须带租户前缀(不变量 5)。
 */
export async function createJob(db: Db, ctx: Ctx, projectId: string, input: { jobId?: string; inputKeys: string[] }): Promise<PcbCamJob> {
  const project = await getProject(db, ctx, projectId)
  if (input.inputKeys.length === 0) throw new PcbCamError('PCB_UPLOAD_INVALID', '至少要上传一个资料文件。')
  // routes 先生成 jobId 再上传到该前缀,所以允许调用方指定;不指定则这里生成(此时 key 前缀校验必然失败,仅供内部/测试用)
  const jobId = input.jobId ?? randomUUID()
  const prefix = storagePrefix(ctx.tenantId, jobId)
  const bad = input.inputKeys.find((k) => !k.startsWith(prefix))
  if (bad) throw new PcbCamError('PCB_UPLOAD_INVALID', '上传文件的存储路径不合法。')

  let snapshot: Record<string, unknown> | null = null
  const profileRows = project.factoryProfileId
    ? await db
        .select()
        .from(pcbCamFactoryProfiles)
        .where(and(scope(pcbCamFactoryProfiles, ctx.tenantId), eq(pcbCamFactoryProfiles.id, project.factoryProfileId)))
        .limit(1)
    : await db
        .select()
        .from(pcbCamFactoryProfiles)
        .where(and(scope(pcbCamFactoryProfiles, ctx.tenantId), eq(pcbCamFactoryProfiles.isDefault, true)))
        .limit(1)
  if (profileRows[0]) {
    snapshot = { profileId: profileRows[0].id, name: profileRows[0].name, schemaVersion: profileRows[0].schemaVersion, yaml: profileRows[0].yaml }
  }

  const rows = await db
    .insert(pcbCamJobs)
    .values({
      id: jobId,
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      projectId,
      status: 'pending',
      currentStage: null,
      inputKeys: input.inputKeys,
      profileSnapshot: snapshot,
    })
    .returning()
  return rows[0]!
}

/** 所有产物/输入的对象存储前缀(不变量 5)。 */
export function storagePrefix(tenantId: string, jobId: string): string {
  return `pcb-cam/${tenantId}/${jobId}/`
}

/**
 * id 列是 uuid:把不是 uuid 的串丢给 Postgres 会抛 22P02 → 500「系统内部出错」。手打/过期链接不该
 * 长成系统故障,当作「找不到」处理(与不在租户/不在数据范围同一句话,不泄露存在性)。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function assertId(id: string): string {
  if (!UUID_RE.test(id)) throw jobNotFound()
  return id
}

async function getJobRow(db: Db, tenantId: string, id: string): Promise<PcbCamJob> {
  const rows = await db
    .select()
    .from(pcbCamJobs)
    .where(and(scope(pcbCamJobs, tenantId), eq(pcbCamJobs.id, assertId(id))))
    .limit(1)
  if (!rows[0]) throw jobNotFound()
  return rows[0]
}

function summarizeRun(r: PcbCamStageRun): StageRunSummary {
  const report = (r.report ?? null) as Partial<StageReport> | null
  const items = Array.isArray(report?.items) ? report.items : []
  return {
    id: r.id,
    stage: r.stage as PcbCamStage,
    attempt: r.attempt,
    status: r.status,
    summary: typeof report?.summary === 'string' ? report.summary : '',
    itemCount: items.length,
    errorCount: items.filter((i) => i.severity === 'error').length,
    warnCount: items.filter((i) => i.severity === 'warn').length,
    decisionCount: items.filter((i) => itemNeedsDecision(i as StageReport['items'][number])).length,
    appliedCount: items.filter((i) => i.fix?.applied).length,
    nativeOps: items.filter((i) => i.kind === 'native_applied').reduce((a, i) => a + (typeof i.measured === 'number' ? i.measured : 0), 0),
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    errorMessage: r.errorMessage,
  }
}

/** job + 每个 stage 最新一次 attempt 的摘要 + EQ 计数。 */
export async function getJob(db: Db, ctx: Ctx, id: string): Promise<JobDTO> {
  const job = await getJobRow(db, ctx.tenantId, id)
  const runs = await db
    .select()
    .from(pcbCamStageRuns)
    .where(and(scope(pcbCamStageRuns, ctx.tenantId), eq(pcbCamStageRuns.jobId, id)))
    .orderBy(desc(pcbCamStageRuns.attempt))
  const latestByStage = new Map<string, PcbCamStageRun>()
  for (const r of runs) if (!latestByStage.has(r.stage)) latestByStage.set(r.stage, r)
  const stages = PCB_CAM_STAGES.flatMap((s) => {
    const r = latestByStage.get(s)
    return r ? [summarizeRun(r)] : []
  })
  const eqRows = await db
    .select({ decision: pcbCamEqItems.decision, n: sql<number>`count(*)::int` })
    .from(pcbCamEqItems)
    .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, id)))
    .groupBy(pcbCamEqItems.decision)
  const eqTotal = eqRows.reduce((a, r) => a + Number(r.n), 0)
  const eqPending = Number(eqRows.find((r) => r.decision === 'pending')?.n ?? 0)
  const proj = await db
    .select({ name: pcbCamProjects.name })
    .from(pcbCamProjects)
    .where(eq(pcbCamProjects.id, job.projectId))
    .limit(1)
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: proj[0]?.name ?? job.projectId.slice(0, 8),
    status: job.status as PcbCamJobStatus,
    currentStage: (job.currentStage as PcbCamStage | null) ?? null,
    reviewReason: job.reviewReason,
    inputKeys: job.inputKeys,
    layerMap: job.layerMap ?? null,
    layerMapConfirmedAt: job.layerMapConfirmedAt,
    orderSpecCandidate: job.orderSpecCandidate ?? null,
    orderSpec: job.orderSpec ?? null,
    retryCount: job.retryCount,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stages,
    eqPending,
    eqTotal,
    releasedAt: job.releasedAt ?? null,
  }
}

/** 列表行 = job + 项目名 + 待我判几条(队列排序和「要我判几条」列都要它) */
export type JobListRow = PcbCamJob & { projectName: string; customerName: string | null; eqPending: number }

/** 队列位次:该谁动排前面 —— 待确认 0 / 阻断 1 / 失败 2 / 处理中 3 / 排队 4 / 完成 5 / 取消 6 */
const QUEUE_RANK = sql<number>`case ${pcbCamJobs.status} when 'needs_review' then 0 when 'blocked' then 1 when 'failed' then 2 when 'running' then 3 when 'pending' then 4 when 'done' then 5 else 6 end`
const EQ_PENDING_SUB = sql<number>`(select count(*) from pcb_cam_eq_items e where e.job_id = ${pcbCamJobs.id} and e.decision = 'pending' and e.is_deleted = false)::int`

function encodeQueueCursor(rank: number, updatedAt: Date, id: string): string {
  return Buffer.from(`q|${rank}|${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}
function decodeQueueCursor(cursor: string | undefined): { rank: number; updatedAt: Date; id: string } | null {
  if (!cursor) return null
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const parts = raw.split('|')
  if (parts.length !== 4 || parts[0] !== 'q') return null
  const d = new Date(parts[2]!)
  if (Number.isNaN(d.getTime())) return null
  return { rank: Number(parts[1]), updatedAt: d, id: parts[3]! }
}

/**
 * 任务列表。``sort: 'queue'``(工作队列,默认):按「该谁动」排 —— 待我拍板的在最前,同档里等得最久的在前;
 * ``sort: 'newest'``:按创建时间倒序(老的「全部」视图)。两种排序各自有游标。
 */
export async function listJobs(
  db: Db,
  ctx: Ctx,
  opts: { limit: number; cursor?: string; projectId?: string; status?: PcbCamJobStatus | PcbCamJobStatus[]; q?: string; sort?: 'queue' | 'newest' },
): Promise<{ items: JobListRow[]; nextCursor: string | null }> {
  const conds = [scope(pcbCamJobs, ctx.tenantId)]
  if (opts.projectId) conds.push(eq(pcbCamJobs.projectId, opts.projectId))
  // 列表的「需要我处理」快捷筛选 = 待确认 + 已阻断 两个状态,所以这里收数组
  if (Array.isArray(opts.status)) {
    if (opts.status.length) conds.push(inArray(pcbCamJobs.status, opts.status))
  } else if (opts.status) conds.push(eq(pcbCamJobs.status, opts.status))
  // 关键词:项目名 / 客户名 / 任务 id 前缀(工程师之间口头说的就是「那个 f8f4 的板」)
  const kw = opts.q?.trim()
  if (kw) {
    const esc = kw.replace(/[%_\\]/g, '\\$&')
    conds.push(or(ilike(pcbCamProjects.name, `%${esc}%`), ilike(pcbCamProjects.customerName, `%${esc}%`), sql`${pcbCamJobs.id}::text ilike ${esc.toLowerCase() + '%'}`)!)
  }
  const queue = (opts.sort ?? 'queue') === 'queue'
  if (queue) {
    const c = decodeQueueCursor(opts.cursor)
    if (c) conds.push(sql`(${QUEUE_RANK}, ${pcbCamJobs.updatedAt}, ${pcbCamJobs.id}) > (${c.rank}, ${c.updatedAt}, ${c.id}::uuid)`)
  } else {
    const c = decodeCursor(opts.cursor)
    if (c) conds.push(sql`(${pcbCamJobs.createdAt}, ${pcbCamJobs.id}) < (${c.createdAt}, ${c.id}::uuid)`)
  }
  const rows = (
    await db
      .select({ job: pcbCamJobs, projectName: pcbCamProjects.name, customerName: pcbCamProjects.customerName, rank: QUEUE_RANK, eqPending: EQ_PENDING_SUB })
      .from(pcbCamJobs)
      .leftJoin(pcbCamProjects, eq(pcbCamProjects.id, pcbCamJobs.projectId))
      .where(and(...conds))
      .orderBy(...(queue ? [QUEUE_RANK, pcbCamJobs.updatedAt, pcbCamJobs.id] : [desc(pcbCamJobs.createdAt), desc(pcbCamJobs.id)]))
      .limit(opts.limit + 1)
  ).map((r) => ({ ...r.job, projectName: r.projectName ?? r.job.projectId.slice(0, 8), customerName: r.customerName ?? null, eqPending: Number(r.eqPending ?? 0), _rank: Number(r.rank) }))
  const items = rows.slice(0, opts.limit)
  const last = items[items.length - 1]
  const nextCursor = rows.length > opts.limit && last ? (queue ? encodeQueueCursor(last._rank, last.updatedAt, last.id) : encodeCursor(last.createdAt, last.id)) : null
  return { items: items.map(({ _rank, ...row }) => row), nextCursor }
}

export type JobStats = {
  /** 停在人工节点、等我动手的任务数,以及它们上面还没判的问题点总数 */
  mine: { jobs: number; decisions: number; oldestWaitingAt: Date | null }
  running: number
  /** 今天完成(done)的任务数 —— 「今天放行了几单」 */
  doneToday: number
  releasedToday: number
  done: number
}

/** 列表顶上的三个数字。一次查询,按状态聚合;「今天」按数据库时区的当天。 */
export async function jobStats(db: Db, ctx: Ctx): Promise<JobStats> {
  const rows = await db
    .select({
      status: pcbCamJobs.status,
      n: sql<number>`count(*)::int`,
      pending: sql<number>`coalesce(sum(${EQ_PENDING_SUB}), 0)::int`,
      oldest: sql<Date | null>`min(${pcbCamJobs.updatedAt})`,
      today: sql<number>`sum(case when ${pcbCamJobs.updatedAt} >= date_trunc('day', now()) then 1 else 0 end)::int`,
      releasedToday: sql<number>`sum(case when ${pcbCamJobs.releasedAt} >= date_trunc('day', now()) then 1 else 0 end)::int`,
    })
    .from(pcbCamJobs)
    .where(scope(pcbCamJobs, ctx.tenantId))
    .groupBy(pcbCamJobs.status)
  const by = new Map(rows.map((r) => [r.status, r]))
  const mineRows = ['needs_review', 'blocked'].map((s) => by.get(s)).filter((r): r is NonNullable<typeof r> => Boolean(r))
  const oldest = mineRows.map((r) => (r.oldest ? new Date(r.oldest) : null)).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null
  return {
    mine: { jobs: mineRows.reduce((a, r) => a + Number(r.n), 0), decisions: mineRows.reduce((a, r) => a + Number(r.pending), 0), oldestWaitingAt: oldest },
    running: ['pending', 'running'].reduce((a, s) => a + Number(by.get(s)?.n ?? 0), 0),
    doneToday: Number(by.get('done')?.today ?? 0),
    releasedToday: rows.reduce((a, r) => a + Number(r.releasedToday ?? 0), 0),
    done: Number(by.get('done')?.n ?? 0),
  }
}

export async function getStageReport(db: Db, ctx: Ctx, jobId: string, stage: PcbCamStage): Promise<{ run: StageRunSummary; report: Record<string, unknown> | null } | null> {
  await getJobRow(db, ctx.tenantId, jobId)
  const rows = await db
    .select()
    .from(pcbCamStageRuns)
    .where(and(scope(pcbCamStageRuns, ctx.tenantId), eq(pcbCamStageRuns.jobId, jobId), eq(pcbCamStageRuns.stage, stage)))
    .orderBy(desc(pcbCamStageRuns.attempt))
    .limit(1)
  const r = rows[0]
  return r ? { run: summarizeRun(r), report: r.report ?? null } : null
}

export async function listEqItems(db: Db, ctx: Ctx, jobId: string): Promise<EqItemDTO[]> {
  await getJobRow(db, ctx.tenantId, jobId)
  const rows = await db
    .select()
    .from(pcbCamEqItems)
    .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, jobId)))
    .orderBy(pcbCamEqItems.createdAt, pcbCamEqItems.itemId)
    .limit(500)
  return rows.map((r) => ({
    id: r.id,
    stage: r.stage as PcbCamStage,
    itemId: r.itemId,
    severity: r.severity as PcbCamEqItem['severity'],
    message: r.message,
    suggestedFix: r.suggestedFix ?? null,
    decision: r.decision as PcbCamEqDecision,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    note: r.note,
    kind: kindOfItemId(r.itemId, r.kind),
    customerReply: r.customerReply ?? null,
    customerReplyAt: r.customerReplyAt ?? null,
  }))
}

export async function listArtifacts(db: Db, ctx: Ctx, jobId: string): Promise<ArtifactDTO[]> {
  await getJobRow(db, ctx.tenantId, jobId)
  const rows = await db
    .select({ a: pcbCamArtifacts, stage: pcbCamStageRuns.stage })
    .from(pcbCamArtifacts)
    .leftJoin(pcbCamStageRuns, eq(pcbCamStageRuns.id, pcbCamArtifacts.stageRunId))
    .where(and(scope(pcbCamArtifacts, ctx.tenantId), eq(pcbCamArtifacts.jobId, jobId)))
    .orderBy(pcbCamArtifacts.createdAt)
    .limit(500)
  return rows.map(({ a: r, stage }) => ({
    id: r.id,
    stageRunId: r.stageRunId,
    stage: stage ?? null,
    kind: r.kind as PcbCamArtifactKind,
    storageKey: r.storageKey,
    filename: r.filename,
    size: r.size,
    contentType: r.contentType,
    createdAt: r.createdAt,
  }))
}

/** 交付物 = PCB_CAM_DELIVERABLE_KINDS 里的类型;例外:钻孔阶段的过程钻带(kind=drill, stage=drill)在输出阶段
    已按厂规重命名后就只算过程文件(第一块真板:`3oz_2_oversized.drl` 与 `y6f085471a0.TXT` 同列很误导)。 */
export function isDeliverable(a: Pick<ArtifactDTO, 'kind' | 'stage'>, all: ReadonlyArray<Pick<ArtifactDTO, 'kind' | 'stage'>>): boolean {
  if (!PCB_CAM_DELIVERABLE_KINDS.includes(a.kind)) return false
  if (a.kind === 'drill' && a.stage === 'drill' && all.some((x) => x.kind === 'drill' && x.stage === 'output')) return false
  return true
}

/** 成果物打包:deliverables = 只打要交出去的(PCB_CAM_DELIVERABLE_KINDS),all = 连过程数据一起。
    按类型分目录(drill/ gerber_panel/ …),同名文件由 zip 写入器加序号。 */
export async function packArtifacts(db: Db, ctx: Ctx, jobId: string, group: 'deliverables' | 'all'): Promise<{ filename: string; bytes: Buffer; count: number }> {
  const job = await getJobRow(db, ctx.tenantId, jobId)
  const all = await listArtifacts(db, ctx, jobId)
  const wanted = group === 'all' ? all : all.filter((a) => isDeliverable(a, all))
  if (wanted.length === 0) throw new PcbCamError('PCB_NO_ARTIFACTS', group === 'all' ? '这个任务还没有任何成果物。' : '这个任务还没有可交付的成果物。')
  const order = new Map(PCB_CAM_DELIVERABLE_KINDS.map((k, i) => [k, i]))
  const sorted = [...wanted].sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || a.filename.localeCompare(b.filename))
  // worker 出的文件名里带完整任务 uuid,工程师拿到手里没意义,包内缩成 8 位(和页面显示一致)
  const short = (f: string) => f.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, (m) => m.slice(0, 8))
  const entries: ZipEntry[] = []
  for (const a of sorted) {
    entries.push({ name: `${a.kind}/${short(a.filename)}`, data: await readObject(db, ctx, a.storageKey), mtime: a.createdAt })
  }
  return { filename: `cam-${job.id.slice(0, 8)}-${group}.zip`, bytes: buildZip(entries), count: entries.length }
}

// ── 人工停等点解锁(不变量 2)────────────────────────────────────────────────────

function assertStatus(job: PcbCamJob, allowed: PcbCamJobStatus[], what: string): void {
  if (!allowed.includes(job.status as PcbCamJobStatus)) {
    throw new PcbCamError('PCB_INVALID_STATE', `任务当前是「${job.status}」状态,不能${what}。`)
  }
}

/** 工程师确认层识别结果 → 写事实字段 + 回 running。仅 needs_review(review_reason=layers)时允许。 */
export async function confirmLayers(db: Db, ctx: Ctx, jobId: string, layerMap: Record<string, unknown>): Promise<JobDTO> {
  await db.transaction(async (tx) => {
    const job = await getJobRow(tx, ctx.tenantId, jobId)
    assertStatus(job, ['needs_review'], '确认层识别')
    if (job.reviewReason !== 'layers') throw new PcbCamError('PCB_INVALID_STATE', '任务现在不在「层确认」这一步。')
    await auditedUpdate(tx, pcbCamJobs, ctx.tenantId, jobId, ctx.employeeId, {
      layerMap,
      layerMapConfirmedAt: new Date(),
      status: 'running',
      reviewReason: null,
      version: job.version + 1,
    })
  })
  return getJob(db, ctx, jobId)
}

/** 工程师确认审单结果:候选 → 事实(不变量 4)。 */
export async function confirmOrderSpec(db: Db, ctx: Ctx, jobId: string, orderSpec: Record<string, unknown>): Promise<JobDTO> {
  await db.transaction(async (tx) => {
    const job = await getJobRow(tx, ctx.tenantId, jobId)
    assertStatus(job, ['needs_review'], '确认制作规格')
    if (job.reviewReason !== 'order_spec') throw new PcbCamError('PCB_INVALID_STATE', '任务现在不在「规格确认」这一步。')
    await auditedUpdate(tx, pcbCamJobs, ctx.tenantId, jobId, ctx.employeeId, {
      orderSpec,
      status: 'running',
      reviewReason: null,
      version: job.version + 1,
    })
  })
  return getJob(db, ctx, jobId)
}

export async function decideEqItem(
  db: Db,
  ctx: Ctx,
  jobId: string,
  eqItemId: string,
  input: { decision: Exclude<PcbCamEqDecision, 'pending'>; note?: string | null },
): Promise<EqItemDTO[]> {
  const job = await getJobRow(db, ctx.tenantId, jobId)
  assertStatus(job, ['needs_review', 'blocked'], '处理问题点')
  const rows = await db
    .select({ id: pcbCamEqItems.id })
    .from(pcbCamEqItems)
    .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, jobId), eq(pcbCamEqItems.id, eqItemId)))
    .limit(1)
  if (!rows[0]) throw jobNotFound()
  await auditedUpdate(db, pcbCamEqItems, ctx.tenantId, eqItemId, ctx.employeeId, {
    decision: input.decision,
    decidedBy: ctx.employeeId,
    decidedAt: new Date(),
    note: input.note?.trim() || null,
  })
  return listEqItems(db, ctx, jobId)
}

/** 批量决策:同一组(同类型)的问题点一次判掉;不在本 job 的 id 忽略不报错(前端按组提交,组内可能已有判过的)。 */
export async function decideEqBatch(
  db: Db,
  ctx: Ctx,
  jobId: string,
  itemIds: string[],
  input: { decision: Exclude<PcbCamEqDecision, 'pending'>; note?: string | null },
): Promise<{ items: EqItemDTO[]; changed: number }> {
  const job = await getJobRow(db, ctx.tenantId, jobId)
  assertStatus(job, ['needs_review', 'blocked'], '处理问题点')
  const ids = [...new Set(itemIds)].slice(0, 500)
  if (ids.length === 0) return { items: await listEqItems(db, ctx, jobId), changed: 0 }
  const now = new Date()
  const rows = await db
    .update(pcbCamEqItems)
    .set({ decision: input.decision, decidedBy: ctx.employeeId, decidedAt: now, note: input.note?.trim() || null, updatedBy: ctx.employeeId, updatedAt: now })
    .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, jobId), inArray(pcbCamEqItems.id, ids)))
    .returning({ id: pcbCamEqItems.id })
  return { items: await listEqItems(db, ctx, jobId), changed: rows.length }
}

export type EqSuggestion = {
  id: string
  itemId: string
  kind: string
  suggestion: { decision: PcbCamEqDecision; by: string | null; byName: string | null; at: Date | null; note: string | null; count: number; sameCustomer: boolean } | null
}
export type EqSuggestions = {
  items: EqSuggestion[]
  /** 同一类型、同一判法在本租户已重复 ≥ 3 次:提示「写进工厂标准」 */
  repeated: Array<{ kind: string; decision: PcbCamEqDecision; count: number }>
}

/**
 * 决策记忆:本 job 每个还没判的问题点,找本租户以前对同类型问题点怎么判的 —— 同客户的优先,其次任何客户;
 * 取最近一次做默认值,并数同一判法出现过几次。只读历史,不自动写决策(不变量 2:停等由人解锁)。
 */
export async function eqSuggestions(db: Db, ctx: Ctx, jobId: string): Promise<EqSuggestions> {
  const job = await getJobRow(db, ctx.tenantId, jobId)
  const pending = (await listEqItems(db, ctx, jobId)).filter((i) => i.decision === 'pending')
  if (pending.length === 0) return { items: [], repeated: [] }
  const proj = await db.select({ customerName: pcbCamProjects.customerName }).from(pcbCamProjects).where(eq(pcbCamProjects.id, job.projectId)).limit(1)
  const customer = proj[0]?.customerName?.trim() || null
  const kinds = [...new Set(pending.map((i) => i.kind))]
  const history = await db
    .select({
      kind: pcbCamEqItems.kind,
      itemId: pcbCamEqItems.itemId,
      decision: pcbCamEqItems.decision,
      decidedBy: pcbCamEqItems.decidedBy,
      decidedAt: pcbCamEqItems.decidedAt,
      note: pcbCamEqItems.note,
      customerName: pcbCamProjects.customerName,
    })
    .from(pcbCamEqItems)
    .innerJoin(pcbCamJobs, eq(pcbCamJobs.id, pcbCamEqItems.jobId))
    .leftJoin(pcbCamProjects, eq(pcbCamProjects.id, pcbCamJobs.projectId))
    .where(and(scope(pcbCamEqItems, ctx.tenantId), sql`${pcbCamEqItems.decision} <> 'pending'`, sql`${pcbCamEqItems.jobId} <> ${jobId}::uuid`))
    .orderBy(desc(pcbCamEqItems.decidedAt))
    .limit(3000)
  type H = (typeof history)[number] & { k: string }
  const rows: H[] = history.map((h) => ({ ...h, k: kindOfItemId(h.itemId, h.kind) })).filter((h) => kinds.includes(h.k))
  const names = await getEmployeeNames(db, ctx.tenantId, rows.map((r) => r.decidedBy))
  const byKind = new Map<string, H[]>()
  for (const r of rows) byKind.set(r.k, [...(byKind.get(r.k) ?? []), r])
  const items: EqSuggestion[] = pending.map((it) => {
    const all = byKind.get(it.kind) ?? []
    const same = customer ? all.filter((h) => (h.customerName?.trim() || null) === customer) : []
    const pool = same.length ? same : all
    const latest = pool[0]
    if (!latest) return { id: it.id, itemId: it.itemId, kind: it.kind, suggestion: null }
    const count = pool.filter((h) => h.decision === latest.decision).length
    return {
      id: it.id,
      itemId: it.itemId,
      kind: it.kind,
      suggestion: { decision: latest.decision as PcbCamEqDecision, by: latest.decidedBy, byName: latest.decidedBy ? (names.get(latest.decidedBy) ?? null) : null, at: latest.decidedAt, note: latest.note, count, sameCustomer: same.length > 0 },
    }
  })
  const repeated: EqSuggestions['repeated'] = []
  for (const [k, list] of byKind) {
    const tally = new Map<string, number>()
    for (const h of list) tally.set(h.decision, (tally.get(h.decision) ?? 0) + 1)
    for (const [decision, count] of tally) if (count >= 3) repeated.push({ kind: k, decision: decision as PcbCamEqDecision, count })
  }
  return { items, repeated: repeated.sort((a, b) => b.count - a.count) }
}

/** 客户对「问客户」条目的答复回收:落在这条发现上(不改决策 —— 工程师看了答复再判)。 */
export async function recordCustomerReply(db: Db, ctx: Ctx, jobId: string, eqItemId: string, reply: string): Promise<EqItemDTO[]> {
  await getJobRow(db, ctx.tenantId, jobId)
  const rows = await db
    .select({ id: pcbCamEqItems.id })
    .from(pcbCamEqItems)
    .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, jobId), eq(pcbCamEqItems.id, eqItemId)))
    .limit(1)
  if (!rows[0]) throw jobNotFound()
  await auditedUpdate(db, pcbCamEqItems, ctx.tenantId, eqItemId, ctx.employeeId, { customerReply: reply.trim().slice(0, 2000) || null, customerReplyAt: reply.trim() ? new Date() : null })
  return listEqItems(db, ctx, jobId)
}

/**
 * 一键「放行并下发」:成果物 + 流程单 + 问单打成一个包,记 released_at/by。只有 done 的任务能下发;
 * 重复下发允许(重新打包,时间更新)。extras 由路由层生成(流程单 / 问单 HTML 要图和项目信息)。
 */
export async function releaseJob(db: Db, ctx: Ctx, jobId: string, extras: ZipEntry[]): Promise<{ filename: string; bytes: Buffer; count: number }> {
  const job = await getJobRow(db, ctx.tenantId, jobId)
  assertStatus(job, ['done'], '放行下发')
  const all = await listArtifacts(db, ctx, jobId)
  const wanted = all.filter((a) => isDeliverable(a, all))
  if (wanted.length === 0) throw new PcbCamError('PCB_NO_ARTIFACTS', '这个任务还没有可交付的成果物,不能下发。')
  const order = new Map(PCB_CAM_DELIVERABLE_KINDS.map((k, i) => [k, i]))
  const sorted = [...wanted].sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || a.filename.localeCompare(b.filename))
  const short = (f: string) => f.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, (m) => m.slice(0, 8))
  const entries: ZipEntry[] = []
  for (const a of sorted) entries.push({ name: `${a.kind}/${short(a.filename)}`, data: await readObject(db, ctx, a.storageKey), mtime: a.createdAt })
  entries.push(...extras)
  const now = new Date()
  await auditedUpdate(db, pcbCamJobs, ctx.tenantId, jobId, ctx.employeeId, { releasedAt: now, releasedBy: ctx.employeeId })
  return { filename: `release-${job.id.slice(0, 8)}.zip`, bytes: buildZip(entries), count: entries.length }
}

/**
 * 所有 EQ 决策完毕 → 回 running。还有 pending 的抛 PCB_EQ_PENDING(不变量 2)。
 * `rerun`:放行后不前进而是重跑这一步(A 线:回读校验要等 Genesis 主机 / 续投后再回读一次)——
 * 推进器只会「前进」,所以把 currentStage 拨回它前一步,下一轮认领时 nextStage 就是它。
 */
export async function submitEq(db: Db, ctx: Ctx, jobId: string, opts: { rerun?: PcbCamStage } = {}): Promise<JobDTO> {
  await db.transaction(async (tx) => {
    const job = await getJobRow(tx, ctx.tenantId, jobId)
    assertStatus(job, ['needs_review'], '放行')
    if (job.reviewReason !== 'eq') throw new PcbCamError('PCB_INVALID_STATE', '任务现在不在「问题点决策」这一步。')
    const pending = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(pcbCamEqItems)
      .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, jobId), eq(pcbCamEqItems.decision, 'pending')))
    if (Number(pending[0]?.n ?? 0) > 0) throw new PcbCamError('PCB_EQ_PENDING', '还有问题点没有决策,把每一条都处理完才能继续。')
    if (opts.rerun && job.currentStage !== opts.rerun) throw new PcbCamError('PCB_INVALID_STATE', `任务不在 ${opts.rerun} 这一步,不能重跑它。`)
    await auditedUpdate(tx, pcbCamJobs, ctx.tenantId, jobId, ctx.employeeId, {
      status: 'running',
      reviewReason: null,
      ...(opts.rerun ? { currentStage: prevStage(opts.rerun) } : {}),
      version: job.version + 1,
    })
  })
  return getJob(db, ctx, jobId)
}

export type GenesisAction = { type: 'resume'; fromPart: number } | { type: 'wait' }

/**
 * A 线(A4.2):回读校验这一步的 EQ 里,工程师「接受」的 Genesis 动作 —— 主机在第 N 段暂停/失败 → 从 from_part 续投;
 * 还在等主机 → 只重跑回读。只看最新一次 gatekeeper run 的条目;还有 pending 的 EQ 时返回 null(放行会被 submitEq 拒掉,
 * 不能先把段投出去)。
 */
export async function pendingGenesisAction(db: Db, ctx: Ctx, jobId: string): Promise<GenesisAction | null> {
  const job = await getJobRow(db, ctx.tenantId, jobId)
  if (job.currentStage !== 'gatekeeper') return null
  const latest = await db
    .select({ id: pcbCamStageRuns.id })
    .from(pcbCamStageRuns)
    .where(and(eq(pcbCamStageRuns.jobId, jobId), eq(pcbCamStageRuns.stage, 'gatekeeper'), eq(pcbCamStageRuns.isDeleted, false)))
    .orderBy(desc(pcbCamStageRuns.attempt))
    .limit(1)
  if (!latest[0]) return null
  const rows = await db
    .select({ decision: pcbCamEqItems.decision, fix: pcbCamEqItems.suggestedFix })
    .from(pcbCamEqItems)
    .where(and(scope(pcbCamEqItems, ctx.tenantId), eq(pcbCamEqItems.jobId, jobId), eq(pcbCamEqItems.stageRunId, latest[0].id)))
  if (rows.some((r) => r.decision === 'pending')) return null
  let action: GenesisAction | null = null
  for (const r of rows) {
    if (r.decision !== 'accept_fix') continue
    const fix = (r.fix ?? null) as { type?: string; params?: { from_part?: unknown } } | null
    if (fix?.type === 'genesis_resume' && typeof fix.params?.from_part === 'number') {
      action = { type: 'resume', fromPart: fix.params.from_part }
      break
    }
    if (fix?.type === 'genesis_wait') action = { type: 'wait' }
  }
  return action
}

/** blocked / failed 的 job 从指定 stage 重跑(attempt+1 由推进器分配)。 */
export async function retryStage(db: Db, ctx: Ctx, jobId: string, stage: PcbCamStage): Promise<JobDTO> {
  await db.transaction(async (tx) => {
    const job = await getJobRow(tx, ctx.tenantId, jobId)
    assertStatus(job, ['blocked', 'failed'], '重跑')
    await auditedUpdate(tx, pcbCamJobs, ctx.tenantId, jobId, ctx.employeeId, {
      status: 'running',
      currentStage: stage,
      reviewReason: null,
      retryCount: 0,
      errorMessage: null,
      version: job.version + 1,
    })
  })
  return getJob(db, ctx, jobId)
}

export async function cancelJob(db: Db, ctx: Ctx, jobId: string): Promise<JobDTO> {
  await db.transaction(async (tx) => {
    const job = await getJobRow(tx, ctx.tenantId, jobId)
    assertStatus(job, ['pending', 'running', 'needs_review', 'blocked', 'failed'], '取消')
    await auditedUpdate(tx, pcbCamJobs, ctx.tenantId, jobId, ctx.employeeId, {
      status: 'cancelled',
      reviewReason: null,
      version: job.version + 1,
    })
  })
  return getJob(db, ctx, jobId)
}

// ── 推进器(automation.ts 调用;不带 ctx,系统身份)──────────────────────────────

export type ClaimedRun = { job: PcbCamJob; run: PcbCamStageRun; stage: PcbCamStage }

/**
 * 认领下一步(不变量 1、3):在事务里锁 job 行,决定要跑哪个 stage、开新 attempt。
 * 返回 null = 这个 job 现在没有可跑的(在跑 / 停等 / 已结束)。
 * 规则:
 *  - pending → 跑第一个 stage,job 转 running
 *  - running 且 current_stage 无 run → 跑 current_stage(retry 设置的)
 *  - running 且最新 run ok → 跑 nextStage;没有下一步 → done
 *  - running 且最新 run running → 在跑,跳过
 *  - running 且最新 run failed/blocked → 只有人工 retry 把 status 置回 running 才会到这里 → 开新 attempt
 */
export async function claimNextStageRun(db: Db, jobId: string): Promise<ClaimedRun | null> {
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      select * from pcb_cam_jobs where id = ${jobId} and is_deleted = false for update
    `)) as { rows: PcbCamJobRaw[] }
    const raw = locked.rows[0]
    if (!raw) return null
    const job = fromRaw(raw)
    if (job.status !== 'pending' && job.status !== 'running') return null
    if (job.status === 'pending' && job.currentStage === null) {
      // 层未确认时 align 及之后不得执行(不变量 4)——第一个 stage 是 intake,允许。
      return startRun(tx, job, PCB_CAM_STAGES[0])
    }
    const stage = (job.currentStage as PcbCamStage | null) ?? PCB_CAM_STAGES[0]
    const latest = await tx
      .select()
      .from(pcbCamStageRuns)
      .where(and(eq(pcbCamStageRuns.jobId, jobId), eq(pcbCamStageRuns.stage, stage), eq(pcbCamStageRuns.isDeleted, false)))
      .orderBy(desc(pcbCamStageRuns.attempt))
      .limit(1)
    const run = latest[0]
    if (!run) return startRun(tx, job, stage)
    if (run.status === 'running') return null
    // ok:正常前进。needs_review:worker 报告带 error/EQ 时 run 也是 needs_review,
    // 能走到这里说明 job 已被 submitEq 放行(pending EQ = 0),同样前进,不能再跑一遍本 stage。
    if (run.status === 'ok' || run.status === 'needs_review') {
      const next = nextStage(stage)
      if (!next) {
        await tx.update(pcbCamJobs).set({ status: 'done', updatedAt: new Date(), version: job.version + 1 }).where(eq(pcbCamJobs.id, jobId))
        return null
      }
      if (!job.layerMapConfirmedAt && next !== 'order_spec') {
        // 不变量 4:层未确认不得越过 order_spec 进入 align
        await tx.update(pcbCamJobs).set({ status: 'needs_review', reviewReason: 'layers', updatedAt: new Date(), version: job.version + 1 }).where(eq(pcbCamJobs.id, jobId))
        return null
      }
      return startRun(tx, job, next)
    }
    // failed / blocked / needs_review 且 job 仍 running:人工 retry 或自动重试路径 → 新 attempt
    return startRun(tx, job, stage)
  })
}

type PcbCamJobRaw = Record<string, unknown>
function fromRaw(r: PcbCamJobRaw): PcbCamJob {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: new Date(String(r.created_at)),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: new Date(String(r.updated_at)),
    isDeleted: Boolean(r.is_deleted),
    deletedAt: r.deleted_at ? new Date(String(r.deleted_at)) : null,
    projectId: String(r.project_id),
    status: String(r.status),
    currentStage: (r.current_stage as string | null) ?? null,
    reviewReason: (r.review_reason as string | null) ?? null,
    inputKeys: (r.input_keys as string[]) ?? [],
    layerMap: (r.layer_map as Record<string, unknown> | null) ?? null,
    layerMapConfirmedAt: r.layer_map_confirmed_at ? new Date(String(r.layer_map_confirmed_at)) : null,
    orderSpecCandidate: (r.order_spec_candidate as Record<string, unknown> | null) ?? null,
    orderSpec: (r.order_spec as Record<string, unknown> | null) ?? null,
    profileSnapshot: (r.profile_snapshot as Record<string, unknown> | null) ?? null,
    workerJobId: (r.worker_job_id as string | null) ?? null,
    retryCount: Number(r.retry_count ?? 0),
    version: Number(r.version ?? 0),
    errorMessage: (r.error_message as string | null) ?? null,
    releasedAt: r.released_at ? new Date(String(r.released_at)) : null,
    releasedBy: (r.released_by as string | null) ?? null,
  }
}

async function startRun(tx: Db, job: PcbCamJob, stage: PcbCamStage): Promise<ClaimedRun> {
  const prev = await tx
    .select({ m: sql<number>`coalesce(max(${pcbCamStageRuns.attempt}), 0)::int` })
    .from(pcbCamStageRuns)
    .where(and(eq(pcbCamStageRuns.jobId, job.id), eq(pcbCamStageRuns.stage, stage)))
  const attempt = Number(prev[0]?.m ?? 0) + 1
  const rows = await tx
    .insert(pcbCamStageRuns)
    .values({
      id: randomUUID(),
      tenantId: job.tenantId,
      createdBy: job.createdBy,
      updatedBy: job.createdBy,
      jobId: job.id,
      stage,
      attempt,
      status: 'running',
    })
    .returning()
  const updated = await tx
    .update(pcbCamJobs)
    .set({ status: 'running', currentStage: stage, reviewReason: null, updatedAt: new Date(), version: job.version + 1 })
    .where(and(eq(pcbCamJobs.id, job.id), eq(pcbCamJobs.version, job.version)))
    .returning()
  if (!updated[0]) throw new PcbCamError('PCB_INVALID_STATE', '任务被并发修改,本次推进放弃。')
  return { job: updated[0], run: rows[0]!, stage }
}

/**
 * 报告项要不要人来决策(与 pcb 仓 engine/model/report.py 的 ReportItem.needs_decision 同一规则):
 * 执行器(本地引擎 / Genesis)已经把修复做掉的项没什么可决策的 —— 即便发现时带了 EQ 文案,
 * 报告里显示「已自动」即可;否则 eq_question 或未修的 error 才进 EQ。
 * 例外:`fix.confirm`(厂规开关的 ask 档)—— 引擎照做了,但工程师要求这类改动必须有人点过
 * (内层删独立 PAD、删塞孔过孔开窗、塞孔分组…,2026-09-16 洲旭回复):已执行也进 EQ。
 */
export function itemNeedsDecision(i: StageReport['items'][number]): boolean {
  if (i.fix?.applied && !i.fix?.confirm) return false
  return Boolean(i.eq_question) || i.severity === 'error'
}

/** 报告 → job 下一状态(纯函数,供测试)。 */
export function deriveJobStatusFromReport(stage: PcbCamStage, report: StageReport): { status: PcbCamJobStatus; reviewReason: string | null } {
  if (report.status === 'failed') return { status: 'failed', reviewReason: null }
  if (report.status === 'blocked') return { status: 'blocked', reviewReason: 'blocked' }
  const needsEq = report.items.some(itemNeedsDecision)
  if (needsEq) return { status: 'needs_review', reviewReason: 'eq' }
  if (report.status === 'needs_review') return { status: 'needs_review', reviewReason: 'eq' }
  if (stage === 'intake') return { status: 'needs_review', reviewReason: 'layers' }
  if (stage === 'order_spec') return { status: 'needs_review', reviewReason: 'order_spec' }
  if (STAGES_REQUIRE_REVIEW_AFTER.has(stage)) return { status: 'needs_review', reviewReason: stage }
  return { status: 'running', reviewReason: null }
}

/**
 * stage 完成:落报告、生成 EQ 条目、登记产物、推 job 状态。
 * 幂等:同一 run 重复 complete 只有第一次生效(status 已非 running 直接返回)。
 */
export async function completeStageRun(db: Db, runId: string, report: StageReport): Promise<void> {
  await db.transaction(async (tx) => {
    const runs = await tx.select().from(pcbCamStageRuns).where(eq(pcbCamStageRuns.id, runId)).limit(1)
    const run = runs[0]
    if (!run || run.status !== 'running') return
    const stage = run.stage as PcbCamStage
    const finishedAt = new Date()
    const runStatus: PcbCamStageRun['status'] = report.status === 'ok' ? 'ok' : report.status
    await tx
      .update(pcbCamStageRuns)
      .set({
        status: runStatus,
        report: report as unknown as Record<string, unknown>,
        finishedAt,
        durationMs: report.duration_ms ?? Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
        updatedAt: finishedAt,
      })
      .where(eq(pcbCamStageRuns.id, runId))

    // EQ 条目:未被执行器修掉的 eq_question 或 error(规则见 itemNeedsDecision)
    const eqItems = report.items.filter(itemNeedsDecision)
    if (eqItems.length > 0) {
      await tx
        .insert(pcbCamEqItems)
        .values(
          eqItems.map((i) => ({
            id: randomUUID(),
            tenantId: run.tenantId,
            createdBy: run.createdBy,
            updatedBy: run.createdBy,
            jobId: run.jobId,
            stageRunId: run.id,
            stage,
            itemId: i.id,
            kind: i.kind,
            severity: i.severity,
            message: i.eq_question ?? i.message,
            suggestedFix: i.fix ? (i.fix as unknown as Record<string, unknown>) : null,
            decision: 'pending' as const,
          })),
        )
        .onConflictDoNothing()
    }

    // 产物登记(kind 不在白名单的归 archive)。同一 (kind, 文件名) 只留最新一条:
    // genesis_<job>.csh 每个 stage 重新生成一次、写在各自 output/<stage>/ 下(storage key 不同),
    // 不去重会在成果物里出现 N 份同名文件。
    const kindOf = (k: string): PcbCamArtifactKind => ((PCB_CAM_ARTIFACT_KINDS as readonly string[]).includes(k) ? (k as PcbCamArtifactKind) : 'archive')
    const nameOf = (a: StageReport['artifacts'][number]) => a.filename ?? a.path.split('/').pop() ?? a.path
    if (report.artifacts.length > 0) {
      await tx.delete(pcbCamArtifacts).where(
        and(
          eq(pcbCamArtifacts.jobId, run.jobId),
          or(...report.artifacts.map((a) => and(eq(pcbCamArtifacts.kind, kindOf(a.kind)), eq(pcbCamArtifacts.filename, nameOf(a))))),
        ),
      )
      await tx
        .insert(pcbCamArtifacts)
        .values(
          report.artifacts.map((a) => ({
            id: randomUUID(),
            tenantId: run.tenantId,
            createdBy: run.createdBy,
            updatedBy: run.createdBy,
            jobId: run.jobId,
            stageRunId: run.id,
            kind: kindOf(a.kind),
            storageKey: a.path,
            filename: nameOf(a),
            size: a.size ?? 0,
            contentType: a.content_type ?? null,
          })),
        )
        .onConflictDoNothing()
    }

    const jobs = await tx.select().from(pcbCamJobs).where(eq(pcbCamJobs.id, run.jobId)).limit(1)
    const job = jobs[0]
    if (!job) return
    // 人在这一步跑着的时候点了「取消」:报告、产物照样落库(那是已经做完的活),但不把任务拉回来 ——
    // 无条件改写状态会让取消不生效,推进器下一轮又接着跑(不变量:cancelled 是人选的终态)。
    if (job.status === 'cancelled') return
    const derived = deriveJobStatusFromReport(stage, report)
    const patch: Partial<typeof pcbCamJobs.$inferInsert> = {
      status: derived.status,
      reviewReason: derived.reviewReason,
      updatedAt: finishedAt,
      version: job.version + 1,
      errorMessage: report.status === 'failed' ? report.summary.slice(0, 500) : null,
    }
    if (stage === 'intake' && report.layer_map) patch.layerMap = report.layer_map
    if (stage === 'order_spec' && report.order_spec_candidate) patch.orderSpecCandidate = report.order_spec_candidate
    if (derived.status === 'running' && stage === PCB_CAM_STAGES[PCB_CAM_STAGES.length - 1]) patch.status = 'done'
    await tx.update(pcbCamJobs).set(patch).where(eq(pcbCamJobs.id, run.jobId))
  })
}

/** worker 调用失败(超时/5xx/网络):记 run failed;未超自动重试上限则 job 保持 running 等下次推进,否则 job failed(不变量 6)。 */
export async function failStageRun(db: Db, runId: string, message: string): Promise<void> {
  await db.transaction(async (tx) => {
    const runs = await tx.select().from(pcbCamStageRuns).where(eq(pcbCamStageRuns.id, runId)).limit(1)
    const run = runs[0]
    if (!run || run.status !== 'running') return
    const finishedAt = new Date()
    const safeMessage = message.replace(/\s+/g, ' ').slice(0, 500)
    await tx
      .update(pcbCamStageRuns)
      .set({ status: 'failed', finishedAt, durationMs: Math.max(0, finishedAt.getTime() - run.startedAt.getTime()), errorMessage: safeMessage, updatedAt: finishedAt })
      .where(eq(pcbCamStageRuns.id, runId))
    const jobs = await tx.select().from(pcbCamJobs).where(eq(pcbCamJobs.id, run.jobId)).limit(1)
    const job = jobs[0]
    if (!job) return
    if (job.status === 'cancelled') return // 同上:取消过的任务不因为一次失败又被拉回 running
    const retry = job.retryCount + 1
    await tx
      .update(pcbCamJobs)
      .set({
        status: retry > MAX_AUTO_RETRY ? 'failed' : 'running',
        retryCount: retry,
        errorMessage: safeMessage,
        updatedAt: finishedAt,
        version: job.version + 1,
      })
      .where(eq(pcbCamJobs.id, run.jobId))
  })
}

/** 推进器扫描:所有可推进的 job id(pending / running)。多实例并发靠 claimNextStageRun 的行锁。 */
export async function listAdvancableJobIds(db: Db, limit = 20): Promise<string[]> {
  const rows = await db
    .select({ id: pcbCamJobs.id })
    .from(pcbCamJobs)
    .where(and(eq(pcbCamJobs.isDeleted, false), inArray(pcbCamJobs.status, ['pending', 'running'])))
    .orderBy(pcbCamJobs.updatedAt)
    .limit(limit)
  return rows.map((r) => r.id)
}
