// modules/notify/errors.ts
export type NotifyErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED' // 渠道未配置/未启用
  | 'SEND_FAILED' // 外部发送失败(SMTP 拒绝/超时等),message 不含凭证/堆栈
  | 'KEY_STORE_UNAVAILABLE'
export class NotifyError extends Error {
  constructor(
    public code: NotifyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'NotifyError'
  }
}
