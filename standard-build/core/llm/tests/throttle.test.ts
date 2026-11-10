// core/llm/tests/throttle.test.ts
// 火山削峰闸门 + 退避重试的单测(不触网,用假 fn 模拟上游 429/成功)。
import { describe, it, expect } from 'vitest'
import OpenAI from 'openai'
import { llmRequest, classifyLLMError, isRetryableLLMError } from '../throttle'

const err429 = (headers?: HeadersInit) => new OpenAI.APIError(429, undefined, 'rate', headers ? new Headers(headers) : undefined)
const err400 = () => new OpenAI.APIError(400, undefined, 'bad request', undefined)

describe('classifyLLMError', () => {
  it('429/5xx/网络无 status = 可重试;400/401 = 不可重试', () => {
    expect(classifyLLMError(err429()).retryable).toBe(true)
    expect(classifyLLMError(new OpenAI.APIError(503, undefined, 'busy', undefined)).retryable).toBe(true)
    expect(classifyLLMError(new OpenAI.APIError(undefined, undefined, 'timeout', undefined)).retryable).toBe(true)
    expect(classifyLLMError(err400()).retryable).toBe(false)
    expect(isRetryableLLMError(new Error('network blip'))).toBe(true)
  })
})

describe('llmRequest 退避重试', () => {
  it('命中 429 后退避重试,最终成功', async () => {
    let calls = 0
    const out = await llmRequest({ provider: 'deepseek' }, async () => {
      calls++
      if (calls < 3) throw err429()
      return 'ok'
    }, { baseDelayMs: 1, maxDelayMs: 5 })
    expect(out).toBe('ok')
    expect(calls).toBe(3)
  })

  it('确定性错误(400)不重试,直接抛', async () => {
    let calls = 0
    await expect(
      llmRequest({ provider: 'deepseek' }, async () => {
        calls++
        throw err400()
      }),
    ).rejects.toBeInstanceOf(OpenAI.APIError)
    expect(calls).toBe(1)
  })

  it('优先 Retry-After:上游要求的等待超过 deadline 剩余预算 → 不再等,直接抛(不拖到网关超时)', async () => {
    let calls = 0
    const started = Date.now()
    await expect(
      llmRequest(
        { provider: 'deepseek' },
        async () => {
          calls++
          throw err429({ 'retry-after-ms': '60000' }) // 上游让等 60s
        },
        { deadline: Date.now() + 200 }, // 但只剩 200ms 预算
      ),
    ).rejects.toBeInstanceOf(OpenAI.APIError)
    expect(calls).toBe(1) // 读到 Retry-After=60s > 剩余预算 → 立即放弃,没有第二次尝试
    expect(Date.now() - started).toBeLessThan(1000) // 没有真的睡 60s
  })

  it('deadline 到点后不再重试', async () => {
    let calls = 0
    await expect(
      llmRequest(
        { provider: 'deepseek' },
        async () => {
          calls++
          throw err429()
        },
        { baseDelayMs: 40, deadline: Date.now() + 120 },
      ),
    ).rejects.toBeInstanceOf(OpenAI.APIError)
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(calls).toBeLessThan(6) // 受 deadline 约束,不会打满
  })
})

describe('火山(ark)削峰闸门', () => {
  it('ARK_MAX_CONCURRENCY=1 → 火山请求串行,不重叠', async () => {
    process.env.ARK_MAX_CONCURRENCY = '1'
    process.env.ARK_MIN_INTERVAL_MS = '0'
    let active = 0
    let maxActive = 0
    const task = () =>
      llmRequest({ provider: 'ark', apiKey: 'k-serial' }, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 30))
        active--
        return 'ok'
      })
    await Promise.all([task(), task(), task()])
    expect(maxActive).toBe(1) // 闸门把并发压到 1
    delete process.env.ARK_MAX_CONCURRENCY
    delete process.env.ARK_MIN_INTERVAL_MS
  })

  it('非火山供应商不排队:并发可重叠', async () => {
    let active = 0
    let maxActive = 0
    const task = () =>
      llmRequest({ provider: 'deepseek', apiKey: 'k-parallel' }, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 30))
        active--
        return 'ok'
      })
    await Promise.all([task(), task(), task()])
    expect(maxActive).toBeGreaterThan(1) // 无闸门 → 真并发
  })

  it('ARK_MIN_INTERVAL_MS 给火山请求间加最小间隔(削峰)', async () => {
    process.env.ARK_MAX_CONCURRENCY = '8'
    process.env.ARK_MIN_INTERVAL_MS = '40'
    const started = Date.now()
    const task = () => llmRequest({ provider: 'ark', apiKey: 'k-spacing' }, async () => 'ok')
    await Promise.all([task(), task(), task()]) // 3 个瞬时并发
    // 第 2、3 个各被至少 40ms、80ms 的间隔推迟 → 总耗时 ≥ ~80ms
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    delete process.env.ARK_MAX_CONCURRENCY
    delete process.env.ARK_MIN_INTERVAL_MS
  })
})
