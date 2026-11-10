// modules/app-settings/api.ts — 系统设置对外只读接口(其它模块只准从这引)。
// 对外两项:「系统时区」(所有定时提醒的「几点触发 / 今天算哪一天」按租户配置算,不能用进程时区 ——
// 容器默认 UTC → 配 9:00 实际 17:00 才发;时刻换算是纯函数,一并导出)和「本公司开票信息」
// (报销/付款提交侧的 AI 预审信号采集用来核对发票买方抬头)。
export { getTenantTimezone, getTenantInvoiceTitle } from './logic'
export { withDefaultNextTime, DEFAULT_NEXT_TIME_MORNING, DEFAULT_NEXT_TIME_AFTERNOON } from './next-time'
export { DEFAULT_TIMEZONE, isValidTimezone, zonedDate, zonedDateTime, zonedDayStart, zonedHour, zonedMonth, zonedTimeToUtc, zonedWallClockToUtc, zonedWeekday } from './time'
