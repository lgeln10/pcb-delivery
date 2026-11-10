// modules/pcb-cam/routes.ts — PCB CAM HTTP 面。全部挂在 requireAuth 之后(core/http/app.ts);写操作叠 requirePermission。
// 上传:压缩包(zip/rar/7z)在本模块按魔数校验(core 的上传白名单不含压缩包,不为此改 core);附件走 checkUpload。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { Ctx, Db } from '../../core/db/client'
import type { AppEnv } from '../../core/http/middleware'
import { requirePermission } from '../../core/http/middleware'
import { limitField } from '../../core/http/pagination'
import { SSE_HEARTBEAT_FRAME, startSseHeartbeat } from '../../core/http/sse-heartbeat'
import { checkUpload, privateMarker, putObject } from '../../core/storage/api'
import { PcbCamError } from './errors'
import {
  cancelJob,
  confirmLayers,
  confirmOrderSpec,
  createJob,
  createProject,
  decideEqBatch,
  decideEqItem,
  eqSuggestions,
  jobStats,
  pendingGenesisAction,
  getFactoryProfile,
  getJob,
  getProject,
  getStageReport,
  listArtifacts,
  listEqItems,
  listFactoryProfiles,
  listJobs,
  listProjects,
  packArtifacts,
  recordCustomerReply,
  releaseJob,
  retryStage,
  storagePrefix,
  submitEq,
  upsertFactoryProfile,
  type EqItemDTO,
  type JobDTO,
} from './logic'
import { describeAnswer, translateQuestion } from './ask'
import { getEmployeeNames } from '../../core/org/api'
import { buildMiSheet, renderMiSheetHtml } from './mi/flows'
import { renderEqSheetHtml, type EqSheetItem } from './mi/eq-sheet'
import { buildStackup, renderStackupSvg } from './mi/stackup'
import { PCB_CAM_EQ_DECISIONS, PCB_CAM_JOB_STATUSES, PCB_CAM_PROJECT_STATUSES, type PcbCamJobStatus } from './model'
import { PCB_CAM_STAGES } from './stages'
import { createHttpWorkerClient, WorkerClientError, type PcbWorkerClient } from './worker-client'

