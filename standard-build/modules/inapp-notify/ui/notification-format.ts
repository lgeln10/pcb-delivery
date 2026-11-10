// modules/inapp-notify/ui/notification-format.ts
// 通知时间的相对显示。铃铛与通知整页共用 —— 同一条通知在两处显示成不同时间是很扎眼的不一致。
// (全仓还有几处各写各的相对时间;统一它属于另一件事,这里只保证站内信这两个视图一致。)

/** 「刚刚 / N 分钟前 / N 小时前 / M月D日」。跨天就给日期,别显示「27 小时前」。 */
export function formatNotifyTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
