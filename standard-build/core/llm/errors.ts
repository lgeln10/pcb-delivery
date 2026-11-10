// core/llm/errors.ts
// 平台 LLM 基础设施错误。code 复用 core/http/errors.ts 里已登记的映射(LLM_NOT_CONFIGURED/LLM_ERROR/… → 400)。
export type LlmErrorCode = 'INVALID_INPUT' | 'LLM_NOT_CONFIGURED' | 'LLM_ERROR' | 'KEY_STORE_UNAVAILABLE'
// opts.status:上游 HTTP 状态(有则记);opts.retryable:是否可切备用模型重试(429/5xx/网络超时=true,
// 400/401 等确定性错误=false)。备用模型机制据此决定「主选失败要不要切兜底再试」。
export class LlmError extends Error {
  status?: number
  retryable?: boolean
  constructor(
    public code: LlmErrorCode,
    message: string,
    opts?: { status?: number; retryable?: boolean },
  ) {
    super(message)
    this.name = 'LlmError'
    this.status = opts?.status
    this.retryable = opts?.retryable
  }
}
