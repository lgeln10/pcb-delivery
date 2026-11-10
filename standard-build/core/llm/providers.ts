// core/llm/providers.ts
// 平台级 LLM 供应商注册表(OpenAI 兼容)。百炼/方舟/DeepSeek 都用 OpenAI 协议,换 baseURL/model/key 即可。
// ★密钥红线:env key 不进库不进代码。provider 默认由 env LLM_PROVIDER 选(兼容旧 FEEDBACK_LLM_PROVIDER)。
// 模型 code 用户可在「系统设置 → AI 大模型」里直接输入(如 deepseek-reasoner / qwen-max / 方舟接入点)。
export type LLMProviderId = 'sixam' | 'bailian' | 'ark' | 'deepseek' | 'hunyuan'
export type LLMProvider = {
  id: LLMProviderId
  label: string
  baseURL: string
  defaultModel: string
  apiKeyEnv: string
}

export const LLM_PROVIDERS: Record<LLMProviderId, LLMProvider> = {
  // 自营中转(sixam-api):统一出口、按客户计费,key 形如 sk-sixam-*。
  // ★默认供应商(activeProvider 与新租户首行都落它)。SIXAM_BASE_URL 仅供本地联调指到测试中转,生产别配。
  sixam: {
    id: 'sixam',
    label: 'SixAM 智能云',
    baseURL: (process.env.SIXAM_BASE_URL ?? 'https://api.6amtech.cn/v1').replace(/\/$/, ''),
    defaultModel: 'doubao-seed-2-1-pro', // 中转目录的对外名;也可直接填上游全名(中转有别名机制)
    apiKeyEnv: 'SIXAM_API_KEY',
  },
  bailian: {
    id: 'bailian',
    label: '阿里百炼(通义千问)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
  ark: {
    id: 'ark',
    label: '火山方舟(豆包)',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-pro-32k', // 方舟用接入点/模型名,按账号实际在设置页填写
    apiKeyEnv: 'ARK_API_KEY',
  },
  deepseek: {
    id: 'deepseek',
    label: '深度求索 DeepSeek',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat', // 另有 deepseek-reasoner(R1);用户可在设置页直接填模型 code
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  hunyuan: {
    id: 'hunyuan',
    label: '腾讯混元',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', // 混元 OpenAI 兼容接口
    defaultModel: 'hunyuan-turbos', // 另有 hunyuan-standard/hunyuan-lite/hunyuan-pro;用户可在设置页直接填模型 code
    apiKeyEnv: 'HUNYUAN_API_KEY',
  },
}

/** env 兜底 provider 选择:优先 LLM_PROVIDER,兼容旧 FEEDBACK_LLM_PROVIDER,默认自营中转(sixam)。 */
export function activeProvider(): LLMProvider {
  const id = (process.env.LLM_PROVIDER ?? process.env.FEEDBACK_LLM_PROVIDER) as LLMProviderId | undefined
  return (id && LLM_PROVIDERS[id]) || LLM_PROVIDERS.sixam
}
/** env 兜底模型:优先 LLM_MODEL,兼容旧 FEEDBACK_LLM_MODEL,否则 provider 默认模型。 */
export function resolveModel(p: LLMProvider): string {
  return process.env.LLM_MODEL ?? process.env.FEEDBACK_LLM_MODEL ?? p.defaultModel
}
export function resolveApiKey(p: LLMProvider): string | undefined {
  return process.env[p.apiKeyEnv]
}

/** 返回哪些 provider 在 env 中已配置 API Key */
export function envKeyStatus(): Record<LLMProviderId, boolean> {
  const result = {} as Record<LLMProviderId, boolean>
  for (const p of Object.values(LLM_PROVIDERS)) {
    result[p.id] = !!process.env[p.apiKeyEnv]
  }
  return result
}
