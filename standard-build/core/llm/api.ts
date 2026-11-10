// core/llm/api.ts — 平台 LLM 基础设施对外唯一入口。
// 业务模块要用大模型:runtime 配置走 resolveLLMRuntimeConfig / buildTenantLLMCaller,不各自读 env。
export { LLM_PROVIDERS, type LLMProviderId, type LLMProvider } from './providers'
export { LlmError, type LlmErrorCode } from './errors'
export {
  makeLLMCaller, defaultLLMCaller, makeResilientCaller, runWithLLMFallback, isRetryableLLMError,
  type ChatMessage, type LLMCaller, type LLMResult, type LLMSlot,
  TOOL_NAMES,
} from './caller'
export {
  LLM_SCENES, DEFAULT_SCENE, getScene, isSceneKey,
  type LlmSceneKey, type LlmScene, type LlmCapability,
} from './scenes'
export {
  getConfig, updateConfig, saveProviderKey, deleteProviderKey, resolveProviderApiKey,
  upsertSceneConfig, deleteSceneConfig,
  buildTenantLLMCaller, resolveLLMRuntimeConfig, resolveLLMRuntimeConfigWithFallback,
  type LLMRuntimeConfig, type LlmConfigDTO, type LlmSceneConfigDTO,
} from './config'
// 图片 → 文字。文本模型收不了图片的出口很多(见 vision.ts 的实测),旁路转录是通用兜底。
export { describeImage } from './vision'
export { llmRoutes } from './routes'
// 智能体管理页「模型接入」要显示每个场景**实际生效**的模型(不只是网关那份配置)。
export { listEffectiveRoutes, type EffectiveRoute } from './config'
export { usageByScene, usageByDay, recordUsage, type UsageBySceneRow } from './usage'
