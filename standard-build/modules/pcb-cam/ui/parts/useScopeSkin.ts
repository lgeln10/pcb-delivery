// modules/pcb-cam/ui/parts/useScopeSkin.ts
// 「示波器」皮肤:深底、铜绿/焊盘金、网格背景、发光描边、进场扫描线。只作用于 PCB CAM 这一页(.pcb-scope 类),
// 不动全站主题;localStorage 记忆。纯观感,随时可关。
import { ref } from 'vue'

const KEY = 'pcb-cam.skin'
const on = ref<boolean>(typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'scope')

export function useScopeSkin() {
  function toggle() {
    on.value = !on.value
    try {
      localStorage.setItem(KEY, on.value ? 'scope' : 'plain')
    } catch {
      // 隐私模式没有 localStorage
    }
  }
  return { scopeOn: on, toggleScope: toggle }
}
