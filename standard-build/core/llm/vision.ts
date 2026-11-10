// core/llm/vision.ts
// **把一张图识别成文字**。放在 core 而不是某个模块里,是因为它整个身子都是基建:
// 场景解析(vision)、备用模型回退、削峰闸门、thinking 兼容 —— 全在 core/llm 里,
// 业务侧只贡献一句提示词。
//
// ★为什么值得有这个函数:很多出口的文本模型收不了图片。实测江南那台自托管用的
//   eazytec 网关,`deepseek-v4-flash/pro` 连 `image_url` 这个结构都不认(上游 API
//   直接反序列化失败),`glm-5.2` / `MiniMax-M2.7` 回「is not a multimodal model」。
//   而同一个网关上 `qwen3.8-27b` 与 `kimi-k3` 能看图(对照实验:换一张图,答案跟着变)。
//   于是「主模型不动、图片旁路转录成文字再喂进去」成了最省事的一条路 ——
//   代价是转录漏掉的细节没法回头追问,好处是主模型的工具调用一点没动。
import OpenAI from 'openai'
import type { Ctx, Db } from '../db/client'
import { resolveLLMRuntimeConfigWithFallback } from './config'
import { runWithLLMFallback } from './caller'
import { LlmError } from './errors'
import { classifyLLMError, isModelNotConfigured, llmRequest } from './throttle'
import { withThinking } from './thinking'

/**
 * 识别输出的上限。**必须显式给**,不能吃服务端默认值 ——
 * 实测江南那个网关的默认值是 1500,而 `qwen3.8-27b` 是思考模型:
 * 1500 全烧在思考链里,`content` 空着回来、`finish_reason=length`。
 * 于是「识别失败」表现成「这张图没内容」,查起来完全指不到原因。
 *
 * 4000 足够一整页密排中文(实测一张七字段送货单只用了 354)。
 */
const MAX_OUTPUT_TOKENS = 4000

/**
 * 用租户配的**视觉**模型(`vision` 场景)把图片读成文本。
 *
 * `imageUrl` 收 data URL 或公网 URL。`prompt` 由调用方给 —— 入知识库和看聊天附件
 * 想要的东西不一样(前者要完整结构化,后者要能答用户的问题)。
 *
 * ★不吞异常:调用方必须自己决定失败了怎么办。对话场景里「转录失败」和「转录出空」
 *   都必须**如实告诉用户**,绝不能当成图里没内容。
 *
 * ★返回 `truncated` 而不是光给字符串:识别到一半被 max_tokens 砍断时,
 *   拿到的是**半截转录稿**。不往外说的话,下游会把半张单据当成整张 ——
 *   这是这个仓里反复出过事的那类静默截断。
 */
export async function describeImage(
  db: Db, ctx: Ctx, imageUrl: string, prompt: string,
): Promise<{ text: string; truncated: boolean }> {
  const configs = await resolveLLMRuntimeConfigWithFallback(db, ctx, 'vision')
  return runWithLLMFallback(configs, async (cfg) => {
    // 45s 超时:批量识别会连打多次(原先无超时 = SDK 默认 10 分钟,是个隐患)。
    // 过 throttle.llmRequest:火山走削峰闸门(并发 + 最小间隔),429/5xx/超时按退避重试。
    // defaultHeaders 是网关模式带的(X-Workspace-ID / X-Scene),直连时为空。
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 45_000, maxRetries: 0 })
    /**
     * 上游报错 → **人话**。★这一层原来没有:抛出去的是 OpenAI SDK 的原始异常,
     * 一路被 transcribeImages 吞掉,用户只看到「图片没能读取成功」。
     * 三种最常见的原因各自说清:
     *   ① 网关上没配这个场景的路由(unconfiguredHint 由 ai-gateway 撰写,指到具体页面);
     *   ② 直连时模型压根不是多模态(上游回 400/「not a multimodal model」);
     *   ③ 其余(限流/超时/鉴权)照原样分类,备用模型机制还要靠它判断可否重试。
     */
    const explain = (err: unknown): never => {
      const { status, retryable } = classifyLLMError(err)
      if (isModelNotConfigured(err) && cfg.unconfiguredHint) {
        throw new LlmError('LLM_NOT_CONFIGURED', cfg.unconfiguredHint, { status, retryable: false })
      }
      const raw = err instanceof Error ? err.message : String(err)
      // 「这个模型看不了图」是最常见的一种,单独给一句能照着做的话。
      // ★**走网关时必须指到另一页**(2026-08-21 线上教训):网关模式下这次发出去的是虚拟模型名
      //   `aios-vision`,真正用哪个模型由网关的场景路由决定 —— 「模型接入」页上那一行**对它不生效**。
      //   而那一页照样显示着本地配置,看上去像已经配好了。上一版这句话把人指到了「模型接入」,
      //   用户照着把它改成了能看图的模型,**再试还是同样的错** —— 因为改的根本不是生效的那处。
      if (status === 400 || status === 404) {
        throw new LlmError(
          'LLM_NOT_CONFIGURED',
          cfg.viaGateway
            ? `图片识别这次是**走 AI 网关**发出去的(虚拟模型名 ${cfg.model}),真正用哪个模型由网关决定,`
              + `「系统管理 → 模型接入」上的设置对它不生效。请到「系统管理 → AI 网关 → 场景路由」,`
              + `把「图片识别」那一行配成一个能看图的模型。上游原话:${raw}`
            : `图片识别用的模型(${cfg.model})没能读这张图,多半是它不支持看图或没开通:`
              + `请到「系统管理 → 模型接入」把「图片识别」换成一个多模态模型。上游原话:${raw}`,
          { status, retryable: false },
        )
      }
      throw new LlmError('LLM_ERROR', `图片识别调用失败:${raw}`, { status, retryable })
    }
    // withThinking:按 vision 场景的开关下发 thinking(默认关 —— 图片转文字是抽取活,
    // 思考链只加延迟;老接入点不认这个字段则脱掉重试一次,见 core/llm/thinking.ts)。
    const res = await llmRequest({ provider: cfg.provider, apiKey: cfg.apiKey }, () =>
      withThinking(cfg.provider, cfg.model, cfg.thinkingEnabled, (extra) =>
        client.chat.completions.create({
          model: cfg.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          ...extra,
        }),
      ),
    ).catch(explain)
    const choice = res.choices[0]
    return {
      text: (choice?.message?.content ?? '').trim(),
      // 只认 'length'。别的停止原因(stop / tool_calls / 空)都不是截断,
      // 一律当成截断会让每张图都挂上一句「可能不全」,那句话就没人看了。
      truncated: choice?.finish_reason === 'length',
    }
  })
}
