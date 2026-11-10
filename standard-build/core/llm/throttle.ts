// core/llm/throttle.ts
// 火山方舟(ark)突发流量削峰 + 全供应商退避重试。落地火山「突发流量处理最佳实践」的三件事:
//   ① 客户端限流削峰:把瞬时并发压平成稳定速率(每账号最大在飞数 + 两次派发最小间隔),本地节流比配额保守;
//   ② 指数退避重试 + jitter:命中 429 / 5xx / 网络错误时按 base×2ⁿ(封顶)退避再试,加随机抖动防「重试风暴」;
//   ③ 优先 Retry-After:上游给了 retry-after / retry-after-ms 就照它等,没有才退避。
// 参考:https://www.volcengine.com/docs/82379/1848593(突发流量处理最佳实践)
//
// 设计约束:所有走本闸门的请求都在 nginx 网关(proxy_read_timeout ~60s)之后。整段重试受一个「绝对截止时间」
// (deadline)约束——退避前先看剩余预算够不够再试一次,不够就直接抛,保证后端总在网关 504 之前返回可读错误。
// 只有 ark 走并发/间隔削峰(见 gateConfigFor);其它供应商(百炼/DeepSeek/混元)只享受退避重试,不排队、不加延迟。
import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import { LlmError } from './errors'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const intEnv = (name: string, dflt: number): number => {
  const raw = process.env[name]
  if (!raw) return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

// ── 错误分类:429 限流 / 5xx 服务端 / 无 status(连接超时/网络中断)→ 可退避重试;
//    4xx(除 429,如 400 参数错 / 401 鉴权)= 确定性错误,重试也没用,直接暴露。──────────────────
export function classifyLLMError(err: unknown): { status?: number; retryable: boolean } {
  if (err instanceof OpenAI.APIError) {
    const status = err.status
    const retryable = status === 429 || (typeof status === 'number' && status >= 500) || status === undefined
    return { status, retryable }
  }
  if (err instanceof LlmError) return { status: err.status, retryable: !!err.retryable }
  return { retryable: true } // 未知错误(网络层非 APIError 抛出等):保守当可重试
}
export function isRetryableLLMError(err: unknown): boolean {
  return classifyLLMError(err).retryable
}

/**
 * 上游说的是「这个模型名我没配路由」吗?
 *
 * 网关模式下每个场景发的是虚拟模型名(`aios-<scene>`),网关只认它配过的那些;
 * 没配时回的是 400 + 「provider or model not configured for request model 'aios-xxx'」。
 * 这**不是**参数写错,而是「这个场景还没在网关上配」—— 调用方据此改用主模型重试一次
 * (见 core/llm/caller.ts;判据放这里是为了和上面那套错误分类待在一处)。
 *
 * ★只认 400:401/403 也可能提到 model,但那是鉴权问题,换个模型名一样过不去。
 */
export function isModelNotConfigured(err: unknown): boolean {
  const { status } = classifyLLMError(err)
  if (status !== 400) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /not configured/i.test(msg) && /model/i.test(msg)
}

/** 从上游错误里取服务端建议的等待毫秒(retry-after-ms 优先;retry-after 支持「秒」或 HTTP 日期);无则 undefined。 */
function serverRetryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof OpenAI.APIError) || !err.headers) return undefined
  const get = (name: string): string | null => {
    try {
      return err.headers instanceof Headers ? err.headers.get(name) : ((err.headers as Record<string, string>)[name] ?? null)
    } catch {
      return null
    }
  }
  const ms = get('retry-after-ms')
  if (ms) {
    const n = Number(ms)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const ra = get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000
    const at = Date.parse(ra) // HTTP 日期形式
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  }
  return undefined
}

