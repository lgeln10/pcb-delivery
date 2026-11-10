// core/llm/tests/scene-fallback.test.ts
// 多场景模型解析(场景覆盖/继承主模型/视觉能力默认)+ 备用模型兜底(错误分类 + retryable 切换)。
import OpenAI from 'openai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import type { Ctx } from '../../db/client'
import { LlmError } from '../errors'
import { classifyLLMError, isRetryableLLMError, runWithLLMFallback } from '../caller'
import {
  deleteSceneConfig,
  getConfig,
  resolveLLMRuntimeConfig,
  resolveLLMRuntimeConfigWithFallback,
  listEffectiveRoutes,
  saveProviderKey,
  updateConfig,
  upsertSceneConfig,
} from '../config'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-master-secret-for-encryption-0123456789'
  delete process.env.LLM_MODEL
  delete process.env.LLM_PROVIDER
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db, '场景模型公司')).ownerCtx
  await saveProviderKey(t.db, ctx, 'bailian', 'sk-bailian')
  await saveProviderKey(t.db, ctx, 'deepseek', 'sk-deepseek')
  await updateConfig(t.db, ctx, { provider: 'bailian', model: 'qwen-max' })
})
afterAll(async () => t.close())

describe('错误分类(是否可切备用重试)', () => {
  it('429/5xx/无 status(超时) 可重试;4xx(除429) 不可', () => {
    expect(classifyLLMError(new OpenAI.APIError(429, undefined, 'rate', undefined)).retryable).toBe(true)
    expect(classifyLLMError(new OpenAI.APIError(500, undefined, 'srv', undefined)).retryable).toBe(true)
    expect(classifyLLMError(new OpenAI.APIError(503, undefined, 'busy', undefined)).retryable).toBe(true)
    expect(classifyLLMError(new OpenAI.APIError(undefined, undefined, 'timeout', undefined)).retryable).toBe(true)
    expect(classifyLLMError(new OpenAI.APIError(400, undefined, 'bad req', undefined)).retryable).toBe(false)
    expect(classifyLLMError(new OpenAI.APIError(401, undefined, 'auth', undefined)).retryable).toBe(false)
  })
  it('LlmError 按其 retryable 字段;未知错误保守可重试', () => {
    expect(isRetryableLLMError(new LlmError('LLM_ERROR', 'x', { retryable: true }))).toBe(true)
    expect(isRetryableLLMError(new LlmError('LLM_ERROR', 'x', { retryable: false }))).toBe(false)
    expect(isRetryableLLMError(new Error('network blip'))).toBe(true)
  })
})

describe('runWithLLMFallback 兜底', () => {
  it('主选抛可重试错误 → 切备用', async () => {
    const out = await runWithLLMFallback({ primary: 'P', fallback: 'F' }, async (cfg) => {
      if (cfg === 'P') throw new OpenAI.APIError(429, undefined, 'rate', undefined)
      return `ok:${cfg}`
    })
    expect(out).toBe('ok:F')
  })
  it('主选抛不可重试错误 → 不切,直接抛', async () => {
    await expect(
      runWithLLMFallback({ primary: 'P', fallback: 'F' }, async (cfg) => {
        if (cfg === 'P') throw new OpenAI.APIError(400, undefined, 'bad', undefined)
        return `ok:${cfg}`
      }),
    ).rejects.toBeInstanceOf(OpenAI.APIError)
  })
  it('无备用 → 主选错误原样抛', async () => {
    await expect(
      runWithLLMFallback({ primary: 'P' }, async () => {
        throw new OpenAI.APIError(429, undefined, 'rate', undefined)
      }),
    ).rejects.toBeInstanceOf(OpenAI.APIError)
  })
})