const ARCHIVE_EXTS = ['zip', 'rar', '7z'] as const
const ATTACHMENT_EXTS = ['pdf', 'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'txt', 'csv'] as const
/** 单文件上限 200MB(多层板 Gerber 包实测 20–60MB;超过多半是传错了东西) */
const MAX_FILE_BYTES = 200 * 1024 * 1024
/** 一次上传最多文件数(1 个资料包 + 若干附件) */
const MAX_FILES = 12

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 压缩包魔数:zip `PK\x03\x04`(含空包/跨盘的 PK05/PK07)、rar `Rar!`、7z `7z\xBC\xAF\x27\x1C` */
function isArchive(bytes: Buffer, ext: string): boolean {
  if (bytes.length < 6) return false
  if (ext === 'zip') return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  if (ext === 'rar') return bytes.subarray(0, 4).toString('latin1') === 'Rar!'
  if (ext === '7z') return bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf
  return false
}

type CheckedFile = { bytes: Buffer; filename: string; contentType: string; isArchive: boolean }

function checkCamUpload(bytes: Buffer, filename: string): CheckedFile {
  if (bytes.length > MAX_FILE_BYTES) throw new PcbCamError('PCB_UPLOAD_INVALID', `文件 ${filename} 超过 200MB 上限。`)
  const ext = extOf(filename)
  if ((ARCHIVE_EXTS as readonly string[]).includes(ext)) {
    if (!isArchive(bytes, ext)) throw new PcbCamError('PCB_UPLOAD_INVALID', `文件 ${filename} 的内容不是有效的 .${ext} 压缩包。`)
    const mime = ext === 'zip' ? 'application/zip' : ext === 'rar' ? 'application/vnd.rar' : 'application/x-7z-compressed'
    return { bytes, filename, contentType: mime, isArchive: true }
  }
  const r = checkUpload(bytes, filename, ATTACHMENT_EXTS)
  if (!r.ok) throw new PcbCamError('PCB_UPLOAD_INVALID', `附件 ${filename}:${r.reason}`)
  return { bytes, filename, contentType: r.contentType, isArchive: false }
}

const CursorQuery = { limit: limitField(50, 20), cursor: z.string().max(200).optional() }
const ProjectListQuery = z.object({ ...CursorQuery, status: z.enum(PCB_CAM_PROJECT_STATUSES).optional() })
const JobStatus = z.enum(PCB_CAM_JOB_STATUSES)
const JobListQuery = z.object({
  ...CursorQuery,
  projectId: z.string().uuid().optional(),
  // 单个状态或逗号分隔的多个(列表页「需要我处理」= needs_review,blocked)
  status: z
    .string()
    .optional()
    .transform((v, c) => {
      if (!v) return undefined
      const parts = v.split(',').map((x) => x.trim()).filter(Boolean)
      const bad = parts.find((x) => !JobStatus.safeParse(x).success)
      if (bad) {
        c.addIssue({ code: 'custom', message: `未知状态:${bad}` })
        return z.NEVER
      }
      return parts.length === 1 ? (parts[0] as PcbCamJobStatus) : (parts as PcbCamJobStatus[])
    }),
  q: z.string().trim().max(80).optional(),
  // queue(默认)= 工作队列:该谁动排前面、等得久的在前;newest = 按创建时间倒序
  sort: z.enum(['queue', 'newest']).optional(),
})
const CreateProjectBody = z.object({
  name: z.string().min(1).max(120),
  customerName: z.string().max(120).optional().nullable(),
  factoryProfileId: z.string().uuid().optional().nullable(),
})
const JsonObject = z.record(z.string(), z.unknown())
const DecideBody = z.object({
  decision: z.enum(PCB_CAM_EQ_DECISIONS.filter((d) => d !== 'pending') as [string, ...string[]]),
  note: z.string().max(500).optional().nullable(),
})
const DecideBatchBody = DecideBody.extend({ itemIds: z.array(z.string().uuid()).min(1).max(500) })
const ReplyBody = z.object({ reply: z.string().max(2000) })
const AskBody = z.object({ question: z.string().trim().min(1).max(500) })
const StageRev = z.enum(['orig', ...PCB_CAM_STAGES] as ['orig', ...typeof PCB_CAM_STAGES])
/** 问单里每条问题点要一张局部图:最多取这么多层的 SVG(每层一次 worker 调用) */
const EQ_SHEET_MAX_LAYERS = 12
const StageParam = z.enum(PCB_CAM_STAGES)
const ProfileBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  yaml: z.string().min(1).max(200_000),
  schemaVersion: z.string().max(20).optional(),
  isDefault: z.boolean().optional(),
})
// 层名就是客户文件名(第一块真板:「六层内外3oz (1).G1」——中文、空格、括号都有;源文件直读的板是「cad_export/xxx.GTL」,
// 带一级子目录),只挡路径穿越(..、开头的 /、反斜杠)和控制字符;worker 侧再按 layer_map 精确匹配
const LayerName = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.startsWith('/') && !s.includes('\\') && !s.split('/').some((seg) => seg === '..' || seg === '') && !/[\u0000-\u001f]/.test(s), '层名不合法')

/** SSE 最长挂多久(超过让前端重连,避免僵尸连接) */
const SSE_MAX_MS = 30 * 60_000
const SSE_POLL_MS = 3_000

