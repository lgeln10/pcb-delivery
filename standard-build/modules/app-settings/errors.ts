// modules/app-settings/errors.ts
export type AppSettingsErrorCode =
  | 'INVALID_INPUT' // 入参非法(系统名称为空/超长、logo 类型/大小不合法)
export class AppSettingsError extends Error {
  constructor(
    public code: AppSettingsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AppSettingsError'
  }
}
