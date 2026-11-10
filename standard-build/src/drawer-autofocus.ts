// v-drawer-autofocus —— 抽屉/弹层打开后自动聚焦第一个可输入控件。
//
// ★为什么要有它:UI_SPEC §7 第一条就是「打开即聚焦首字段」,而 2026-08-27 的全量盘点结论是
//   **36 个抽屉,0 个聚焦**。表现是:点「新建」,抽屉滑出来,光标不在任何地方 ——
//   每次录入都要先用鼠标点一下第一个框。这类缺陷不会有人报 bug,它只是让每次录入多一次点击。
//
// ★为什么做成指令而不是逐页写 `@opened`:36 个抽屉逐页手写,
//   一是会有人漏、二是会长出 36 种略有差别的写法(盘点里那三套统计卡就是这么来的)。
//
// 用法:挂在**抽屉正文里那个包裹表单的元素**上,不是挂在 `<el-drawer>` 上 ——
//   ElDrawer 的根是 Teleport,指令拿到的 `el` 是一个注释锚点,不是元素。
//
//   <el-drawer v-model="open" destroy-on-close>
//     <div v-drawer-autofocus class="form-grid"> … </div>
//   </el-drawer>
//
//   配 `destroy-on-close`(UI_SPEC §7 本来就要求弹层带它)时,mounted 就是「这次打开」;
//   看/改同抽屉切换的页面里,表单是 v-if 出来的,翻到编辑态时同样会触发 —— 都是想要的时机。
import type { Directive } from 'vue'

/** 能接受输入的控件。**排除按钮**:抽屉底栏那颗「保存」不该抢走焦点。 */
const FOCUSABLE = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])',
  'textarea:not([disabled]):not([readonly])',
  '[contenteditable="true"]',
].join(', ')

/** 表单不一定在 mounted 那一刻就在(外面可能包着 AsyncState,先出骨架屏)。等它出现,但别等太久。 */
const WAIT_BUDGET_MS = 2000

const OBSERVER = Symbol('drawer-autofocus-observer')
type Host = HTMLElement & { [OBSERVER]?: { stop: () => void } }

function firstField(root: HTMLElement): HTMLElement | null {
  for (const node of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    // offsetParent 为 null = 被 display:none 藏着(折叠的筛选区、未展开的分组)
    if (node.offsetParent === null) continue
    if (node.closest('[aria-hidden="true"]')) continue
    return node
  }
  return null
}

function tryFocus(root: HTMLElement): boolean {
  const field = firstField(root)
  if (!field) return false
  // preventScroll:抽屉是滑进来的,进场动画没结束时元素还在视口外,
  // 不加这个会连带把外层滚动条拽一下。
  field.focus({ preventScroll: true })
  return true
}

export const vDrawerAutofocus: Directive<Host> = {
  mounted(el) {
    // ★触屏上不自动聚焦:聚焦 = 立刻弹出软键盘,会把刚滑出来的抽屉盖掉大半屏,
    //   而人这时多半是先要**看**一眼,不是马上打字。桌面端才有「省一次点击」这个收益。
    if (window.matchMedia?.('(any-pointer: coarse)').matches) return

    // 先试一次(常见情况:表单就在 DOM 里)。EP 的抽屉有进场动画,等一帧拿到最终位置。
    let done = false
    const attempt = () => {
      if (done) return
      // 人已经自己点进某个框了就别抢
      if (el.contains(document.activeElement)) { done = true; return }
      if (tryFocus(el)) done = true
    }
    requestAnimationFrame(attempt)
    // ★EP 抽屉自带 focus trap:打开动画结束时它会把焦点放到抽屉容器/标题上 ——
    //   实测发生在我们 rAF 那一次**之后**,先聚焦的字段又被抢回去。它的时机跟随
    //   进场动画(约 300ms),在那之后再补两次。补的时候 done 要重置判据:
    //   焦点在 el 外面但仍在这个抽屉里(标题/容器上),就视为「被 trap 抢走」,抢回来。
    for (const delay of [150, 450]) {
      window.setTimeout(() => {
        const ae = document.activeElement
        // 人已经在**表单里**打字了才算数;焦点挂在抽屉容器/标题上不算
        if (el.contains(ae) && ae !== document.body) return
        if (ae instanceof HTMLElement && ae.closest('.el-drawer') && !el.contains(ae)) done = false
        attempt()
      }, delay)
    }

    // 表单还没到(AsyncState 在出骨架屏)→ 盯到它出现为止,最多 2 秒。
    const mo = new MutationObserver(() => {
      attempt()
      if (done) stop()
    })
    mo.observe(el, { childList: true, subtree: true })
    const timer = window.setTimeout(() => stop(), WAIT_BUDGET_MS)
    function stop() {
      mo.disconnect()
      window.clearTimeout(timer)
    }
    el[OBSERVER] = { stop }
  },
  unmounted(el) {
    el[OBSERVER]?.stop()
    delete el[OBSERVER]
  },
}
