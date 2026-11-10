// core/llm/thinking.ts
// 「深度思考」开关的下发与降级。**默认关**,可在「系统设置 → AI 大模型」按主模型/按场景打开。
//
// 为什么需要这个开关(2026-08-02 实测,doubao-seed-2-1-turbo-260628,每类 40 条实体的销售助理 prompt):
//   「拜访汇报」开思考 234.2s(思考 13834 token)/ 关思考 4.3s;「通话+改字段」104.2s / 3.0s;
//   「查公海线索」11.5s / 3.1s。答案动作完全一致,长思考反而更容易跑偏(实测有一轮把拜访汇报答成
//   单条 list_opportunities,把「必须记一条跟进」整步漏掉)。
// 方舟 doubao-seed 系列是混合推理模型,thinking 默认 auto = **开着**,而我们此前从没显式下发过 ——
// 于是每个交互式 AI 场景都在白等思维链。单次 45s 超时 + 退避重试会直接撞穿 55s deadline,
// 用户等两分钟只等到「大模型调用失败」。故默认关;确实想要推理的场景(审批预审、商机晨检)自己打开。
//
// ★为什么不按模型名开白名单:方舟允许在设置页直接填**接入点 ID**(ep-2024xxxx),名字里读不出底层
//   模型能力,白名单必漏。改成「一律下发;老模型/接入点不认这个字段回 400 就脱掉重试一次并记住」。
import OpenAI from 'openai'

// 本进程内已确认不认 thinking 字段的模型/接入点(key = `${provider}:${model}`)。
// 进程内存即可:重启后至多每个模型多花一次 400 重试,不值得落库。
const NO_THINKING = new Set<string>()
const memoKey = (provider: string, model: string) => `${provider}:${model}`

/**
 * 纯函数:该次调用要附加的「思考」参数。
 * 方舟(ark)与自营中转(sixam,上游主要就是方舟、thinking 字段原样透传)吃这个字段;
 * 其余供应商(百炼/DeepSeek/混元)原样不动 —— 它们要推理是换模型(如 deepseek-reasoner),不是靠这个开关。
 */
export function thinkingParams(provider: string, model: string, enabled: boolean): Record<string, unknown> {
  if ((provider !== 'ark' && provider !== 'sixam') || NO_THINKING.has(memoKey(provider, model))) return {}
  return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
}

/** 上游是不是在抱怨 thinking 这个字段(老模型/接入点不支持)。限定 400:429/5xx 要走退避重试,不是脱参数。 */
export function isUnsupportedThinkingError(err: unknown): boolean {
  return err instanceof OpenAI.APIError && err.status === 400 && /thinking/i.test(String(err.message))
}

/**
 * 包一次 chat 调用:带上思考参数发出去;若上游明确不认这个字段,脱掉它重试一次并记住,
 * 之后该模型不再带(不把一个可恢复的 400 甩给用户)。
 * call 收到的是要展开进请求体的额外参数(`{}` 表示不加)。
 */
export async function withThinking<T>(
  provider: string,
  model: string,
  enabled: boolean,
  call: (extra: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const extra = thinkingParams(provider, model, enabled)
  if (!('thinking' in extra)) return call(extra)
  try {
    return await call(extra)
  } catch (err) {
    if (!isUnsupportedThinkingError(err)) throw err
    NO_THINKING.add(memoKey(provider, model))
    console.info(`[llm] ${provider}/${model} 不支持 thinking 字段,已脱掉重试(本进程后续不再下发)`)
    return call({})
  }
}

/** 仅供测试:清空 / 写入「不支持 thinking」的记忆。 */
export function _resetThinkingMemoForTest(): void {
  NO_THINKING.clear()
}
export function _markNoThinkingForTest(provider: string, model: string): void {
  NO_THINKING.add(memoKey(provider, model))
}
