// src/nav-collapse.ts
// 左侧主导航「收起 / 展开」的用户偏好(桌面档),跨会话记忆在 localStorage。
//
// ★只落盘**用户显式点汉堡键**的结果 —— 2026-08-14 起,**没有任何程序路径会改这个值**,
//   汉堡键是唯一入口。历史:曾经进「问AI」页会自动把侧栏收成图标条、离开再还原;那个临时态
//   一度也想存进来,存了就会变成「每次打开系统侧栏都是收起的」,因为默认落地页恰好就是
//   si-askai(2026-08-03 用户反馈)。那套自动收起已按用户要求整段拿掉(见 App.vue 那段说明)。
// ★默认展开:没存过 / 存的是脏值 / localStorage 根本不可用,一律当展开。
//   宁可忘记偏好,也不要让人打开系统就看不见菜单。

export const NAV_COLLAPSED_KEY = 'standard-build.nav-collapsed'

type ReadableStorage = Pick<Storage, 'getItem'>
type WritableStorage = Pick<Storage, 'setItem'>

/** 拿 localStorage;禁用第三方存储的 iframe 里**访问属性本身**就会抛,所以要包起来。 */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 读收起偏好。只认严格的 'true',其余(含脏值/读失败)一律 false = 展开。 */
export function readNavCollapsed(storage: ReadableStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(NAV_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/** 写收起偏好。写不进去(无痕模式/配额满)只影响「下次还记不记得」,绝不能把应用带崩。 */
export function writeNavCollapsed(value: boolean, storage: WritableStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(NAV_COLLAPSED_KEY, String(value))
  } catch {
    // 故意吞掉:记不住偏好是可接受的降级,抛出去会炸掉整个应用壳
  }
}
