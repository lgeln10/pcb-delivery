// src/nav-context.ts
// 跨页导航上下文(驾驶舱下钻用):来源页 setNavContext(目标section, 载荷) 后 emit('navigate', section),
// 目标页在挂载/激活时 consumeNavContext(自己的section) 一次性取走并预置筛选。
// 一次性消费:取走即清,防止旧上下文在用户手动切页时再次生效。
import { ref } from 'vue'

export type NavContextPayload = Record<string, string>

const pending = ref<{ section: string; payload: NavContextPayload } | null>(null)

export function setNavContext(section: string, payload: NavContextPayload): void {
  pending.value = { section, payload }
}

/** 目标页取走属于自己的上下文(不匹配返回 null 且不清除,留给真正的目标页)。 */
export function consumeNavContext(section: string): NavContextPayload | null {
  if (pending.value?.section !== section) return null
  const payload = pending.value.payload
  pending.value = null
  return payload
}

/** 供目标页 watch 用:当前是否有发给某 section 的待消费上下文。 */
export function hasNavContext(section: string): boolean {
  return pending.value?.section === section
}

/** 响应式引用(目标页 watch 它以便「已挂载时再次下钻」也能响应)。 */
export const navContextRef = pending
