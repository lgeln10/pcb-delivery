// modules/inapp-notify/ui/notification-link.ts
// 通知点击 → 做什么(就地读全文 / 跳一屏 / 跳过去开那一单)。
//
// ★为什么抽出来:铃铛面板(NotificationBell)和整页(NotificationsPage)是同一批通知的两个视图。
//   路由表原本内联在铃铛的 switch 里,再写一遍就一定会分叉 —— 将来加一种 sourceType 只在一处加,
//   表现成「在铃铛里点得开、在通知页点了没反应」,而且两边都不报错。
//
// 结构上刻意分成**纯函数 + 副作用**两截:纯的那截在 `../notification-target.ts`
// (因为服务端推送 sink 也要用它,而这个文件 import 了浏览器侧的 nav-context);
// 这里只留把结果转成 setNavContext + si:navigate 的那一截。
//
// ★落点页没权限时会怎样:App.vue 的 si:navigate 处理器只接受 knownSections(= 当前用户**可见**的
//   菜单集合),所以跳到一个没权限的页 = 什么都不发生,不会看到无权页或空白。

import { setNavContext } from '../../../src/nav-context'

export { notificationTarget, type NotificationTarget } from '../notification-target'
import { notificationTarget } from '../notification-target'

/** 点这条通知该发生什么。'read' = 正文即内容,由调用方就地展开/开抽屉,**不跳走**。 */
export function notificationAction(
  item: { sourceType: string; sourceId: string },
  selfEmployeeId?: string,
): 'read' | 'jump' | 'none' {
  const t = notificationTarget(item, selfEmployeeId)
  if (!t) return 'none'
  return t.kind === 'read' ? 'read' : 'jump'
}

/**
 * 跳到某个 section(可带定位)。给「去处理」按钮与 jump 类通知共用。
 * @returns 是否真的跳了(调用方据此决定要不要收起面板)
 */
export function navigateToSection(section: string, payload?: Record<string, string>): boolean {
  if (payload) setNavContext(section, payload)
  window.dispatchEvent(new CustomEvent('si:navigate', { detail: section }))
  return true
}

/**
 * 执行跳转(仅 navigate / deeplink 两类)。App.vue 监听 `si:navigate` 切 section;
 * 需要定位到具体单据的先塞导航上下文,目标页挂载时一次性消费(见 src/nav-context.ts)。
 * ★read 类**不在这里处理** —— 它的正文就是内容,跳走等于把内容丢了。
 * @returns 是否真的跳了
 */
export function openNotificationSource(
  item: { sourceType: string; sourceId: string },
  selfEmployeeId?: string,
): boolean {
  const target = notificationTarget(item, selfEmployeeId)
  if (!target || target.kind === 'read') return false
  return navigateToSection(target.section, target.payload)
}
