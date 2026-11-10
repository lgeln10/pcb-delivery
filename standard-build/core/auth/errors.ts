// core/auth/errors.ts
// auth 统一错误。INVALID_CREDENTIALS 有意不区分"账号不存在/密码错"(防账号枚举)。
export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'TOO_MANY_ATTEMPTS' // 登录失败退避/锁定(core/auth/throttle.ts);不区分锁定维度,防探测
  | 'AMBIGUOUS_TENANT' // 同手机号存在于多个租户,需显式指定 tenantId
  | 'EMPLOYEE_NOT_ACTIVE'
  | 'TENANT_SUSPENDED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  // 扫码登录票据无效/过期/已用过。★三种情形刻意共用一个码 —— 分开回等于给了一个
  //   「这串是不是有效票」的探针,而这个端点是公开的(见 core/auth/qr-login.ts)。
  | 'QR_TICKET_INVALID'

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}
