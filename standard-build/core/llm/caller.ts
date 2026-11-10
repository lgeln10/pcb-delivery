// core/llm/caller.ts
// 平台 OpenAI 兼容 LLM 调用(百炼/方舟/DeepSeek)。调用做成可注入函数(LLMCaller),测试用假实现不真调 API。
// ★需求收集那三个工具(confirm_requirement / read_attachment_full / load_module_knowledge)
//   **默认不挂,要用的显式开**(`requirementTools: true`)。
//
//   2026-08-19 之前是反过来的:默认挂给每一个走 buildTenantLLMCaller 的调用点,
//   靠一个 `noTools` 开关让新调用点自己躲。注释里写的是「对不触发它们的场景无副作用」——
//   **那句话是错的**,实测有两笔代价:
//   ① 每次调用白付一份工具 schema 的输入 token(合同生成、线索打分、邮件抽取都在付);
//   ② 它和「只吐一个 JSON 动作」的协议**直接打架** —— 同一句话同一个模型,带着这套工具时
//      5 次里有 2 次改去调 confirm_requirement,动作 JSON 就没了;压测里 39% 的轮次要重问一次。
//   只有需求助手那条链路(feedback / 调试台 / IM 的 requirement handler)真的消费它们的结果。
import OpenAI from 'openai'
import { activeProvider, LLM_PROVIDERS, resolveApiKey, resolveModel, type LLMProviderId } from './providers'
import { LlmError } from './errors'
import { classifyLLMError, isModelNotConfigured, isRetryableLLMError, llmRequest } from './throttle'
import { withThinking } from './thinking'
import type { LLMTransport } from './transport'

// 错误分类沉到 throttle.ts(退避重试与备用模型机制共用同一判定),此处再导出保持既有引用面不变(api.ts / 测试)。
export { classifyLLMError, isRetryableLLMError }

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type ConfirmTool = { title: string; summary: string; sourceModule?: string }
export type ReadFullTool = { name: string }
export type LoadModuleTool = { moduleKey: string }
/** 一次调用的 token 用量(用于「用量」页;供应商都在 usage 字段回报)。 */
export type LLMUsage = { promptTokens: number; completionTokens: number; cachedTokens: number }
export type LLMResult = { reply: string; confirm?: ConfirmTool; readFull?: ReadFullTool; loadModule?: LoadModuleTool; usage?: LLMUsage }
/** 注入点:给定消息(已含 system),返回助手回复或 confirm/readFull 工具结果 */
export type LLMCaller = (messages: ChatMessage[]) => Promise<LLMResult>

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'confirm_requirement',
      // ★「用户确认后……才调用」这句(原措辞)是用户实测里最常抱怨的那个多余环节的来源:
      //   模型会先把整段 summary 当正文写出来问「这样可以吗」,用户答「对」,再多花一次往返才出卡。
      //   而 UI 上这个工具的结果**就是**一张带「确认提交」按钮的卡片 —— 确认环节本来就在卡片上。
      //   这段描述必须和 instructions.ts 的收尾规则同口径:提示词正文可被租户在「智能体管理」里
      //   整体替换,而这份 schema 永远来自代码 —— 所以它是这条规则唯一到得了所有租户的落点。
      description:
        '需求澄清清楚后**立即**调用,提交结构化需求。调用后系统会给用户弹出一张带完整正文和「确认提交」按钮的卡片,' +
        '用户点了才真正入库 —— 所以不要先在对话里写一遍总结、问「这样可以吗」、等用户点头再调,那会让用户确认两遍。' +
        '纯样式/文案类小改动通常第一轮就该调用(按最小范围理解,边界写进「不含」);' +
        '用户已表态同意或催促定稿时,本轮必须调用,不要再开新的澄清问题。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '简短标题(只含一个需求;多个诉求要拆成多条分别 confirm)' },
          summary: { type: 'string', description: '结构化需求:问题/动机 + 预期行为 + 范围约束;若是对既有功能的调整,开头写明现状与差异;末尾附「验收:…」「不含:…」两行' },
          sourceModule: { type: 'string', description: '需求所属模块 key(优先用系统提示给出的当前页面模块;确属其它模块才改),不确定可省略' },
        },
        required: ['title', 'summary'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_attachment_full',
      description:
        '当你看了某个上传附件的「概览」后判断需要它的完整内容(例如要看 Excel 全部数据、文本全文)才调用;' +
        '只有 Excel 和纯文本可深读,图片/PDF/Word 无法读取全文。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要深读的附件文件名(与概览里给出的文件名一致)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'load_module_knowledge',
      description:
        '(需求收集场景)system 提示里的「系统模块索引」只有一行标签;当你判断用户的需求可能属于索引里的某个模块、' +
        '需要看该模块的完整能力说明才能判断「已支持/实现差异/新需求」时调用。已在上下文里给出完整说明的模块不要重复请求。',
      parameters: {
        type: 'object',
        properties: {
          moduleKey: { type: 'string', description: '模块 key(与「系统模块索引」列表中的 key 一致,如 finance / lead)' },
        },
        required: ['moduleKey'],
      },
    },
  },
]

