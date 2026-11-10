// core/llm/tests/thinking.test.ts
// 深度思考开关:默认关(方舟 doubao-seed 默认 auto=开着,交互式场景实测 234s vs 4.3s),
// 可按主模型/按场景打开;老模型/接入点不认这个字段则脱掉重试一次并记住。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import { _markNoThinkingForTest, _resetThinkingMemoForTest, isUnsupportedThinkingError, thinkingParams, withThinking } from '../thinking'

const apiError = (status: number, message: string) => new OpenAI.APIError(status, { error: { message } }, message, new Headers())

describe('thinkingParams 下发', () => {
  beforeEach(() => _resetThinkingMemoForTest())

  it('方舟:关 → disabled,开 → enabled(必须显式下发,不能靠模型默认)', () => {
    expect(thinkingParams('ark', 'doubao-seed-2-1-turbo-260628', false)).toEqual({ thinking: { type: 'disabled' } })
    expect(thinkingParams('ark', 'doubao-seed-2-1-turbo-260628', true)).toEqual({ thinking: { type: 'enabled' } })
  })

  it('接入点 ID 形式同样下发 —— 名字里读不出底层模型,不能靠白名单', () => {
    expect(thinkingParams('ark', 'ep-20240101-abcde', false)).toEqual({ thinking: { type: 'disabled' } })
  })

  it('非方舟供应商:一律不附加(它们要推理是换模型,不是靠这个字段)', () => {
    for (const p of ['bailian', 'deepseek', 'hunyuan']) {
      expect(thinkingParams(p, 'any-model', false)).toEqual({})
      expect(thinkingParams(p, 'any-model', true)).toEqual({})
    }
  })

  it('被记为不支持后不再下发,且不连累同供应商的其它模型', () => {
    _markNoThinkingForTest('ark', 'ep-legacy')
    expect(thinkingParams('ark', 'ep-legacy', false)).toEqual({})
    expect(thinkingParams('ark', 'doubao-seed-2-1-turbo-260628', false)).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('isUnsupportedThinkingError 判定', () => {
  it('只有「400 且报错提到 thinking」才算,别的错不许误判成脱参数重试', () => {
    expect(isUnsupportedThinkingError(apiError(400, 'invalid parameter: thinking is not supported'))).toBe(true)
    expect(isUnsupportedThinkingError(apiError(400, 'Thinking field unsupported'))).toBe(true) // 大小写不敏感
    expect(isUnsupportedThinkingError(apiError(400, 'invalid api key'))).toBe(false) // 400 但与 thinking 无关
    expect(isUnsupportedThinkingError(apiError(429, 'rate limit, thinking'))).toBe(false) // 限流要走退避重试
    expect(isUnsupportedThinkingError(apiError(500, 'thinking'))).toBe(false)
    expect(isUnsupportedThinkingError(new Error('thinking'))).toBe(false) // 非 APIError
  })
})

describe('withThinking 降级', () => {
  beforeEach(() => _resetThinkingMemoForTest())

  it('正常情况:带着参数发一次就够', async () => {
    // ★vi.fn 必须写全参数签名,否则 mock.calls 被推成空元组,取 [0] 直接类型报错
    const call = vi.fn(async (_extra: Record<string, unknown>) => 'ok')
    await expect(withThinking('ark', 'doubao-seed-2-1-turbo-260628', false, call)).resolves.toBe('ok')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![0]).toEqual({ thinking: { type: 'disabled' } })
  })

  it('老接入点回 400 说不认 thinking → 脱掉重试一次,且此后不再带', async () => {
    const call = vi.fn(async (extra: Record<string, unknown>) => {
      if ('thinking' in extra) throw apiError(400, 'thinking is not supported for this endpoint')
      return 'ok'
    })
    await expect(withThinking('ark', 'ep-legacy', false, call)).resolves.toBe('ok')
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]![0]).toEqual({}) // 第二次不带

    // 记住了:下一次直接不带,只调一次
    call.mockClear()
    await expect(withThinking('ark', 'ep-legacy', false, call)).resolves.toBe('ok')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![0]).toEqual({})
  })

  it('其它错误照常抛出,不吞不重试(429 要留给上层退避)', async () => {
    const call = vi.fn(async () => {
      throw apiError(429, 'rate limited')
    })
    await expect(withThinking('ark', 'doubao-seed-2-1-turbo-260628', false, call)).rejects.toThrow('rate limited')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('非方舟:不带参数,也不因错误做脱参数重试', async () => {
    const call = vi.fn(async (_extra: Record<string, unknown>) => {
      throw apiError(400, 'thinking')
    })
    await expect(withThinking('bailian', 'qwen-plus', false, call)).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![0]).toEqual({})
  })
})
