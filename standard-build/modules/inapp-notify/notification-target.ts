// modules/inapp-notify/notification-target.ts
// sourceType → 点击时该发生什么(**纯函数,零依赖**)。
//
// ★为什么单独一个文件:这张表有**两个**消费方 ——
//   ① 前端点通知(ui/notification-link.ts,再转成就地读 / setNavContext + si:navigate);
//   ② 服务端把站内信推到手机时要带上 section(server.ts 的推送 sink)。
//   ②当初没有这张表可用,于是 sink 只传了 sourceId 不传 section,而 App 壳的点击处理第一行就是
//   `if (!section) return` —— **除聊天外的所有推送(审批/线索/日程/考勤预警…)点开进 App
//   什么也不发生**,全链路不报错。抽到这里之后两边共用一份,不会再各长各的。
//   ★这个文件不能 import 任何浏览器/Vue 的东西(server.ts 要 import 它)。
//
// ★★ 2026-08-21 三档口径(在此之前只有「跳/不跳」两态,而且「不跳」是靠**忘了写 case**
//    实现的 —— 客户移交通知就是这么变成死链的:sourceType 'partner' 既不在枚举里也没有 case,
//    点了什么都不发生且不报错)。现在「点击后果」是显式数据:
//
//    · read     —— **正文就是内容**(日报/周报/晨检/告警清单)。跳走反而把内容丢了:
//                  正文在列表里被截成 2–3 行,而这类通知的全文有二三十行。
//                  手机就地展开、桌面开抽屉;带 section 时抽屉底部再给一颗「去…」做次要动作。
//    · navigate —— 有落地页,但没有单条可定位,落到那一屏让人自己看。
//    · deeplink —— 能定位到具体单据,跳过去并直接打开它。

/** 通知点击的落点。 */
export type NotificationTarget =
  /** 正文即内容:就地读完。section 存在时,详情里额外给一颗「去…」的次要按钮。 */
  | { kind: 'read'; section?: string; payload?: undefined }
  /** 跳到那一屏(没有单条可定位)。 */
  | { kind: 'navigate'; section: string; payload?: undefined }
  /** 跳过去并打开具体那一条。 */
  | { kind: 'deeplink'; section: string; payload: Record<string, string> }

/**
 * sourceType → 点击后果。返回 null = 不认识这个类型(老服务器写进来的新类型),前端只标已读、不动页面。
 *
 * ★新增 sourceType 时**必须**在这里加一条 —— `model.ts` 的 `INAPP_NOTIFY_SOURCE_TYPES` 是全集,
 *   tests/notification-link.test.ts 会逐条对账,漏配当场变红(以前漏配是静默死链)。
 *
 * @param selfEmployeeId 当前登录者;考勤预警靠它区分「说的是我」还是「说的是我的下属」。
 */
export function notificationTarget(
  item: { sourceType: string; sourceId: string },
  selfEmployeeId?: string,
): NotificationTarget | null {
  switch (item.sourceType) {
    case 'db_backup':
      return { kind: 'read', section: 'app-settings' }
    default:
      return null
  }
}

/**
 * 手机推送要落到哪个 section(server.ts 的推送 sink 用)。
 * ★`read` 一律落**收件箱页**:正文才是内容,把人送到某张业务列表反而读不到它。
 *   收件箱(nav key `notifications`)不挂权限,全员可见,不会被 App 壳的可见性白名单吞掉。
 */
export function notificationPushSection(
  item: { sourceType: string; sourceId: string },
  selfEmployeeId?: string,
): string | undefined {
  const target = notificationTarget(item, selfEmployeeId)
  if (!target) return undefined
  return target.kind === 'read' ? 'notifications' : target.section
}
