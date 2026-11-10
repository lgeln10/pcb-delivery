// modules/feature-toggle/errors.ts
export type FeatureToggleErrorCode =
  | 'INVALID_INPUT' // feature_key 格式非法
  | 'PROTECTED_KEY' // 关闭了核心入口(会导致自锁)
export class FeatureToggleError extends Error {
  constructor(
    public code: FeatureToggleErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FeatureToggleError'
  }
}
