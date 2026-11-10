// src/mobile-immersive.ts
// 移动端「沉浸视图」:某个页面在手机上进到了**占满整屏、自带返回键**的二级视图(聊天窗)时,
// **壳的两条栏一起让位** —— 底部 tab 栏与 App 全局顶栏都收起,它们占的高度还给内容
// (机制同 html.kb-open,见 styles.css 的 .app-shell--immersive)。
//
// 为什么聊天窗里不该有那条栏:
//  ① 它横在输入行下面,拇指区最贵的一条被一排「去别的页面」的按钮占着,而人这会儿正在打字;
//  ② 发送键与「助手」那一格上下相邻十几像素,误触代价是**整页切走**(草稿还在,但人得自己找回来);
//  ③ 聊天窗左上角已经有返回键,tab 栏在这里不提供任何新的去处 —— 它只是重复了一遍返回;
//  ④ 微信 / 飞书 / iMessage 进会话都是**盖住**底栏的。留着它是全站网页味最重的一处。
//
// 顶栏同理:聊天窗自己有一条(返回 + 会话名 + 设置),App 顶栏写的是同一件事(「消息」/「我的助手」)。
// 两条叠起来在 375×667 上约 110px —— 整屏的六分之一,用来说一句重复的话。
//
// ★但只在「这一屏有返回键」时才收起 —— 顶栏一收,汉堡菜单也跟着没了,返回键是唯一的出口。
//   数字员工页的 soloAssistant(全公司只有一个助手、直接落进聊天、刻意不给返回箭头)必须
//   **排除**在沉浸之外 —— 两条栏都收了它就是零个出口,人被关在聊天里出不去。
//   判据写在各页的调用处,不写在这里:这里不知道谁有返回键。
//
// ★计数而不是布尔。切页时新页面可能先挂载、旧页面后卸载(Vue 的默认顺序就是如此),
//   布尔会被后卸载的那个抹成 false,表现是「从消息切到别的页,tab 栏该回来却没回来」。
//   每个调用方持有一个 claim,加减配对,卸载时无条件归还。
import { computed, onUnmounted, ref, watch, type Ref } from 'vue'

const holds = ref(0)

/** 当前是否有页面正处在沉浸视图里(App.vue 用它决定两条栏出不出)。 */
export const isMobileImmersive = computed(() => holds.value > 0)

/**
 * 在 setup 里声明「本页在 `active` 为真时是沉浸视图」。
 *
 * @param active 通常是 `computed(() => isMobile.value && mobileView.value === 'chat')`。
 *               **务必把「有没有返回键」算进去**(见文件头)。
 */
export function useMobileImmersive(active: Ref<boolean>): void {
  let held = false
  const set = (on: boolean) => {
    if (on === held) return
    held = on
    holds.value += on ? 1 : -1
  }
  watch(active, (v) => set(v), { immediate: true })
  onUnmounted(() => set(false))
}

/** 仅供测试:把计数清零,免得一个用例的残留影响下一个。 */
export function __resetMobileImmersive(): void {
  holds.value = 0
}