/**
 * 工具名清单(从 TOOLS 派生,不手写第二份)。
 * 用途:提示词正文里会点名这些工具,而正文可能被平台 Agent Registry 覆盖 —— 护栏测试
 * 拿这份清单核对内置正文没写错名字。派生而非手写,才不会自己先漂移。
 */
export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.function.name)


/** 默认实现:按 env 选 provider;未配 key 则调用时报清晰错误(不在启动期炸) */
/**
 * 需求助手那条链路的默认 caller。**这是唯一默认带需求工具的入口** ——
 * 它只被 `feedback` 的 chatTurn 当默认值用。
 */
export function defaultLLMCaller(): LLMCaller {
  return makeLLMCaller(activeProvider().id, '', undefined, false, true)
}

// 整段重试的墙钟预算(排队削峰 + 各次尝试 + 退避)。主选→备用共享同一 deadline,不叠加。
// ★2026-08-28 由 55s 提到 110s,**同时**把 deploy_production.sh 生成的 nginx
//   `proxy_read_timeout` 从 60s 提到 120s —— 这两个数字是一对,只改一个等于把失败
//   从「大模型超时」挪成「网关 504」,而后者连错误信息都读不出是什么。
//   起因:线上一次需求助手调用 37.5s,离当时 45s 的单次超时只差 7.5s;而商机晨检
//   已经越线了(90.3s = 主选 45s 超时 + 兜底 45s 超时)。真实成功调用最慢见过 66.5s。
/** 单次尝试的上限。真实超时还要按剩余预算收窄 —— 见 attemptTimeoutMs。 */
export const ATTEMPT_TIMEOUT_MS = 90_000

/**
 * 这一次尝试实际能用多久:**剩余预算与单次上限取小**。
 *
 * ★2026-08-28 实测到的缺陷:`timeout` 原来是写死的常量,`deadline` 只用来算退避,
 *   从没参与过超时计算。于是「主选超时 → 切备用再超时」是**相加**的,
 *   而不是文件头注释里承诺的「共享同一 deadline,不叠加」。
 *   生产实证:商机晨检 2026-08-25/26/27 连续三天失败,latency 90287 / 90395 / 90366 ms
 *   —— 当时单次超时 45s、TOTAL_BUDGET_MS 55s,90.3s 正好是 45+45,预算一点没兜住。
 *   同日把单次超时抬到 90s 之后,同一形状会变成最多 180s,而 nginx proxy_read_timeout 是 120s:
 *   网关先返 504,而进程还在那儿等 —— 用户看到的错误与服务端记的原因从此对不上。
 * ★下限 5s:预算已经见底时与其发一个必然超时的请求,不如让它快速失败。
 */
export function attemptTimeoutMs(deadline: number, now = Date.now()): number {
  return Math.max(5_000, Math.min(ATTEMPT_TIMEOUT_MS, deadline - now))
}

const TOTAL_BUDGET_MS = 110_000

export type LLMSlot = {
  providerId: string
  model: string
  apiKey?: string
  thinkingEnabled?: boolean
  transport?: LLMTransport
  /**
   * 给模型挂上需求收集那三个工具(confirm_requirement / read_attachment_full /
   * load_module_knowledge)。**默认不挂。**
   *
   * ★只有需求助手那条链路该开:`feedback` 的收集流程、智能体管理的调试台、
   *   以及 IM 的 requirement handler —— 它们是仅有的消费 `confirm`/`readFull`/`loadModule` 的地方。
   * ★2026-08-19 之前默认是**开**的,靠 `noTools` 让别人躲。两笔实测代价见文件头。
   */
  requirementTools?: boolean
  /** 单次回复的输出上限(`max_tokens`)。不传 = 不下发。取值与理由见 core/llm/scenes.ts 的 maxOutputTokens。 */
  maxOutputTokens?: number
}
/**
 * 带备用模型的 caller:先跑主选,主选抛「可重试」错误(429/5xx/超时)或「未配置」时自动切备用再试一次;
 * 确定性错误(400 等)直接抛,不浪费备用。无备用则退化为普通 caller。
 * ★主选与备用共享同一 deadline:退避重试(见 throttle.llmRequest)可能已在主选上耗掉预算,
 *   切备用时把同一 deadline 传下去,避免「主选 55s + 备用 55s」叠加超过网关超时。
 */
