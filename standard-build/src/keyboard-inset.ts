// src/keyboard-inset.ts
// 手机软键盘弹起时,把「实际还能看见多高」喂给布局。
//
// 为什么需要:壳层是 `.app-main { height: 100vh; overflow-y: auto }`。iOS 的键盘是**盖**上来的,
// 不挤压布局 —— 100vh 一动不动,于是贴在底部的输入区(数字员工聊天、Ask AI、⌘K 面板)整个落在
// 键盘底下:光标看不见、发送键点不到。安卓 Chrome 反过来,键盘会压缩 layout viewport,100vh
// 自己就变小了,不用管。所以这段只在「窗口高度和实际可视高度对不上」时才接管,天然只对 iOS 生效。
//
// ★只在真的有输入控件获得焦点时接管,一失焦立刻还原。
//   代价是多绑两个事件;换来的是:万一哪个浏览器的 visualViewport 报了怪数,受影响的也只有
//   打字那几秒,不会出现「某台机器上整个应用高度塌了」这种没法远程复现的事故。
//   壳层高度是全站唯一的布局地基,在这上面动手脚必须能自己收回来。

/** 窗口高度与可视高度差多少才算「键盘起来了」。地址栏伸缩只有几十像素,键盘至少两百多。 */
const KEYBOARD_MIN_PX = 80

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

let scheduled = 0

/**
 * CSS 钩子:键盘起来了。
 * ★与 --sb-kb-vh **同一个判定、同一处开关**,不能分成两套 —— 底部 tab 栏靠它收起,
 *   而 .app-main 的高度靠 --sb-kb-vh;两者若在不同时机切换,会出现「栏还在、高度已经让开」
 *   (底部空一条)或反过来(栏压住输入框)的错位。
 */
const KEYBOARD_OPEN_CLASS = 'kb-open'

function apply(): void {
  scheduled = 0
  const vv = window.visualViewport
  const root = document.documentElement
  // 没在打字 / 键盘没起来 → 撤掉变量,高度回落到 CSS 里的 100vh
  if (!vv || !isTyping() || window.innerHeight - vv.height < KEYBOARD_MIN_PX) {
    root.style.removeProperty('--sb-kb-vh')
    root.classList.remove(KEYBOARD_OPEN_CLASS)
    return
  }
  root.style.setProperty('--sb-kb-vh', `${Math.round(vv.height)}px`)
  root.classList.add(KEYBOARD_OPEN_CLASS)
}

// ★必须过一帧再算:focusout 触发时焦点还没落到新元素上,document.activeElement 暂时是 body,
//   直接算会误判成「没在打字」而闪一下高度。rAF 也顺带把键盘动画期间的连续 resize 合并掉。
function schedule(): void {
  if (!scheduled) scheduled = requestAnimationFrame(apply)
}

export function initKeyboardInset(): void {
  const vv = window.visualViewport
  if (!vv) return // 老浏览器:维持现状(100vh),不做任何事
  vv.addEventListener('resize', schedule)
  vv.addEventListener('scroll', schedule)
  window.addEventListener('focusin', schedule)
  window.addEventListener('focusout', schedule)
}