// ── 削峰闸门:每账号一份(provider + 密钥指纹;限流是按 key 计的,不同租户/密钥互不影响)──────────────
// 组合两个限制器:并发信号量(最大在飞数)+ 全局最小派发间隔(把突发平滑成稳定速率)。
class Gate {
  private active = 0
  private waiters: Array<() => void> = []
  private nextAt = 0
  constructor(
    private readonly maxConcurrency: number,
    private readonly minIntervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    // 最小间隔削峰:并发到达的多个请求会拿到依次递增的派发时刻(now, now+间隔, now+2×间隔…)。
    const now = Date.now()
    const wait = Math.max(0, this.nextAt - now)
    this.nextAt = Math.max(now, this.nextAt) + this.minIntervalMs
    if (wait > 0) await sleep(wait)
  }

  release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }
}

// 只有火山(ark)排队削峰。默认值保守,可用环境变量按实际购买的 RPM 微调(本地节流应比官方配额保守 5–10%)。
//   ARK_MAX_CONCURRENCY:最大在飞请求数(默认 4)   ARK_MIN_INTERVAL_MS:两次派发最小间隔(默认 120ms ≈ 500 RPM 上限)
function gateConfigFor(provider: string): { maxConcurrency: number; minIntervalMs: number } | undefined {
  if (provider !== 'ark') return undefined
  return { maxConcurrency: intEnv('ARK_MAX_CONCURRENCY', 4), minIntervalMs: intEnv('ARK_MIN_INTERVAL_MS', 120) }
}

const gates = new Map<string, Gate>()
function gateFor(provider: string, apiKey?: string): Gate | undefined {
  const cfg = gateConfigFor(provider)
  if (!cfg) return undefined
  const fp = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 12) : 'nokey'
  const key = `${provider}:${fp}`
  let gate = gates.get(key)
  if (!gate) {
    gate = new Gate(cfg.maxConcurrency, cfg.minIntervalMs)
    gates.set(key, gate)
  }
  return gate
}

export type LlmRequestOptions = {
  maxAttempts?: number // 含首次的总尝试次数(默认 4)
  baseDelayMs?: number // 退避基数(默认 500)
  maxDelayMs?: number // 单次退避封顶(默认 8000)
  totalBudgetMs?: number // 整段(排队+尝试+退避)墙钟预算,默认 55s(留 nginx 60s 余量);传了 deadline 则忽略
  deadline?: number // 绝对截止时刻(Date.now()+预算);跨「主选→备用」共享同一 deadline 时显式传入,避免二者预算叠加超网关
}

// 退避:优先服务端 Retry-After;否则 base×2^(n-1) 封顶,再叠加 50–100% 抖动(equal jitter)防同步重试雪崩。
function backoffMs(err: unknown, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const server = serverRetryAfterMs(err)
  if (server !== undefined) return Math.min(server, maxDelayMs) + Math.floor(Math.random() * 250)
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.floor(exp * (0.5 + Math.random() * 0.5))
}

/**
 * 统一 LLM 请求包装:先过削峰闸门(仅 ark),再跑 fn;命中可重试错误(429/5xx/超时)就按退避重试,
 * 整段受 deadline 约束——退避前算好剩余预算,不够再跑一次就直接抛。fn 通常是 OpenAI SDK 的一次 create 调用。
 */
export async function llmRequest<T>(gateKey: { provider: string; apiKey?: string }, fn: () => Promise<T>, opts: LlmRequestOptions = {}): Promise<T> {
  const { maxAttempts = 4, baseDelayMs = 500, maxDelayMs = 8000 } = opts
  const deadline = opts.deadline ?? Date.now() + (opts.totalBudgetMs ?? 55_000)
  const gate = gateFor(gateKey.provider, gateKey.apiKey)
  let attempt = 0
  for (;;) {
    attempt++
    if (gate) await gate.acquire()
    try {
      return await fn()
    } catch (err) {
      if (!isRetryableLLMError(err) || attempt >= maxAttempts) throw err
      const delay = backoffMs(err, attempt, baseDelayMs, maxDelayMs)
      if (Date.now() + delay >= deadline) throw err // 预算不够再等一轮 → 直接暴露,别拖到网关超时
      await sleep(delay)
    } finally {
      if (gate) gate.release()
    }
  }
}
