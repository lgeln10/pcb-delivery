// modules/pcb-cam/worker-client.ts
// 调 pcb-worker(Python,独立 service)的唯一出口。★每个调用都有超时(质量红线:无超时的网络调用)。
// 测试用 FakeWorkerClient 脚本化返回报告,不起网络。
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { CompareResultSchema, GoldenManifestSchema, type CompareResult, type GoldenManifest, StageReportSchema, type StageReport } from './worker-types'
import type { PcbCamStage } from './stages'

export type WorkerStageInput = {
  jobId: string
  tenantId: string
  stage: PcbCamStage
  attempt: number
  inputKeys: string[]
  layerMap: Record<string, unknown> | null
  orderSpec: Record<string, unknown> | null
  profileYaml: string | null
  /** 产物应写到的存储前缀(不变量 5),worker 原样带回 artifacts.path */
  outputPrefix: string
}

export type WorkerClientErrorCode = 'WORKER_TIMEOUT' | 'WORKER_HTTP' | 'WORKER_BAD_REPORT' | 'WORKER_UNREACHABLE'
export class WorkerClientError extends Error {
  constructor(
    public code: WorkerClientErrorCode,
    message: string,
    /** worker 的 HTTP 状态(WORKER_HTTP 时才有):404 是「这层/这个副本还没有」,不是系统故障 */
    public status?: number,
    /** worker 的 detail 正文(已截断),用来给用户看真正的原因 */
    public detail?: string,
  ) {
    super(message)
    this.name = 'WorkerClientError'
  }
}

export type ProfileField = { key: string; value: unknown; default: unknown; type: string; doc: string; overridden: boolean }
export type ProfileValidation = { ok: boolean; errors: string[]; fields: ProfileField[] }

export interface PcbWorkerClient {
  health(): Promise<{ ok: boolean; detail?: string }>
  runStage(input: WorkerStageInput): Promise<StageReport>
  /** ``frame='board'``:按板外形出图(各层同坐标系),用于多层叠加对照;``rev='orig'``:客户原稿(不看 edit 副本),用于对原稿 */
  layerSvg(jobId: string, layer: string, frame?: 'board', rev?: 'orig' | PcbCamStage, step?: 'panel'): Promise<string>
  /** 引擎实况流:stage / op 级进度行,按 after=<n> 增量拉(worker engine/pipeline/progress.py) */
  progress(jobId: string, after?: number): Promise<WorkerProgress>
  /** 时间轴刷写的帧:orig → 改过图的 stage → panel(worker engine/query.py history) */
  history(jobId: string): Promise<WorkerHistory>
  /** 结构化查板(自然语言由 ask.ts 翻好):找物件 / 问改动分布,结果带 bbox */
  query(jobId: string, body: Record<string, unknown>): Promise<WorkerQueryResult>
  /** 终稿对比:把人工终稿(storage key,zip 或散文件)交给 worker 存下并按后缀和输出配对;重传替换整套 */
  golden(jobId: string, keys: string[]): Promise<GoldenManifest>
  /** 终稿对比:逐层三档 + C 档簇清单 + 钻孔孔径×孔数(worker 侧按文件指纹缓存) */
  compare(jobId: string, force?: boolean): Promise<CompareResult>
  /** 终稿对比叠加图:终稿灰底、我们的层色、少了涂红、多了涂蓝、C 档簇画框(data-cluster) */
  compareSvg(jobId: string, suffix: string): Promise<string>
  /** 内置工厂标准(= schema):YAML 全文 + 平铺字段(带培训文档页码说明) */
  profileDefault(): Promise<{ yaml: string; fields: ProfileField[] }>
  /** 校验租户覆盖 YAML:未知键 / 类型不符 / 语法错 → errors;合并后的字段 → fields */
  profileValidate(yaml: string): Promise<ProfileValidation>
  /** A 线(Genesis 主机):任务在主机上的状态 —— 未投递 / 等待 / 在第 N 段暂停 / 第 N 段失败 / 完成 */
  genesisStatus(jobId: string): Promise<GenesisStatus>
  /** A 线:工程师在网页放行暂停/失败的段后,从第 fromPart 段续投(主机代理只跑剩下的段) */
  genesisResume(jobId: string, fromPart: number): Promise<{ resumed: boolean; from_part?: number; parts?: string[] }>
}