export function pcbCamRoutes(db: Db, worker: PcbWorkerClient = createHttpWorkerClient()) {
  const view = requirePermission(db, 'pcb-cam:view')
  const operate = requirePermission(db, 'pcb-cam:operate')
  const approve = requirePermission(db, 'pcb-cam:approve')
  const config = requirePermission(db, 'pcb-cam:config')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return (
    new Hono<AppEnv>()
      // ── 项目 ──
      .get('/projects', view, async (c) => c.json(await listProjects(db, ctxOf(c), ProjectListQuery.parse(c.req.query()))))
      .post('/projects', operate, async (c) => c.json(await createProject(db, ctxOf(c), CreateProjectBody.parse(await c.req.json()))))
      .get('/projects/:id', view, async (c) => c.json(await getProject(db, ctxOf(c), c.req.param('id'))))

      /**
       * 上传资料包 + 附件并建 job(multipart:`files` 可重复)。
       * 幂等:客户端可带 `Idempotency-Key`;同一 key 在 10 分钟内重复提交返回同一 job(内存表,单实例够用)。
       */
      .post('/projects/:id/jobs', operate, async (c) => {
        const ctx = ctxOf(c)
        const projectId = c.req.param('id')
        await getProject(db, ctx, projectId)
        const idemKey = c.req.header('Idempotency-Key')?.slice(0, 120)
        if (idemKey) {
          const hit = idempotency.get(`${ctx.tenantId}:${idemKey}`)
          if (hit && hit.expires > Date.now()) return c.json(await getJob(db, ctx, hit.jobId))
        }
        const body = await c.req.parseBody({ all: true })
        const raw = body['files']
        const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File)
        if (files.length === 0) throw new PcbCamError('PCB_UPLOAD_INVALID', '未收到文件。')
        if (files.length > MAX_FILES) throw new PcbCamError('PCB_UPLOAD_INVALID', `一次最多上传 ${MAX_FILES} 个文件。`)
        const checked: CheckedFile[] = []
        for (const f of files) checked.push(checkCamUpload(Buffer.from(await f.arrayBuffer()), f.name || 'file'))
        if (!checked.some((f) => f.isArchive)) throw new PcbCamError('PCB_UPLOAD_INVALID', '需要一个包含 Gerber/钻孔文件的压缩包(zip/rar/7z)。')

        const jobId = randomUUID()
        const keyPrefix = `${storagePrefix(ctx.tenantId, jobId)}input`
        const inputKeys: string[] = []
        for (const f of checked) {
          const stored = await putObject(db, ctx, { bytes: f.bytes, filename: f.filename, contentType: f.contentType, keyPrefix, visibility: 'private' })
          inputKeys.push(stored.key)
        }
        const job = await createJob(db, ctx, projectId, { jobId, inputKeys })
        if (idemKey) idempotency.set(`${ctx.tenantId}:${idemKey}`, { jobId: job.id, expires: Date.now() + 10 * 60_000 })
        return c.json(await getJob(db, ctx, job.id))
      })

      // ── 任务 ──
      .get('/jobs', view, async (c) => c.json(await listJobs(db, ctxOf(c), JobListQuery.parse(c.req.query()))))
      /** 列表顶上的三个数:待我处理 N 单 / M 条决策、跑着的、今天完成/下发的(要在 /jobs/:id 之前注册) */
      .get('/jobs/stats', view, async (c) => c.json(await jobStats(db, ctxOf(c))))
      .get('/jobs/:id', view, async (c) => c.json(await getJob(db, ctxOf(c), c.req.param('id'))))

      /** stage 状态变化推送(SSE):轮询 DB,变了才发;15s 心跳;最长 30 分钟。 */
      .get('/jobs/:id/events', view, async (c) => {
        const ctx = ctxOf(c)
        const id = c.req.param('id')
        await getJob(db, ctx, id) // 404 早抛,别进流
        return streamSSE(c, async (stream) => {
          const stopBeat = startSseHeartbeat(() => void stream.write(SSE_HEARTBEAT_FRAME).catch(() => {}))
          const started = Date.now()
          let last = ''
          try {
            while (!stream.aborted && Date.now() - started < SSE_MAX_MS) {
              const job = await getJob(db, ctx, id)
              const fingerprint = JSON.stringify([job.status, job.currentStage, job.reviewReason, job.eqPending, job.stages.map((s) => [s.stage, s.attempt, s.status])])
              if (fingerprint !== last) {
                last = fingerprint
                await stream.writeSSE({ event: 'job', data: JSON.stringify(job) })
              }
              if (['done', 'failed', 'cancelled'].includes(job.status)) break
              await stream.sleep(SSE_POLL_MS)
            }
          } finally {
            stopBeat()
          }
        })
      })

      .get('/jobs/:id/layers', view, async (c) => {
        const job = await getJob(db, ctxOf(c), c.req.param('id'))
        return c.json({ layerMap: job.layerMap, confirmedAt: job.layerMapConfirmedAt, reviewReason: job.reviewReason })
      })
      .post('/jobs/:id/layers/confirm', operate, async (c) =>
        c.json(await confirmLayers(db, ctxOf(c), c.req.param('id'), JsonObject.parse(await c.req.json()))),
      )
      .post('/jobs/:id/order-spec/confirm', operate, async (c) =>
        c.json(await confirmOrderSpec(db, ctxOf(c), c.req.param('id'), JsonObject.parse(await c.req.json()))),
      )
      .get('/jobs/:id/stages/:stage/report', view, async (c) => {
        const r = await getStageReport(db, ctxOf(c), c.req.param('id'), StageParam.parse(c.req.param('stage')))
        return c.json(r ?? { run: null, report: null })
      })
      /** 层预览 SVG:代理 worker(worker 只认 jobId;租户归属先在这里用 getJob 校验) */
      .get('/jobs/:id/layers/:layer{.+\\.svg}', view, async (c) => {
        const id = c.req.param('id')
        await getJob(db, ctxOf(c), id)
        const layer = LayerName.parse(c.req.param('layer').replace(/\.svg$/, ''))
        let svg: string
        try {
          const revQ = c.req.query('rev')
          const rev = revQ ? StageRev.parse(revQ) : undefined // orig / <stage>(时间轴刷写:那一步之后的样子)
          svg = await worker.layerSvg(id, layer, c.req.query('frame') === 'board' ? 'board' : undefined, rev, c.req.query('step') === 'panel' ? 'panel' : undefined)
        } catch (err) {
          if (err instanceof WorkerClientError && err.code === 'WORKER_TIMEOUT') throw new PcbCamError('PCB_WORKER_BUSY', '引擎正忙,这一层没能及时画出来;过一会儿再点一次。')
          // worker 的 404 = 这层/这个副本还没生成(拼板没跑就看工作板层),不是系统故障
          if (err instanceof WorkerClientError && err.status === 404) throw new PcbCamError('PCB_LAYER_NOT_READY', err.detail || '这一层还没生成。')
          throw err
        }
        return c.body(svg, 200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        })
      })

      // ── 终稿对比:系统输出 vs 人工终稿(工程师改好的成品),逐层分档、标差异 ──
      /** 上传人工终稿(multipart `files`,zip 或散 Gerber);存到本 job 的 golden/ 前缀后交 worker 配对。重传替换整套。 */
      .post('/jobs/:id/golden', operate, async (c) => {
        const ctx = ctxOf(c)
        const id = c.req.param('id')
        await getJob(db, ctx, id)
        const body = await c.req.parseBody({ all: true })
        const raw = body['files']
        const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => f instanceof File)
        if (files.length === 0) throw new PcbCamError('PCB_UPLOAD_INVALID', '未收到文件。')
        if (files.length > MAX_FILES) throw new PcbCamError('PCB_UPLOAD_INVALID', `一次最多上传 ${MAX_FILES} 个文件。`)
        const keyPrefix = `${storagePrefix(ctx.tenantId, id)}golden/${Date.now().toString(36)}`
        const keys: string[] = []
        for (const f of files) {
          const chk = checkCamUpload(Buffer.from(await f.arrayBuffer()), f.name || 'file')
          const stored = await putObject(db, ctx, { bytes: chk.bytes, filename: chk.filename, contentType: chk.contentType, keyPrefix, visibility: 'private' })
          keys.push(stored.key)
        }
        return c.json(await worker.golden(id, keys))
      })
      .get('/jobs/:id/compare', view, async (c) => {
        const id = c.req.param('id')
        await getJob(db, ctxOf(c), id)
        try {
          return c.json(await worker.compare(id, c.req.query('force') === 'true'))
        } catch (err) {
          if (err instanceof WorkerClientError && err.code === 'WORKER_TIMEOUT') throw new PcbCamError('PCB_WORKER_BUSY', '引擎正忙,对比还没算完;过一会儿再刷新。')
          if (err instanceof WorkerClientError && err.status === 404) throw new PcbCamError('PCB_LAYER_NOT_READY', err.detail || '这个任务还没有可对比的输出。')
          throw err
        }
      })
      .get('/jobs/:id/compare/:layer{.+\\.svg}', view, async (c) => {
        const id = c.req.param('id')
        await getJob(db, ctxOf(c), id)
        const suffix = LayerName.parse(c.req.param('layer').replace(/\.svg$/, ''))
        let svg: string
        try {
          svg = await worker.compareSvg(id, suffix)
        } catch (err) {
          if (err instanceof WorkerClientError && err.code === 'WORKER_TIMEOUT') throw new PcbCamError('PCB_WORKER_BUSY', '引擎正忙,叠加图没能及时画出来;过一会儿再点一次。')
          if (err instanceof WorkerClientError && err.status === 404) throw new PcbCamError('PCB_LAYER_NOT_READY', err.detail || '这一层没有配上对的人工终稿。')
          throw err
        }
        return c.body(svg, 200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        })
      })

      // ── EQ ──
      .get('/jobs/:id/eq', view, async (c) => c.json({ items: await listEqItems(db, ctxOf(c), c.req.param('id')) }))
      .post('/jobs/:id/eq/:itemId/decide', approve, async (c) => {
        const body = DecideBody.parse(await c.req.json())
        return c.json({
          items: await decideEqItem(db, ctxOf(c), c.req.param('id'), c.req.param('itemId'), {
            decision: body.decision as Exclude<(typeof PCB_CAM_EQ_DECISIONS)[number], 'pending'>,
            note: body.note,
          }),
        })
      })
      /** 批量决策:同类型一组一次判掉(键盘连打 / 「全组接受」) */
      .post('/jobs/:id/eq/decide-batch', approve, async (c) => {
        const body = DecideBatchBody.parse(await c.req.json())
        return c.json(await decideEqBatch(db, ctxOf(c), c.req.param('id'), body.itemIds, { decision: body.decision as Exclude<(typeof PCB_CAM_EQ_DECISIONS)[number], 'pending'>, note: body.note }))
      })
      /** 决策记忆:每条待判的问题点,以前(优先同客户)怎么判的;重复 ≥3 次的判法提示写进工厂标准 */
      .get('/jobs/:id/eq/suggestions', view, async (c) => c.json(await eqSuggestions(db, ctxOf(c), c.req.param('id'))))
      /** 客户答复回收:落在那条「问客户」的发现上,工程师再判 */
      .post('/jobs/:id/eq/:itemId/customer-reply', operate, async (c) => {
        const body = ReplyBody.parse(await c.req.json())
        return c.json({ items: await recordCustomerReply(db, ctxOf(c), c.req.param('id'), c.req.param('itemId'), body.reply) })
      })
      /** 问单 HTML(问客户 + 人工处理的条目,每条带板图局部);?download=1 走附件 */
      .get('/jobs/:id/eq-sheet.html', view, async (c) => {
        const ctx = ctxOf(c)
        const job = await getJob(db, ctx, c.req.param('id'))
        const html = await eqSheetHtml(db, ctx, worker, job)
        return c.body(html, 200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...(c.req.query('download') ? { 'Content-Disposition': `attachment; filename="EQ-${encodeURIComponent(job.projectName)}-${job.id.slice(0, 8)}.html"` } : {}),
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        })
      })
      /** 一键「放行并下发」:成果物 + 流程单 + 问单 + 决策记录打成一个包,记 released_at */
      .post('/jobs/:id/release', approve, async (c) => {
        const ctx = ctxOf(c)
        const job = await getJob(db, ctx, c.req.param('id'))
        const project = await getProject(db, ctx, job.projectId)
        const now = new Date()
        const mi = renderMiSheetHtml(buildMiSheet(job), { projectName: project.name, customerName: project.customerName, jobId: job.id, generatedAt: now })
        const eq = await eqSheetHtml(db, ctx, worker, job)
        const items = await listEqItems(db, ctx, job.id)
        const names = await getEmployeeNames(db, ctx.tenantId, items.map((i) => i.decidedBy))
        const record = JSON.stringify(items.map((i) => ({ stage: i.stage, itemId: i.itemId, kind: i.kind, decision: i.decision, by: i.decidedBy ? (names.get(i.decidedBy) ?? i.decidedBy) : null, at: i.decidedAt, note: i.note, customerReply: i.customerReply })), null, 1)
        const short = job.id.slice(0, 8)
        const pack = await releaseJob(db, ctx, job.id, [
          { name: `mi_sheet/MI-${short}.html`, data: Buffer.from(mi, 'utf8'), mtime: now },
          { name: `eq_report/EQ-${short}.html`, data: Buffer.from(eq, 'utf8'), mtime: now },
          { name: `eq_report/决策记录-${short}.json`, data: Buffer.from(record, 'utf8'), mtime: now },
        ])
        return c.body(new Uint8Array(pack.bytes), 200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${pack.filename}"`,
          'Content-Length': String(pack.bytes.length),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        })
      })
      /** 引擎实况流(worker 的 progress.jsonl,按 after 增量) */
      .get('/jobs/:id/progress', view, async (c) => {
        const id = c.req.param('id')
        await getJob(db, ctxOf(c), id)
        const after = Number(c.req.query('after') ?? 0) || 0
        try {
          return c.json(await worker.progress(id, after))
        } catch (err) {
          if (err instanceof WorkerClientError) return c.json({ lines: [], running: false, unavailable: true })
          throw err
        }
      })
      /** 时间轴刷写的帧清单 */
      .get('/jobs/:id/history', view, async (c) => {
        const id = c.req.param('id')
        await getJob(db, ctxOf(c), id)
        try {
          return c.json(await worker.history(id))
        } catch (err) {
          if (err instanceof WorkerClientError && err.status === 404) throw new PcbCamError('PCB_LAYER_NOT_READY', err.detail || '这个任务还没有可回放的改图记录。')
          throw err
        }
      })
      /** 自然语言查板:一句话 → 结构化查询(规则优先,模型兜底)→ worker 实测 → 图上的框 + 一句回答 */
      .post('/jobs/:id/ask', view, async (c) => {
        const ctx = ctxOf(c)
        const id = c.req.param('id')
        await getJob(db, ctx, id)
        const { question } = AskBody.parse(await c.req.json())
        const t = await translateQuestion(db, ctx, question)
        if (!t) return c.json({ ok: false, answer: '没听懂。试试:「内层小于 4mil 的线」「顶层大于 2mm 的焊盘」「这块板哪里改动最多」', query: null, result: null })
        try {
          const result = await worker.query(id, { ...t.query, limit: 400 })
          return c.json({ ok: true, via: t.via, query: t.query, result, answer: describeAnswer(t.query, result) })
        } catch (err) {
          if (err instanceof WorkerClientError && err.code === 'WORKER_TIMEOUT') throw new PcbCamError('PCB_WORKER_BUSY', '引擎正忙,这个问题没能及时算完;过一会儿再问。')
          throw err
        }
      })

      // A 线:回读校验步的 EQ 放行 —— 工程师接受了「续投第 N 段」/「等主机」→ 先让 worker 续投,再让回读校验重跑一次
      .post('/jobs/:id/eq/submit', approve, async (c) => {
        const ctx = ctxOf(c)
        const id = c.req.param('id')
        const act = await pendingGenesisAction(db, ctx, id)
        // ★顺序:先 submitEq(它校验状态并原子地改状态),再让主机续投。反过来的话两个人同时放行,
        //   两次都会调 resume —— resume 会删掉 <job>.result.json,而输的那次 submitEq 抛错,
        //   于是主机结果没了、任务还停在原地,再也回填不了。
        const job = await submitEq(db, ctx, id, act ? { rerun: 'gatekeeper' } : {})
        if (act?.type === 'resume') await worker.genesisResume(id, act.fromPart)
        return c.json(job)
      })
      .get('/jobs/:id/genesis', view, async (c) => {
        await getJob(db, ctxOf(c), c.req.param('id'))
        return c.json(await worker.genesisStatus(c.req.param('id')))
      })
      .post('/jobs/:id/stages/:stage/retry', approve, async (c) =>
        c.json(await retryStage(db, ctxOf(c), c.req.param('id'), StageParam.parse(c.req.param('stage')))),
      )
      .post('/jobs/:id/cancel', approve, async (c) => c.json(await cancelJob(db, ctxOf(c), c.req.param('id'))))

      /** MI 工艺流程单:确定性板型判定 + 第 17 章模板;JSON 给页面,?format=html 给下载/打印 */
      .get('/jobs/:id/mi-sheet', view, async (c) => {
        const ctx = ctxOf(c)
        const job = await getJob(db, ctx, c.req.param('id'))
        const sheet = buildMiSheet(job)
        if (c.req.query('format') === 'html') {
          const project = await getProject(db, ctx, job.projectId)
          const html = renderMiSheetHtml(sheet, { projectName: project.name, customerName: project.customerName, jobId: job.id, generatedAt: new Date() })
          return c.body(html, 200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="MI-${encodeURIComponent(project.name)}-${job.id.slice(0, 8)}.html"`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': 'sandbox',
          })
        }
        return c.json(sheet)
      })
      /** 叠层压合结构示意图(SVG,服务端生成,无外链) */
      .get('/jobs/:id/stackup.svg', view, async (c) => {
        const job = await getJob(db, ctxOf(c), c.req.param('id'))
        const svg = renderStackupSvg(buildStackup(job))
        return c.body(svg, 200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
        })
      })

      /** 成果物:url 用私有标记,出站中间件(core/http/private-files)换成带票据的下载地址 */
      .get('/jobs/:id/artifacts', view, async (c) => {
        const items = await listArtifacts(db, ctxOf(c), c.req.param('id'))
        return c.json({ items: items.map((a) => ({ ...a, url: privateMarker(a.storageKey) })) })
      })
      /** 一键打包:服务端把成果物读出来打成一个 zip(按类型分目录)。默认只打要交出去的,?group=all 连过程数据一起 */
      .get('/jobs/:id/artifacts.zip', view, async (c) => {
        const group = c.req.query('group') === 'all' ? 'all' : 'deliverables'
        const pack = await packArtifacts(db, ctxOf(c), c.req.param('id'), group)
        return c.body(new Uint8Array(pack.bytes), 200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${pack.filename}"`,
          'Content-Length': String(pack.bytes.length),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        })
      })

      // ── 工厂标准 ──
      /** 内置标准(= schema)与校验都由 worker 提供:default.yaml 是唯一的字段来源,避免两边漂移 */
      .get('/factory-profiles/default', view, async (c) => c.json(await worker.profileDefault()))
      .post('/factory-profiles/validate', config, async (c) => {
        const body = z.object({ yaml: z.string().max(200_000) }).parse(await c.req.json())
        return c.json(await worker.profileValidate(body.yaml))
      })
      .get('/factory-profiles', view, async (c) => c.json({ items: await listFactoryProfiles(db, ctxOf(c)) }))
      .get('/factory-profiles/:id', view, async (c) => c.json(await getFactoryProfile(db, ctxOf(c), c.req.param('id'))))
      .post('/factory-profiles', config, async (c) => {
        const body = ProfileBody.parse(await c.req.json())
        const v = await worker.profileValidate(body.yaml)
        if (!v.ok) throw new PcbCamError('PCB_PROFILE_INVALID', `工厂标准不合法:${v.errors.slice(0, 3).join(';')}`)
        return c.json(await upsertFactoryProfile(db, ctxOf(c), body))
      })
      .put('/factory-profiles/:id', config, async (c) => {
        const body = { ...ProfileBody.parse(await c.req.json()), id: c.req.param('id') }
        const v = await worker.profileValidate(body.yaml)
        if (!v.ok) throw new PcbCamError('PCB_PROFILE_INVALID', `工厂标准不合法:${v.errors.slice(0, 3).join(';')}`)
        return c.json(await upsertFactoryProfile(db, ctxOf(c), body))
      })

      /** worker 健康:给页面顶部「引擎离线」提示用;不暴露内部地址 */
      .get('/worker/health', view, async (c) => c.json(await worker.health()))
  )
}

