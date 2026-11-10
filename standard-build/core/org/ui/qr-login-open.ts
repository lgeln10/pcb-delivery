// core/org/ui/qr-login-open.ts — 「右上角账号菜单 →『扫码登录移动端』」这条捷径的接线。
//
// ★为什么不是一个纯 window 事件(像 `si:open-feedback` 那样)?
//   FeedbackWidget 常驻挂载,派事件时它一定在听。而「扫码登录」那块在 PersonalSettings 里,
//   PersonalSettings 是**懒加载页**(lazyPage → 动态 import) —— 菜单点下去的那一刻它还没挂载,
//   甚至 chunk 都还没下载完。此时派出去的事件没有任何人接,捷径就是个「点了没反应」的死按钮。
//   所以要留一张**便条**:请求先记在这里,组件挂载时自己来取。
//
// ★两条路都要留:页面没挂载时靠便条,已经停在「个人设置」页上时靠事件
//   (那时 onMounted 不会再跑一次)。两边都经过 takeQrLoginRequest(),所以只会兑现一次。

const EVENT = 'si:open-qr-login'

let pending = false

/** 请求打开「扫码登录」弹窗。调用方随后要把页面切到「个人设置」。 */
export function requestQrLogin(): void {
  pending = true
  window.dispatchEvent(new CustomEvent(EVENT))
}

/** 取走请求(取过即清)。返回 true 表示「刚才有人按了那个菜单项」。 */
export function takeQrLoginRequest(): boolean {
  const v = pending
  pending = false
  return v
}

/** 订阅请求;返回退订函数。给**已经挂载**的那种情况用。 */
export function onQrLoginRequest(fn: () => void): () => void {
  const handler = (): void => fn()
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
