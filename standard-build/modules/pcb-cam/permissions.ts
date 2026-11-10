// modules/pcb-cam/permissions.ts
import type { PermissionDef } from '../../core/org/api'

export const PCB_CAM_PERMISSIONS: PermissionDef[] = [
  { code: 'pcb-cam:menu', name: 'PCB CAM 菜单', module: 'pcb-cam', type: 'menu' },
  { code: 'pcb-cam:view', name: '查看 CAM 项目与任务', module: 'pcb-cam', type: 'action' },
  { code: 'pcb-cam:operate', name: 'CAM 上传资料/确认层与规格', module: 'pcb-cam', type: 'action' },
  { code: 'pcb-cam:approve', name: 'CAM 问题点决策/重跑/取消', module: 'pcb-cam', type: 'action' },
  { code: 'pcb-cam:config', name: 'CAM 工厂标准配置', module: 'pcb-cam', type: 'action' },
]