export type WorkerProgressLine = { n: number; ts: number; stage: string; event: string; message: string; call?: number; op?: string; layer?: string | null; ms?: number; added?: number; deleted?: number; modified?: number; status?: string; errors?: number; warns?: number; decisions?: number }
export type WorkerProgress = { lines: WorkerProgressLine[]; running: boolean }
export type WorkerHistoryFrame = { stage: string; layers: string[]; ops: Array<{ n: number; op: string; layer: string | null; kind: string; key: string; added: number; deleted: number; modified: number; ms?: number | null }>; panel?: boolean }
export type WorkerHistory = { frames: WorkerHistoryFrame[]; by_layer: Record<string, string[]> }
export type WorkerQueryHit = { layer: string; kind: string; x: number; y: number; bbox: [number, number, number, number]; measured: number | null; symbol?: string | null; net?: string | null; op?: string; stage?: string; note?: string }
export type WorkerQueryResult = { what: 'features' | 'changes'; total: number; by_layer: Record<string, number>; by_op?: Record<string, number>; hits: WorkerQueryHit[]; truncated: number }

export type GenesisStatus = {
  configured: boolean
  delivered: boolean
  state: 'not_delivered' | 'waiting' | 'paused' | 'failed' | 'done' | 'incomplete'
  parts?: string[]
  parts_pending?: string[]
  paused_part?: number | null
  failed_part?: number | null
  genesis_version?: string
  submitted_at?: string | null
  finished_at?: string | null
}

/** 单 stage 超时(ms)。几何重的 stage 放宽;改这里不要改调用方。
 *  第一块真板(六层 3oz、7 500 孔、500×447)本地引擎改图:内层 ≈ 12 min、外层 ≈ 8 min、阻焊 ≈ 5 min ——
 *  按它放到 20 min;更大的板用 PCB_WORKER_STAGE_TIMEOUT_SCALE(倍数)整体放大。 */
const SCALE = Math.max(0.1, Number(process.env.PCB_WORKER_STAGE_TIMEOUT_SCALE) || 1)
export const STAGE_TIMEOUT_MS: Record<PcbCamStage, number> = {
  intake: 120_000 * SCALE,
  order_spec: 60_000 * SCALE,
  align: 300_000 * SCALE,
  drill: 300_000 * SCALE,
  inner: 1_200_000 * SCALE,
  outer: 1_200_000 * SCALE,
  mask: 900_000 * SCALE,
  silk: 300_000 * SCALE,
  net_compare: 600_000 * SCALE,
  panel: 300_000 * SCALE,
  output: 900_000 * SCALE,
  gatekeeper: 600_000 * SCALE,
}
const HEALTH_TIMEOUT_MS = 5_000
const GENESIS_TIMEOUT_MS = 15_000
const SVG_TIMEOUT_MS = 90_000 // 工作板整层第一次折叠慢,且 worker 单进程时要排在正在跑的 stage 后面
const PROFILE_TIMEOUT_MS = 10_000
const COMPARE_TIMEOUT_MS = 15 * 60_000 // 整板逐层折叠 + 差集:六层真板约 1 分钟,首次之后走缓存