/** 问单 HTML:EQ 条目 + 它们在报告里的位置/层 → 每条一张板图局部(层 SVG 只取一次,最多 EQ_SHEET_MAX_LAYERS 层)。 */
async function eqSheetHtml(db: Db, ctx: Ctx, worker: PcbWorkerClient, job: JobDTO): Promise<string> {
  const project = await getProject(db, ctx, job.projectId)
  const items = await listEqItems(db, ctx, job.id)
  const located: EqSheetItem[] = []
  const reports = new Map<string, Array<{ id: string; layer: string | null; location: EqSheetItem['location'] }>>()
  for (const it of items) {
    if (!reports.has(it.stage)) {
      const r = await getStageReport(db, ctx, job.id, it.stage)
      const arr = Array.isArray(r?.report?.items) ? (r!.report!.items as Array<{ id: string; layer: string | null; location: EqSheetItem['location'] }>) : []
      reports.set(it.stage, arr)
    }
    const hit = reports.get(it.stage)!.find((x) => x.id === it.itemId)
    located.push({ ...it, layer: hit?.layer ?? null, location: hit?.location ?? null })
  }
  const layers = [...new Set(located.filter((i) => i.layer && i.location && ['ask_customer', 'manual'].includes(i.decision)).map((i) => i.layer!))].slice(0, EQ_SHEET_MAX_LAYERS)
  const svgByLayer = new Map<string, string>()
  for (const layer of layers) {
    try {
      svgByLayer.set(layer, await worker.layerSvg(job.id, layer, 'board'))
    } catch {
      // 没图也出单:表格照出,局部图位置留「无图」
    }
  }
  const names = await getEmployeeNames(db, ctx.tenantId, [ctx.employeeId])
  return renderEqSheetHtml(located, svgByLayer, { projectName: project.name, customerName: project.customerName, jobId: job.id, generatedAt: new Date(), engineer: names.get(ctx.employeeId) ?? null })
}

/** 上传幂等键(进程内,10 分钟)。多实例部署时退化为「不去重」,不会出错,只是可能重复建 job。 */
const idempotency = new Map<string, { jobId: string; expires: number }>()