describe('场景模型解析', () => {
  it('default 场景 = 主模型', async () => {
    expect((await resolveLLMRuntimeConfig(t.db, ctx)).model).toBe('qwen-max')
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'default')).model).toBe('qwen-max')
  })

  it('未覆盖的 chat 场景 → 继承主模型', async () => {
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'contract_gen')).model).toBe('qwen-max')
  })

  it('覆盖某场景 model → 只该场景变,provider 继承主', async () => {
    await upsertSceneConfig(t.db, ctx, { scene: 'pcb_cam', model: 'qwen-turbo' })
    const r = await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')
    expect(r.model).toBe('qwen-turbo')
    expect(r.provider).toBe('bailian')
    // 其它场景不受影响
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'contract_gen')).model).toBe('qwen-max')
  })

  it('vision 场景未覆盖 → 用能力默认(qwen-vl-max),不用文本主模型', async () => {
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'vision')).model).toBe('qwen-vl-max')
  })
  it('vision 场景可覆盖成别的视觉模型', async () => {
    await upsertSceneConfig(t.db, ctx, { scene: 'vision', model: 'qwen-vl-plus' })
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'vision')).model).toBe('qwen-vl-plus')
    await deleteSceneConfig(t.db, ctx, 'vision')
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'vision')).model).toBe('qwen-vl-max') // 清除后回能力默认
  })

  it('清除场景覆盖 → 回到继承主模型', async () => {
    await deleteSceneConfig(t.db, ctx, 'pcb_cam')
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')).model).toBe('qwen-max')
  })
})

