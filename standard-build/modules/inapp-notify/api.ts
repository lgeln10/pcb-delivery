// modules/inapp-notify/api.ts — 对其他模块暴露的唯一入口。
// 只导出 createNotification：其他模块发通知走这里，不直接 import logic/model。
// registerNotificationSink：组合根注册外发渠道(企业 IM)以同步 fan-out 每条通知。
// resolveNotificationsBySource：来源单据状态变了、通知已失效时收口(标已读+改文案),
//   免得「需要您处理」的假警报永远挂在那儿(见该函数注释里的任一签场景)。
export { createNotification, registerNotificationSink, resolveNotificationsBySource, type CreateNotificationInput, type NotificationSink } from './logic'
