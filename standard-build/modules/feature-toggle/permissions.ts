// modules/feature-toggle/permissions.ts
import type { PermissionDef } from '../../core/org/api'

// 功能开关的管理权限。归到 app-settings 模块下(功能开关是「系统设置」页里的一个 tab),
// 这样在「角色与权限」页自然落进「系统管理」分组,无需改各 fork 的 MENU_GROUPS。
export const FEATURE_TOGGLE_PERMISSIONS: PermissionDef[] = [
  { code: 'feature-toggle:manage', name: '功能开关', module: 'app-settings', type: 'action' },
]