export function makeResilientCaller(primary: LLMSlot, fallback?: LLMSlot): LLMCaller {
  const primaryRun = makeChatRun(primary.providerId, primary.model, primary)
  // ★网关模式下忽略备用槽:一个场景 = 网关上一条路由,备用是网关侧的事。
  //   base 再切一次只是把同一条路由打两遍 —— 既没换模型,还让失败原因更难读。
  if (!fallback || primary.transport) return (messages) => primaryRun(messages, Date.now() + TOTAL_BUDGET_MS)
  const fallbackRun = makeChatRun(fallback.providerId, fallback.model, { ...fallback, transport: undefined })
  return async (messages) => {
    const deadline = Date.now() + TOTAL_BUDGET_MS
    try {
      return await primaryRun(messages, deadline)
    } catch (err) {
      if (err instanceof LlmError && (err.retryable || err.code === 'LLM_NOT_CONFIGURED')) return await fallbackRun(messages, deadline)
      throw err
    }
  }
}

/**
 * 自建 OpenAI 调用的模块(销售助理 / 图片识别 / 向量化,需自定义工具/流式/embeddings)用的兜底助手:
 * 先用 primary 跑 run(),抛可重试错误且有 fallback 时用 fallback 再跑一次。retryable 判定同上。
 * 泛型不绑定具体配置类型,避免与 config.ts 的循环依赖。
 */
export async function runWithLLMFallback<C, T>(configs: { primary: C; fallback?: C }, run: (cfg: C) => Promise<T>): Promise<T> {
  try {
    return await run(configs.primary)
  } catch (err) {
    if (configs.fallback && isRetryableLLMError(err)) return await run(configs.fallback)
    throw err
  }
}

/** 带 deadline 的一次会话调用(供 makeLLMCaller / makeResilientCaller 共用,以便主选→备用共享同一 deadline)。 */
type ChatRun = (messages: ChatMessage[], deadline: number) => Promise<LLMResult>

/**
 * 按 providerId + model 构造 caller;model 为空则用 provider 默认值。
 * apiKey 可显式传入(来自库内加密配置);不传则回退 env。deadline 自身分配(独立调用无需共享)。
 */
export function makeLLMCaller(providerId: string, model: string, apiKey?: string, thinkingEnabled = false, requirementTools = false): LLMCaller {
  const run = makeChatRun(providerId, model, { apiKey, thinkingEnabled, requirementTools })
  return (messages) => run(messages, Date.now() + TOTAL_BUDGET_MS)
}

// thinkingEnabled 默认 false:调用方(buildTenantLLMCaller)按租户配置传入;直接构造 caller 的
// 老调用点不传即维持「关」——这正是我们要的默认(见 core/llm/thinking.ts 的实测数据)。
type ChatRunOpts = {
  apiKey?: string
  thinkingEnabled?: boolean
  transport?: LLMTransport
  requirementTools?: boolean
  maxOutputTokens?: number
}

