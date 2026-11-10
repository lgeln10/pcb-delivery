// src/edge-swipe-back.ts — 从屏幕左缘右滑 = 返回上一页。
//
// 为什么要自己做:本应用**没有 vue-router**,页面切换是 App.vue 的 activeSection + history.pushState,
// URL 恒为 `/`。iOS 的原生右滑返回只在 WKWebView 打开 allowsBackForwardNavigationGestures 时才有,
// 而 Capacitor 没暴露这个开关(要改 Swift 并重装 App)。用 JS 手势实现有三个好处:
//   ① 纯 H5,改完重开即可,不用重装;② 手机浏览器里也能用;③ 行为完全可控 —— 直接 history.back(),
//   由 App.vue 现成的 popstate 处理器切回上一个 section。
//
// 只认「从左缘起手」的横向滑动 —— 页面中间的横滑要留给轮播/表格横向滚动,不能抢。

/** 起手区宽度。iOS 系统手势区约 20px,这里给宽一点更好触发,但不至于误伤正文横滑。 */
const EDGE_PX = 28
/** 触发所需的横向位移。 */
const TRIGGER_DX = 64
/** 横向位移必须明显大于纵向,否则那是在竖向滚动列表。 */
const DIRECTION_RATIO = 1.6
/** 超时未完成就不算手势(防止手指按住不动很久后误触发)。 */
const MAX_DURATION_MS = 800

type Touch0 = { x: number; y: number; t: number }

export function initEdgeSwipeBack(): void {
  let start: Touch0 | null = null

  window.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return // 多指:缩放等,不管
      const t = e.touches[0]!
      start = t.clientX <= EDGE_PX ? { x: t.clientX, y: t.clientY, t: Date.now() } : null
    },
    { passive: true },
  )

  window.addEventListener(
    'touchend',
    (e) => {
      const s = start
      start = null
      if (!s) return
      if (Date.now() - s.t > MAX_DURATION_MS) return
      const t = e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - s.x
      const dy = Math.abs(t.clientY - s.y)
      if (dx < TRIGGER_DX) return
      if (dx < dy * DIRECTION_RATIO) return // 更像竖滑
      // 只有当历史里确实有本应用压入的页面时才回退 ——
      // 否则会退出到 webview 的上一个文档(壳登录页),那不是用户要的。
      if ((history.state as { siSection?: string } | null)?.siSection) history.back()
    },
    { passive: true },
  )

  // 手指中途被系统打断(来电、通知横幅)时清掉起手态,免得下一次 touchend 用到过期的起点
  window.addEventListener('touchcancel', () => { start = null }, { passive: true })
}
