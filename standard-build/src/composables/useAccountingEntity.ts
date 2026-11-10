// src/composables/useAccountingEntity.ts
// 当前账套实体(财务独立核算组织)的前端单例。id 存浏览器 localStorage,
// API 客户端每次请求即时读取并作为 X-Accounting-Entity 头发出(见 src/api/client.ts)。
// 切换账套后需失活 finance 相关查询缓存,由调用方(App.vue)负责。
import { ref } from 'vue'
import { FINANCE_ENTITY_KEY } from '../api/client'

const activeEntityId = ref<string>(localStorage.getItem(FINANCE_ENTITY_KEY) ?? '')

export function useAccountingEntity() {
  function setActiveEntity(id: string) {
    activeEntityId.value = id
    if (id) localStorage.setItem(FINANCE_ENTITY_KEY, id)
    else localStorage.removeItem(FINANCE_ENTITY_KEY)
  }
  return { activeEntityId, setActiveEntity }
}