// ★这一组是「销售助理传图当天就挂了」那件事的护栏(2026-08-21)。
// 事故形状:provider 是 deepseek(视觉默认表里没有它)→ 「图片识别」**静默拿文本主模型去看图**
// → 上游 400 → 三层之外表现成一句「图片没能读取成功」,没有任何线索指向「该去配个视觉模型」。
// 代码里两处注释(本文件与 scenes.ts)都写着「不能用文本主模型跑」,而实现最后一句是 `?? mainModel`。
describe('★非 chat 场景没有能力默认模型时,绝不借用文本主模型', () => {
  let noVisionCtx: Ctx
  beforeAll(async () => {
    noVisionCtx = (await seedTenant(t.db, '没有视觉模型的公司')).ownerCtx
    await saveProviderKey(t.db, noVisionCtx, 'deepseek', 'sk-deepseek')
    await updateConfig(t.db, noVisionCtx, { provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('★★解析 vision 直接抛「没有可用模型」,而不是回落到 deepseek-chat', async () => {
    await expect(resolveLLMRuntimeConfig(t.db, noVisionCtx, 'vision')).rejects.toThrow(/图片识别/)
    // 报错必须**能照着做**:说清去哪配。只说「失败」等于没说。
    await expect(resolveLLMRuntimeConfig(t.db, noVisionCtx, 'vision')).rejects.toThrow(/模型接入/)
  })

  it('chat 场景不受影响,照常继承主模型', async () => {
    expect((await resolveLLMRuntimeConfig(t.db, noVisionCtx, 'pcb_cam')).model).toBe('deepseek-chat')
  })

  it('显式给这个场景配了模型就能用(那是用户自己选的,我们不拦)', async () => {
    await upsertSceneConfig(t.db, noVisionCtx, { scene: 'vision', model: 'some-vision-model' })
    expect((await resolveLLMRuntimeConfig(t.db, noVisionCtx, 'vision')).model).toBe('some-vision-model')
    await deleteSceneConfig(t.db, noVisionCtx, 'vision')
  })

  it('★「模型接入」那一页不能因此打不开 —— 它正是用来发现这件事的', async () => {
    const routes = await listEffectiveRoutes(t.db, noVisionCtx)
    const vision = routes.find((r) => r.scene === 'vision')!
    expect(vision.unavailable, '用不了却不说,这一页就在骗人').toBeTruthy()
    expect(vision.model).toBe('')
    // 其余场景照常显示
    expect(routes.find((r) => r.scene === 'pcb_cam')!.unavailable).toBeUndefined()
  })
})

describe('备用模型继承', () => {
  it('主模型配了备用 → chat 场景继承主备用', async () => {
    await updateConfig(t.db, ctx, { fallbackProvider: 'deepseek', fallbackModel: 'deepseek-chat' })
    const { primary, fallback } = await resolveLLMRuntimeConfigWithFallback(t.db, ctx, 'contract_gen')
    expect(primary.model).toBe('qwen-max')
    expect(fallback?.provider).toBe('deepseek')
    expect(fallback?.model).toBe('deepseek-chat')
  })

  it('vision 场景不继承主模型的文本备用(能力不符)', async () => {
    const { fallback } = await resolveLLMRuntimeConfigWithFallback(t.db, ctx, 'vision')
    expect(fallback).toBeUndefined()
  })

  it('场景可自配备用,覆盖主备用', async () => {
    await upsertSceneConfig(t.db, ctx, { scene: 'pcb_cam', fallbackProvider: 'bailian', fallbackModel: 'qwen-plus' })
    const { fallback } = await resolveLLMRuntimeConfigWithFallback(t.db, ctx, 'pcb_cam')
    expect(fallback?.provider).toBe('bailian')
    expect(fallback?.model).toBe('qwen-plus')
    await deleteSceneConfig(t.db, ctx, 'pcb_cam')
  })

  it('清除主备用 → chat 场景无备用', async () => {
    await updateConfig(t.db, ctx, { fallbackProvider: '', fallbackModel: '' })
    const { fallback } = await resolveLLMRuntimeConfigWithFallback(t.db, ctx, 'contract_gen')
    expect(fallback).toBeUndefined()
  })
})

describe('getConfig DTO', () => {
  it('返回主模型 + 场景列表;场景覆盖后可见,不泄明文', async () => {
    await upsertSceneConfig(t.db, ctx, { scene: 'vision', model: 'qwen-turbo' })
    const cfg = await getConfig(t.db, ctx)
    expect(cfg.provider).toBe('bailian')
    expect(cfg.scenes.length).toBeGreaterThanOrEqual(2)
    const lead = cfg.scenes.find((s) => s.scene === 'vision')!
    expect(lead.model).toBe('qwen-turbo')
    const vision = cfg.scenes.find((s) => s.scene === 'vision')!
    expect(vision.capability).toBe('vision')
    expect(vision.defaultModel).toBe('qwen-vl-max') // 占位提示能力默认
    expect(JSON.stringify(cfg)).not.toContain('sk-bailian')
    await deleteSceneConfig(t.db, ctx, 'vision')
  })
})

// 深度思考开关的三态继承。真出过事:开着时销售助理 90.3s 撞穿 deadline 报「调用失败」,
// 所以「默认必须解析成 false」这条要钉死。下发行为本身见 thinking.test.ts。
describe('深度思考开关(三态继承)', () => {
  afterAll(async () => {
    await deleteSceneConfig(t.db, ctx, 'pcb_cam')
    await updateConfig(t.db, ctx, { thinkingEnabled: false })
  })

  it('全新租户默认关 —— 没人配过时解析出来必须是 false', async () => {
    const cfg = await getConfig(t.db, ctx)
    expect(cfg.thinkingEnabled).toBe(false)
    expect(cfg.scenes.every((s) => s.thinkingEnabled === null)).toBe(true) // 场景一律「继承」
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')).thinkingEnabled).toBe(false)
  })

  it('场景留空 = 跟随主模型(主模型打开,场景也跟着开)', async () => {
    await updateConfig(t.db, ctx, { thinkingEnabled: true })
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')).thinkingEnabled).toBe(true)
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'vision')).thinkingEnabled).toBe(true)
    await updateConfig(t.db, ctx, { thinkingEnabled: false })
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')).thinkingEnabled).toBe(false)
  })

  it('场景显式覆盖压过主模型(两个方向都要压得住)', async () => {
    // 主关、场景开
    await upsertSceneConfig(t.db, ctx, { scene: 'pcb_cam', thinkingEnabled: true })
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')).thinkingEnabled).toBe(true)
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'vision')).thinkingEnabled).toBe(false) // 不连累别的场景

    // 主开、场景关 —— false 必须当成「显式关」,不能被 ?? 误当成「没配」
    await updateConfig(t.db, ctx, { thinkingEnabled: true })
    await upsertSceneConfig(t.db, ctx, { scene: 'pcb_cam', thinkingEnabled: false })
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'pcb_cam')).thinkingEnabled).toBe(false)
    expect((await resolveLLMRuntimeConfig(t.db, ctx, 'vision')).thinkingEnabled).toBe(true)
    await updateConfig(t.db, ctx, { thinkingEnabled: false })
  })

  it('清成 null 即回到继承;备用模型与主选同一口径', async () => {
    await updateConfig(t.db, ctx, { thinkingEnabled: true, fallbackProvider: 'deepseek', fallbackModel: 'deepseek-chat' })
    await upsertSceneConfig(t.db, ctx, { scene: 'pcb_cam', thinkingEnabled: null })
    const { primary, fallback } = await resolveLLMRuntimeConfigWithFallback(t.db, ctx, 'pcb_cam')
    expect(primary.thinkingEnabled).toBe(true)
    expect(fallback?.thinkingEnabled).toBe(true) // 切备用不该把思考口径切掉
    await updateConfig(t.db, ctx, { thinkingEnabled: false, fallbackProvider: '', fallbackModel: '' })
  })
})