export function workerBaseUrl(): string {
  return (process.env.PCB_WORKER_URL || 'http://pcb-worker:8000').replace(/\/+$/, '')
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WorkerClientError('WORKER_TIMEOUT', `pcb-worker 超过 ${Math.round(timeoutMs / 1000)}s 未响应`)
    }
    throw new WorkerClientError('WORKER_UNREACHABLE', `pcb-worker 连不上:${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(t)
  }
}

/** 跑一个 stage 用它而不是 fetch:Node 内置 fetch(undici)响应头超过 5 min 就报 "fetch failed",
 *  真板的内层/外层要十几分钟(第一块真板 2026-09-10 就是这样失败的)。同样的 AbortError 语义,超时由调用方定。 */
type LongResponse = { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }
function longRequest(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, timeoutMs: number): Promise<LongResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = lib(u, { method: init.method, headers: init.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const status = res.statusCode ?? 0
        resolve({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) as unknown })
      })
    })
    const t = setTimeout(() => {
      const err = new Error(`timeout after ${timeoutMs}ms`)
      err.name = 'AbortError'
      req.destroy(err)
    }, timeoutMs)
    req.on('error', reject)
    req.on('close', () => clearTimeout(t))
    if (init.body) req.write(init.body)
    req.end()
  })
}

async function runStageRequest(url: string, body: string, timeoutMs: number): Promise<LongResponse> {
  return longRequestSafe(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, timeoutMs)
}

/** longRequest + 和 fetchWithTimeout 一样的错误归类(超时 → WORKER_TIMEOUT,连不上 → WORKER_UNREACHABLE):
 *  终稿对比的三个调用也走它 —— 直接用 longRequest 会把裸的 ECONNREFUSED 抛到路由层。 */
async function longRequestSafe(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, timeoutMs: number): Promise<LongResponse> {
  try {
    return await longRequest(url, init, timeoutMs)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WorkerClientError('WORKER_TIMEOUT', `pcb-worker 超过 ${Math.round(timeoutMs / 1000)}s 未响应`)
    }
    throw new WorkerClientError('WORKER_UNREACHABLE', `pcb-worker 连不上:${err instanceof Error ? err.message : String(err)}`)
  }
}

export function createHttpWorkerClient(baseUrl: string = workerBaseUrl()): PcbWorkerClient {
  return {
    async health() {
      try {
        const res = await fetchWithTimeout(`${baseUrl}/health`, { method: 'GET' }, HEALTH_TIMEOUT_MS)
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
        return { ok: true }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    },
    async runStage(input) {
      const res = await runStageRequest(
        `${baseUrl}/jobs/${encodeURIComponent(input.jobId)}/stages/${input.stage}`,
        JSON.stringify({
          tenant_id: input.tenantId,
          attempt: input.attempt,
          input_keys: input.inputKeys,
          layer_map: input.layerMap,
          order_spec: input.orderSpec,
          profile_yaml: input.profileYaml,
          output_prefix: input.outputPrefix,
        }),
        STAGE_TIMEOUT_MS[input.stage],
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}:${text.slice(0, 200)}`)
      }
      const json: unknown = await res.json().catch(() => null)
      const parsed = StageReportSchema.safeParse(json)
      if (!parsed.success) {
        throw new WorkerClientError('WORKER_BAD_REPORT', `pcb-worker 报告格式不对:${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`)
      }
      if (parsed.data.stage !== input.stage) {
        throw new WorkerClientError('WORKER_BAD_REPORT', `pcb-worker 返回了别的 stage 的报告(${parsed.data.stage})`)
      }
      return parsed.data
    },
    async layerSvg(jobId, layer, frame, rev, step) {
      const qs = new URLSearchParams()
      if (frame === 'board') qs.set('frame', 'board')
      if (rev) qs.set('rev', rev) // orig = 客户原稿;<stage> = 那一步之后的样子(时间轴刷写)
      if (step === 'panel') qs.set('step', 'panel') // 工作板副本(本地引擎拼板后的层),不是单只
      const q = qs.toString()
      const res = await fetchWithTimeout(
        `${baseUrl}/jobs/${encodeURIComponent(jobId)}/layers/${encodeURIComponent(layer)}.svg${q ? `?${q}` : ''}`,
        { method: 'GET' },
        SVG_TIMEOUT_MS,
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        let detail = body.slice(0, 300)
        try {
          detail = String((JSON.parse(body) as { detail?: unknown }).detail ?? detail)
        } catch {
          // worker 出错时不一定是 JSON;原样截断给用户
        }
        throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status, detail)
      }
      return res.text()
    },
    async progress(jobId, after = 0) {
      const res = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/progress?after=${after}`, { method: 'GET' }, PROFILE_TIMEOUT_MS)
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status)
      return (await res.json()) as WorkerProgress
    },
    async history(jobId) {
      const res = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/history`, { method: 'GET' }, PROFILE_TIMEOUT_MS)
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status, (await res.text()).slice(0, 300))
      return (await res.json()) as WorkerHistory
    },
    async query(jobId, body) {
      const res = await longRequestSafe(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, SVG_TIMEOUT_MS)
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status, (await res.text()).slice(0, 300))
      return (await res.json()) as WorkerQueryResult
    },
    async golden(jobId, keys) {
      const res = await longRequestSafe(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/golden`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) }, COMPARE_TIMEOUT_MS)
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status, (await res.text()).slice(0, 300))
      return GoldenManifestSchema.parse(await res.json())
    },
    async compare(jobId, force) {
      const res = await longRequestSafe(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/compare${force ? '?force=true' : ''}`, { method: 'GET' }, COMPARE_TIMEOUT_MS)
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status, (await res.text()).slice(0, 300))
      return CompareResultSchema.parse(await res.json())
    },
    async compareSvg(jobId, suffix) {
      const res = await longRequestSafe(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/compare/${encodeURIComponent(suffix.replace(/^\./, ''))}.svg`, { method: 'GET' }, COMPARE_TIMEOUT_MS)
      if (!res.ok) {
        const body = await res.text()
        let detail = body.slice(0, 300)
        try {
          detail = String((JSON.parse(body) as { detail?: unknown }).detail ?? detail)
        } catch {
          // 非 JSON 原样截断
        }
        throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`, res.status, detail)
      }
      return res.text()
    },
    async profileDefault() {
      const res = await fetchWithTimeout(`${baseUrl}/profiles/default`, { method: 'GET' }, PROFILE_TIMEOUT_MS)
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`)
      return (await res.json()) as { yaml: string; fields: ProfileField[] }
    },
    async profileValidate(yaml) {
      const res = await fetchWithTimeout(
        `${baseUrl}/profiles/validate`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_yaml: yaml }) },
        PROFILE_TIMEOUT_MS,
      )
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`)
      return (await res.json()) as ProfileValidation
    },
    async genesisStatus(jobId) {
      const res = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/genesis/status`, { method: 'GET' }, GENESIS_TIMEOUT_MS)
      if (res.status === 409) return { configured: false, delivered: false, state: 'not_delivered' }
      if (!res.ok) throw new WorkerClientError('WORKER_HTTP', `pcb-worker 返回 HTTP ${res.status}`)
      return (await res.json()) as GenesisStatus
    },
    async genesisResume(jobId, fromPart) {
      const res = await fetchWithTimeout(
        `${baseUrl}/jobs/${encodeURIComponent(jobId)}/genesis/resume`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from_part: fromPart }) },
        GENESIS_TIMEOUT_MS,
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new WorkerClientError('WORKER_HTTP', `pcb-worker 续投失败 HTTP ${res.status}:${text.slice(0, 200)}`)
      }
      return (await res.json()) as { resumed: boolean; from_part?: number; parts?: string[] }
    },
  }
}

/** 测试用:按 stage 脚本化返回;未脚本化的 stage 返回空 ok 报告;可注入抛错。 */
export class FakeWorkerClient implements PcbWorkerClient {
  calls: WorkerStageInput[] = []
  // 脚本可以返回「不完整」的报告对象(测试里省略 layer/location 等可选字段),这里统一过 zod 补默认值
  scripts = new Map<PcbCamStage, (input: WorkerStageInput) => unknown>()
  failNext: Error | null = null

  on(stage: PcbCamStage, fn: (input: WorkerStageInput) => unknown): this {
    this.scripts.set(stage, fn)
    return this
  }
  async health() {
    return { ok: true }
  }
  async runStage(input: WorkerStageInput): Promise<StageReport> {
    this.calls.push(input)
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    const fn = this.scripts.get(input.stage)
    const report = fn ? await fn(input) : { stage: input.stage, status: 'ok' as const, summary: '', items: [], artifacts: [] }
    return StageReportSchema.parse(report)
  }
  /** 记录最后一次调用的画框,供路由测试断言 `?frame=board` 有没有透传 */
  lastLayerSvgFrame: 'board' | undefined | null = null
  lastLayerSvgRev: 'orig' | PcbCamStage | undefined
  lastLayerSvgStep: 'panel' | undefined
  progressLines: WorkerProgressLine[] = []
  async progress(_jobId: string, after = 0): Promise<WorkerProgress> {
    return { lines: this.progressLines.filter((l) => l.n > after), running: false }
  }
  historyResult: WorkerHistory = { frames: [{ stage: 'orig', layers: [], ops: [] }], by_layer: {} }
  async history(_jobId: string): Promise<WorkerHistory> {
    return this.historyResult
  }
  queryCalls: Array<Record<string, unknown>> = []
  queryResult: WorkerQueryResult = { what: 'features', total: 0, by_layer: {}, hits: [], truncated: 0 }
  async query(_jobId: string, body: Record<string, unknown>): Promise<WorkerQueryResult> {
    this.queryCalls.push(body)
    return { ...this.queryResult, what: body.what === 'changes' ? 'changes' : 'features' }
  }
  async layerSvg(_jobId: string, _layer: string, frame?: 'board', rev?: 'orig' | PcbCamStage, step?: 'panel') {
    this.lastLayerSvgFrame = frame
    this.lastLayerSvgRev = rev
    this.lastLayerSvgStep = step
    return `<svg xmlns="http://www.w3.org/2000/svg" data-frame="${frame ?? 'own'}" data-rev="${rev ?? 'edit'}" data-step="${step ?? 'edit'}"></svg>`
  }
  goldenCalls: Array<{ jobId: string; keys: string[] }> = []
  compareResult: CompareResult = { fingerprint: '', has_golden: false, has_output: true, golden_files: [], unmatched_output: [], unmatched_golden: [], layers: [], drill: null, summary: { n_layers: 0, n_clusters: 0, worst: null } }
  async golden(jobId: string, keys: string[]): Promise<GoldenManifest> {
    this.goldenCalls.push({ jobId, keys })
    return { has_golden: keys.length > 0, has_output: true, golden_files: keys.map((k) => k.split('/').pop()!), layers: [], unmatched_output: [], unmatched_golden: [], drill: null, errors: [] }
  }
  async compare(_jobId: string): Promise<CompareResult> {
    return this.compareResult
  }
  lastCompareSvgSuffix: string | null = null
  async compareSvg(_jobId: string, suffix: string) {
    this.lastCompareSvgSuffix = suffix
    return `<svg xmlns="http://www.w3.org/2000/svg" data-compare="${suffix}"><g class="cmp-gold"></g><g class="cmp-clusters"></g></svg>`
  }
  async profileDefault() {
    return { yaml: '# default\ndrill:\n  via_max_mm: 0.5\n', fields: [{ key: 'drill.via_max_mm', value: 0.5, default: 0.5, type: 'number', doc: 'p114', overridden: false }] }
  }
  genesisResumeCalls: Array<{ jobId: string; fromPart: number }> = []
  genesisState: GenesisStatus = { configured: false, delivered: false, state: 'not_delivered' }
  async genesisStatus(_jobId: string): Promise<GenesisStatus> {
    return this.genesisState
  }
  async genesisResume(jobId: string, fromPart: number) {
    this.genesisResumeCalls.push({ jobId, fromPart })
    return { resumed: true, from_part: fromPart, parts: [] }
  }
  async profileValidate(yaml: string): Promise<ProfileValidation> {
    const bad = /bogus/.test(yaml)
    return { ok: !bad, errors: bad ? ['未知字段 bogus'] : [], fields: [{ key: 'drill.via_max_mm', value: 0.5, default: 0.5, type: 'number', doc: 'p114', overridden: /via_max_mm/.test(yaml) }] }
  }
}
