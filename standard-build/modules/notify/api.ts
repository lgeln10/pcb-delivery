// modules/notify/api.ts
// 通知模块对外接口(其它模块/组合根只从这里引,不进 logic 内部)。
export {
  getEmailConfig,
  saveEmailConfig,
  sendTestEmail,
  notifyByEmail, // 业务模块发邮件通知的唯一入口
  getFeishuConfig,
  saveFeishuConfig,
  sendTestFeishu,
  notifyByFeishu, // 业务模块推飞书群消息的唯一入口
  SECRET_PLACEHOLDER,
  type EmailConfigDTO,
  type SaveEmailInput,
  type FeishuConfigDTO,
  type SaveFeishuInput,
} from './logic'
export type { EmailMessage } from './email'
export type { FeishuMessage } from './feishu'
export { NotifyError } from './errors'