function makeChatRun(providerId: string, model: string, o: ChatRunOpts = {}): ChatRun {
  const { apiKey, thinkingEnabled = false, transport, requirementTools = false, maxOutputTokens } = o
  const provider = LLM_PROVIDERS[providerId as LLMProviderId] ?? activeProvider()
  // 网关模式:凭据是网关的推理令牌,provider key 本就不该出现在这条路上
  const key = transport ? transport.apiKey : (apiKey ?? resolveApiKey(provider))
  if (!key) {
    return async () => {
      throw new LlmError('LLM_NOT_CONFIGURED', `未配置 ${provider.label} 的 API Key(可在系统设置页填写,或设环境变量 ${provider.apiKeyEnv})`)
    }
  }
  // ★底座 bug:未设 timeout 时 OpenAI SDK 默认 10 分钟 + maxRetries=2,一次慢调用可挂 20–30 分钟,远超任何网关
  //   proxy_read_timeout(nginx,发版脚本现在生成 120s)→ 网关先返 504。故单次尝试自己封顶(不用 SDK 自带
  //   重试,重试改由 throttle.llmRequest 统一做:退避 + jitter + 优先 Retry-After,并受本次 deadline 约束)。
  // ★2026-08-28 由 45s 提到 90s:实测生成速度 11~17 ms/token,45s 只够写 2600~4000 token,
  //   而销售助理真实见过 5153 token 的一次回复、审批预审见过 66.5s 的一次成功 —— 45s 是**在砍正常调用**。
  //   与 TOTAL_BUDGET_MS(110s)、nginx proxy_read_timeout(120s)是同一套数,改一个必须三个一起改。
  const client = new OpenAI({
    apiKey: key,
    baseURL: transport ? transport.baseURL : provider.baseURL,
    // 这里只是**兜底上限**;每次调用的真实超时由下面按剩余预算收窄(见 attemptTimeoutMs)。
    timeout: ATTEMPT_TIMEOUT_MS,
    maxRetries: 0,
  })
  // 网关模式下发的是**虚拟模型名**(aios-<scene>),真模型由网关的路由决定
  const resolvedModel = transport ? transport.model : model || resolveModel(provider)
  return async (messages, deadline) => {
    // 百炼支持显式缓存:system 段(方法论+模块索引,逐轮字节稳定)标 cache_control 确定性命中。
    // 方舟/DeepSeek/混元走各自的自动前缀缓存,零配置;消息保持原样即可。
    //
    // ★这段塑形只在**直连**时成立:它按本地配置认定上游是百炼。将来若把调用改成走统一网关
    //   (那时 base 并不知道真实 provider 是谁),必须把塑形挪到网关侧 ——
    //   否则会把百炼的数组格式发给一个可能是方舟/OpenAI 的上游。R6 时期端到端实测过:
    //   不处理的话 system.content 会以数组形式发出去,被拒收或误解析。
    // ★网关模式下**不做 provider 专属塑形**:此时并不知道真实上游是谁(那正是网关的意义),
    //   按本地配置塑形会把百炼的数组格式发给一个可能是方舟/OpenAI 的上游,被拒收或误解析。
    //   塑形该在网关侧做 —— 那里才知道 provider。R6 时期端到端实测过这个坑。
    const payload =
      !transport && provider.id === 'bailian'
        ? messages.map((m) =>
            m.role === 'system'
              ? ({ role: 'system', content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } as unknown as ChatMessage)
              : m,
          )
        : messages
    // ★火山(ark)在此过削峰闸门(并发 + 最小间隔),把突发压平;命中 429/5xx/超时按退避重试(见 throttle)。
    // withThinking:按本场景开关下发 thinking(默认关);老接入点不认这个字段则脱掉重试一次(见 thinking.ts)。
    const send = (model: string) =>
      llmRequest(
        { provider: provider.id, apiKey: key },
        () =>
          withThinking(provider.id, model, thinkingEnabled, (extra) =>
            client.chat.completions.create(
              {
                model,
                messages: payload,
                ...(requirementTools ? { tools: TOOLS } : {}),
                ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
                ...extra,
              },
              // ★按剩余预算收窄这一次的超时 —— 客户端上的常量 timeout 只是兜底上限。
              //   不这么做的话「主选超时 → 备用再超时」是相加的,见 attemptTimeoutMs 的注释。
              { timeout: attemptTimeoutMs(deadline) },
            ),
          ),
        { deadline },
      )
    let res
    try {
      res = await send(resolvedModel)
    } catch (err) {
      // 网关不认这个虚拟模型名(= 这个场景在网关上没配路由)→ 改用主模型那条再试一次。
      // ★这才让 scenes.ts 那句「未单独配置的场景继承主模型」在**网关模式下**也成立。
      //   在此之前它只在直连时成立,于是每加一个场景,那个功能在网关部署上当场 400 ——
      //   2026-08-16 线上就是这么挂的(日程助手报 `provider or model not configured for
      //   request model 'aios-calendar_assistant'`,用户完全看不懂那是什么意思)。
      // ★只回退这一种错:超时、限流、鉴权都照旧抛出去,不能借着「回退」把真问题吞掉。
      if (transport?.fallbackModel && isModelNotConfigured(err)) {
        console.warn(
          `[llm] 网关没有 ${resolvedModel} 的路由,本次改用 ${transport.fallbackModel}。`
            + `要让这个场景走自己的模型,去 AI 网关加一条路由规则。`,
        )
        try {
          res = await send(transport.fallbackModel)
        } catch (err2) {
          // 兜底那条也没配 = 这个租户在网关上一条路由都没有。**别把网关原文丢给用户** ——
          // 「400 provider or model not configured」会被当成余额/模型故障(真实反馈:
          // 「400 是大模型没余额了吗」)。说清是配置没做,并指到页面。
          const { status, retryable } = classifyLLMError(err2)
          if (isModelNotConfigured(err2) && transport.unconfiguredHint) {
            throw new LlmError('LLM_NOT_CONFIGURED', transport.unconfiguredHint, { status, retryable: false })
          }
          throw new LlmError('LLM_ERROR', `LLM 调用失败:${(err2 as Error).message}`, { status, retryable })
        }
      } else {
        // 把上游错误分类(状态码 + 是否可重试),供备用模型机制判断要不要切兜底(见 makeResilientCaller)。
        const { status, retryable } = classifyLLMError(err)
        // 没有兜底目标(主模型场景自己)却又没配路由 —— 同样是配置问题,同样说人话
        if (isModelNotConfigured(err) && transport?.unconfiguredHint) {
          throw new LlmError('LLM_NOT_CONFIGURED', transport.unconfiguredHint, { status, retryable: false })
        }
        throw new LlmError('LLM_ERROR', `LLM 调用失败:${(err as Error).message}`, { status, retryable })
      }
    }
    // 缓存命中观测(百炼/方舟/DeepSeek 均在此字段回报):用于验证前缀缓存策略是否生效。
    const cached = (res.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens
    if (cached && cached > 0) console.info(`[llm] ${provider.id}/${resolvedModel} prompt_cache 命中 ${cached} tokens(输入共 ${res.usage?.prompt_tokens ?? '?'})`)
    // 每条返回路径都带上 usage —— 漏一条就会让那类调用在用量页永久隐身
    const usage: LLMUsage = {
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      cachedTokens: cached ?? 0,
    }
    // ★撞上 max_tokens 的那一次必须看得见。这是加输出上限**唯一**新增的坏情况:
    //   截在工具参数中间时,下面那个 JSON.parse 一定失败,而原来的兜底是「当普通回复」——
    //   用户会拿到半句话、没有卡、也没有任何解释,还以为是模型答歪了。
    //   所以:截断时不走那条静默兜底,明说一句;纯文本被截断则在正文末尾标出来。
    const truncated = res.choices[0]?.finish_reason === 'length'
    if (truncated) {
      console.warn(
        `[llm] ${provider.id}/${resolvedModel} 输出撞上上限 ${maxOutputTokens ?? '(未设)'} 被截断`
          + `(出参 ${usage.completionTokens})。若这不是长尾而是常态,去 core/llm/scenes.ts 把该场景的 maxOutputTokens 调大。`,
      )
    }
    const msg = res.choices[0]?.message
    const calls = msg?.tool_calls ?? []
    const confirmCall = calls.find((t) => t.type === 'function' && t.function.name === 'confirm_requirement')
    if (confirmCall && confirmCall.type === 'function') {
      try {
        const args = JSON.parse(confirmCall.function.arguments) as ConfirmTool
        return { reply: msg?.content ?? '我已整理好这条需求,请确认提交。', confirm: args, usage }
      } catch {
        // 截断导致的解析失败要说清楚 —— 用户能据此把需求拆小重说,而不是对着半句话发呆。
        if (truncated) {
          throw new LlmError('LLM_ERROR', '这次回答太长,被输出上限截断了,需求卡没能生成完整。把需求拆成更小的一条重说一次通常就好了。', { retryable: false })
        }
        /* 工具参数解析失败 → 当普通回复 */
      }
    }
    const readCall = calls.find((t) => t.type === 'function' && t.function.name === 'read_attachment_full')
    if (readCall && readCall.type === 'function') {
      try {
        const args = JSON.parse(readCall.function.arguments) as ReadFullTool
        if (args.name) return { reply: msg?.content ?? '', readFull: args, usage }
      } catch {
        /* 工具参数解析失败 → 当普通回复 */
      }
    }
    const loadCall = calls.find((t) => t.type === 'function' && t.function.name === 'load_module_knowledge')
    if (loadCall && loadCall.type === 'function') {
      try {
        const args = JSON.parse(loadCall.function.arguments) as LoadModuleTool
        if (args.moduleKey) return { reply: msg?.content ?? '', loadModule: args, usage }
      } catch {
        /* 工具参数解析失败 → 当普通回复 */
      }
    }
    // 纯文本被截断:把话说在正文里。半句话本身不会告诉用户它是半句话。
    const reply = msg?.content ?? ''
    return { reply: truncated && reply ? `${reply}\n\n(回答太长,已截断)` : reply, usage }
  }
}
