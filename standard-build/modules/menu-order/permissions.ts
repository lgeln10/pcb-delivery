// modules/menu-order/permissions.ts
// 归到 app-settings 模块下(菜单排序是「系统设置」页里的一个 tab),这样在「角色与权限」页
// 自然落进「系统管理」分组 —— 与 feature-toggle / ai-gateway 同一处理。
//
// ★只有 manage,没有 view:读接口(GET /api/menu-order)**全员登录即可**,因为壳层要靠它
//   渲染侧边栏。给读加权限码等于让没有该码的员工看到一个乱序(或空)的导航。
import type { PermissionDef } from '../../core/org/api'

export const MENU_ORDER_PERMISSIONS: PermissionDef[] = [
  { code: 'menu-order:manage', name: '菜单排序配置', module: 'app-settings', type: 'action' },
]
