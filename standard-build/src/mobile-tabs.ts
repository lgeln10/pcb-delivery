// src/mobile-tabs.ts
// 移动端底部 tab 栏。可见性与左侧菜单用同一套规则,由 App.vue 传入已算好的 key 集合。
export type MobileTab = { key: string; label: string }

export const MOBILE_TABS: readonly MobileTab[] = [
  { key: 'pcb-cam', label: 'PCB' },
  { key: 'notifications', label: '收件箱' },
]

/** 少于这个数就整条不显示。 */
export const MIN_TABS_TO_SHOW = 2

export function visibleMobileTabs(
  visibleKeys: ReadonlySet<string>,
  tabs: readonly MobileTab[] = MOBILE_TABS,
): MobileTab[] {
  const kept = tabs.filter((t) => visibleKeys.has(t.key))
  return kept.length >= MIN_TABS_TO_SHOW ? kept : []
}
