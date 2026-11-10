// 出口注册器接进 core/llm 之后,**调用真的改道了吗**。
//
// ★上一层(modules/ai-gateway/tests/llm-transport.test.ts)验的是「出口算得对」;
//   这一层验的是「算出来的出口真的被用上了」。两者少任何一条,都可能出现
//   「配置看着对、实际还在直连」—— 而那不会报错,只会让成本和配额悄悄漏掉一半流量。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeResilientCaller } from '../caller'
import { registerLLMTransport } from '../transport'

const captured: { url?: string; key?: string; model?: string; body?: Record<string, unknown> }[] = []

/** 让某个模型名在网关上"没配路由"(测回退用)。抛的是 tb 的真实报文形状。 */
const unconfigured = new Set<string>()

// ★mock 必须带 APIError:错误分类走的是 `err instanceof OpenAI.APIError`,
//   mock 里少了它,分类那句会抛「Right-hand side of 'instanceof' is not an object」——
//   于是任何走错误路径的用例都在测一个假的失败原因。
// ★用 vi.hoisted 定义:vi.mock 的工厂会被提升到文件最前,直接引用下面声明的 class 会
//   「Cannot access before initialization」。
// models:**每次 create 调用**发的模型名。★不能用 captured 代替 —— 它一次 client 构造一条,
//   而回退是同一个 client 上再发一次,后一次会把前一次的 model 就地覆盖掉(第一版就这么误判了)。
const { MockAPIError, models } = vi.hoisted(() => ({
  models: [] as string[],
  MockAPIError: class extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

vi.mock('openai', () => ({
  APIError: MockAPIError,
  // ★挂成 default 的**静态属性**:分类那句读的是 `OpenAI.APIError`(默认导出上的静态),
  //   只导出同名的具名导出没用 —— 那样 instanceof 右边还是 undefined。
  default: class {
    static APIError = MockAPIError
    chat = {
      completions: {
        create: async (body: Record<string, unknown>) => {
          captured[captured.length - 1]!.model = body.model as string
          captured[captured.length - 1]!.body = body
          models.push(body.model as string)
          if (unconfigured.has(body.model as string)) {
            // tb 的原话(2026-08-16 线上);status 400 由 classifyLLMError 读
            throw new MockAPIError(400, `400 provider or model not configured for request model '${body.model}'`)
          }
          return { choices: [{ message: { content: 'ok' } }], usage: {} }
        },
      },
    }
    constructor(opts: { baseURL?: string; apiKey?: string }) {
      captured.push({ url: opts.baseURL, key: opts.apiKey })
    }
  },
}))

afterEach(() => {
  captured.length = 0
  models.length = 0
  unconfigured.clear()
  registerLLMTransport(null)
})

const GW = { baseURL: 'http://tb.test/openai/team/v1', apiKey: 'tb-share-x', model: 'aios-pcb_cam' }

describe('★网关模式:出口整体改道', () => {
  it('baseURL / key / model 三样全换成网关的', async () => {
    const caller = makeResilientCaller({
      providerId: 'bailian',
      model: 'qwen-plus',
      apiKey: '本地的-key',
      transport: GW,
    })
    await caller([{ role: 'user', content: 'hi' }])

    expect(captured[0]!.url, '还在打 provider 的地址 = 根本没走网关').toBe(GW.baseURL)
    expect(captured[0]!.key, '还在用本地 provider key = 网关那边收不到、也计不了量').toBe(GW.apiKey)
    expect(captured[0]!.model, '发的还是真模型名 —— 网关按 request_model 路由和出账,发错就全乱').toBe('aios-pcb_cam')
  })

  it('★不做 provider 专属塑形 —— 走网关时并不知道真实上游是谁', async () => {
    // 按本地配置(这里是百炼)塑形,会把百炼的数组格式发给一个可能是方舟/OpenAI 的上游。
    // R6 时期端到端实测过:不处理的话 system.content 会以数组形式发出去,被拒收或误解析。
    const caller = makeResilientCaller({ providerId: 'bailian', model: 'qwen-plus', apiKey: 'k', transport: GW })
    await caller([{ role: 'system', content: '系统提示' }])
    const msgs = captured[0]!.body!.messages as { role: string; content: unknown }[]
    expect(typeof msgs[0]!.content, '走网关还按百炼塑形了').toBe('string')
  })

  it('★网关模式忽略备用槽 —— 一个场景就是网关上一条路由', async () => {
    // 再切一次只是把同一条路由打两遍:既没换模型,还让失败原因更难读。备用该由网关侧做。
    const caller = makeResilientCaller(
      { providerId: 'bailian', model: 'qwen-plus', apiKey: 'k', transport: GW },
      { providerId: 'ark', model: 'doubao', apiKey: 'k2' },
    )
    await caller([{ role: 'user', content: 'hi' }])
    expect(captured, '网关模式下还建了备用 client').toHaveLength(1)
  })
})

describe('★场景没配路由 → 回退主模型那条(不然「未选即继承」在网关模式下是假的)', () => {
  // 2026-08-16 线上:新加的日程场景没在网关上配路由,tb 回
  // 「400 provider or model not configured for request model 'aios-pcb_cam_alt'」——
  // 于是**每加一个场景,那个功能在网关部署上当场挂掉**,而报文业务侧完全看不懂。
  // scenes.ts 一直写着「未单独配置的场景继承主模型」,那句话原来只在直连时成立。
  const HINT = 'AI 网关上还没有「日程助手」的路由,主模型那条(兜底用的)也没配。去「系统管理 → AI 网关 → 场景路由」配上主模型就能用了。'
  const GW_NEW = { ...GW, model: 'aios-pcb_cam_alt', fallbackModel: 'aios-default', unconfiguredHint: HINT }

  it('没配的场景自动改用 fallbackModel 再试一次,调用照常成功', async () => {
    unconfigured.add('aios-pcb_cam_alt')
    const caller = makeResilientCaller({ providerId: 'bailian', model: 'qwen-plus', apiKey: 'k', transport: GW_NEW })
    const r = await caller([{ role: 'user', content: 'hi' }])
    expect(r.reply, '回退没生效 —— 这个场景在网关部署上就是不能用').toBe('ok')
    expect(models, '发出去的两次分别是:原场景 → 主模型那条').toEqual(['aios-pcb_cam_alt', 'aios-default'])
  })

  it('★回退只做一次:回退目标也没配就原样报错(不许套娃)', async () => {
    const caller = makeResilientCaller({ providerId: 'bailian', model: 'qwen-plus', apiKey: 'k', transport: GW_NEW })
    // 回退目标同样没配 → 第二次失败必须原样抛出,不再兜底(否则会无限套娃)
    unconfigured.add('aios-pcb_cam_alt')
    unconfigured.add('aios-default')
    await expect(caller([{ role: 'user', content: 'hi' }])).rejects.toThrow(/AI 网关/)
    expect(models, '回退不该无限重试').toHaveLength(2)
  })

  it('★两条都没配时说的是**人话**,不是网关那句英文报文', async () => {
    // 真实反馈(2026-08-16):用户看到「400 provider or model not configured for request model
    // 'aios-default'」问「400 是大模型没余额了吗」—— 不是余额、不是模型坏了,是配置没做,
    // 而报文一个字都没说该去哪配。
    unconfigured.add('aios-pcb_cam_alt')
    unconfigured.add('aios-default')
    const caller = makeResilientCaller({ providerId: 'bailian', model: 'qwen-plus', apiKey: 'k', transport: GW_NEW })
    await expect(caller([{ role: 'user', content: 'hi' }])).rejects.toThrow(HINT)
    // 反面:网关原文不该出现在给用户的话里
    await expect(caller([{ role: 'user', content: 'hi' }])).rejects.not.toThrow(/provider or model not configured/)
  })

  it('没给 fallbackModel(主模型场景本身)→ 不自己瞎试,同样说人话', async () => {
    unconfigured.add('aios-default')
    const caller = makeResilientCaller({
      providerId: 'bailian', model: 'qwen-plus', apiKey: 'k',
      transport: { ...GW, model: 'aios-default', unconfiguredHint: '去 AI 网关配主模型路由' },
    })
    await expect(caller([{ role: 'user', content: 'hi' }])).rejects.toThrow(/AI 网关/)
    expect(models, '没有回退目标就不该有第二次调用').toHaveLength(1)
  })
})

describe('直连模式不受影响', () => {
  it('没有 transport 时照旧打 provider 的地址、用本地 key、发真模型名', async () => {
    const caller = makeResilientCaller({ providerId: 'bailian', model: 'qwen-plus', apiKey: '本地的-key' })
    await caller([{ role: 'user', content: 'hi' }])
    expect(captured[0]!.url).toContain('dashscope')
    expect(captured[0]!.key).toBe('本地的-key')
    expect(captured[0]!.model).toBe('qwen-plus')
  })

  it('直连时百炼的塑形还在 —— 这是它省钱的方式,别一起删了', async () => {
    const caller = makeResilientCaller({ providerId: 'bailian', model: 'qwen-plus', apiKey: 'k' })
    await caller([{ role: 'system', content: '系统提示' }])
    const msgs = captured[0]!.body!.messages as { role: string; content: unknown }[]
    expect(Array.isArray(msgs[0]!.content), '直连百炼的显式缓存塑形被误删了').toBe(true)
  })
})
