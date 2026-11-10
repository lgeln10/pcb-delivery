<script setup lang="ts">
// src/ui/MobileTabBar.vue
// 移动端底部 tab 栏(手机浏览器 + App 壳内都显示)。
//
// 定位:**常驻**。用户可以照旧用左上角汉堡菜单去任何页面,这条栏一直在;任何时候点某个 tab
// 都直接回到那一页 —— 包括「已经在这一页」时也当成一次导航(见 App.vue 的 onSelect:同页会关掉
// 抽屉但不压历史)。它不替代左侧菜单,只是把四个高频入口摆在拇指够得着的地方。
//
// 哪些 tab 出现由 src/mobile-tabs.ts 决定(与左侧菜单同一套可见性),这里只负责画。
import { computed } from 'vue'
import type { MobileTab } from '../mobile-tabs'

const props = defineProps<{
  tabs: readonly MobileTab[]
  icons: Record<string, unknown>
  active: string
  /** 角标数(按 tab key)。只有取数便宜的入口才配角标 —— 见 App.vue 里的说明。 */
  badges?: Record<string, number>
}>()
const emit = defineEmits<{ (e: 'select', key: string): void }>()

const badgeOf = (key: string) => props.badges?.[key] ?? 0
// 等分:两个 tab 时各占一半,四个时各占四分之一,不用写死宽度
const colStyle = computed(() => ({ gridTemplateColumns: `repeat(${props.tabs.length}, 1fr)` }))
</script>

<template>
  <nav class="app-tabbar" :style="colStyle" aria-label="底部导航">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      class="app-tabbar__item"
      :class="{ 'app-tabbar__item--active': tab.key === active }"
      :aria-current="tab.key === active ? 'page' : undefined"
      @click="emit('select', tab.key)"
    >
      <span class="app-tabbar__icon">
        <component :is="icons[tab.key]" :size="22" />
        <span v-if="badgeOf(tab.key) > 0" class="app-tabbar__badge">
          {{ badgeOf(tab.key) > 99 ? '99+' : badgeOf(tab.key) }}
        </span>
      </span>
      <span class="app-tabbar__label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
/* 高度写进 --sb-tabbar-h(styles.css 里定义),内容区靠它避让 —— 别在这里改死高度。 */
.app-tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  /* 比内容高,比移动端侧栏抽屉(1100)和它的遮罩(1090)低:抽屉拉开时这条要被盖住 */
  z-index: 1000;
  display: grid;
  background: var(--sb-bg-card);
  /* 底部安全区(iPhone 的 Home 条 / 安卓的手势条或三键导航栏):浏览器里取 0,是恒等变换。
     ★变量来源见 styles.css「安全区四变量」一节 —— 安卓上它不是 env(),是原生注入的。
     左右也垫:横屏刘海落在屏幕一侧,而这条栏是 fixed 通宽的,不跟着 .app-shell 让位。 */
  padding-bottom: var(--sb-safe-bottom);
  padding-left: var(--sb-safe-left);
  padding-right: var(--sb-safe-right);
  /* ★分隔线用 inset 阴影而不是 border-top:border 会给整条**多 1px 布局高度**,
     而内容区是按 --sb-tabbar-h 精确让位的,多出来的 1px 就是压在内容上的那 1px。
     inset 阴影画在盒内,不参与布局,高度因此严格等于 row + 安全区。 */
  box-shadow: inset 0 1px 0 var(--sb-border), 0 -1px 8px rgb(0 0 0 / 6%);
}

.app-tabbar__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  /* ★用固定 height 而不是 min-height:内容区靠 --sb-tabbar-h 精确让位,栏比它高多少就压住内容多少。
     行高与那个变量同源(styles.css 的 --sb-tabbar-row),改一处两边一起动。
     56 的由来:图标 22 + 间距 2 + 文字 14.4 + 上下内边距 16 = 54.4,留一点余量;
     也正好是 44px 可触控下限之上、安卓 56dp 的常规底栏高度。 */
  height: var(--sb-tabbar-row, 56px);
  padding: var(--sb-space-2) 0;
  border: none;
  background: none;
  color: var(--sb-text-tertiary);
  cursor: pointer;
  /* 连点两下会被 iOS 当成双击缩放,整页跳一下 */
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.app-tabbar__item--active { color: var(--sb-color-primary); }

.app-tabbar__icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
}

.app-tabbar__label {
  font-size: var(--sb-font-xs);
  line-height: 1.2;
}
.app-tabbar__item--active .app-tabbar__label { font-weight: 600; }

.app-tabbar__badge {
  position: absolute;
  top: -4px;
  left: 100%;
  transform: translateX(-40%);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 99px;
  background: var(--sb-color-danger);
  color: var(--sb-text-inverse);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
}
</style>
