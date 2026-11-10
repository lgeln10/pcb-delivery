// src/composables/useIsMobile.ts
// 零依赖移动端断点检测(matchMedia + 监听变化)。响应式适配统一用它,避免各页面散写 resize 逻辑。
// 默认 768px:手机竖屏与窄平板视为「移动端」(表格转卡片、抽屉全屏)。
import { onScopeDispose, ref, type Ref } from 'vue'

export function useIsMobile(query = '(max-width: 768px)'): Ref<boolean> {
  const isMobile = ref(false)
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(query)
    isMobile.value = mql.matches
    const handler = (e: MediaQueryListEvent) => {
      isMobile.value = e.matches
    }
    mql.addEventListener('change', handler)
    onScopeDispose(() => mql.removeEventListener('change', handler))
  }
  return isMobile
}
