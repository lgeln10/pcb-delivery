// src/nav-catalog.ts
// 导航目录(纯数据:分组 → 菜单,只含 key/label/permission,不含图标)。
// ★单一来源:App.vue 按 key 贴图标渲染左侧导航;功能开关页据此列出「菜单组 / 菜单」。
// ★module = 该菜单页所属模块目录名(modules/<m> 或 core/<m>)。
/**
 * @property hidden `true` = 可达但不进左侧菜单。深链与 knownSections 仍认它。
 *   不要靠「从这份目录里删掉」来藏页面,否则账号菜单里的入口会变成死按钮。
 */
export type NavMenuItem = { key: string; label: string; permission?: string; module?: string; hidden?: boolean }
/** 二级文件夹(本身不是页面,只收纳子菜单;可被功能开关按 `menu:<key>` 整个关掉) */
export type NavFolder = { key: string; label: string; children: NavMenuItem[] }
export type NavEntry = NavMenuItem | NavFolder
export type NavGroupCatalog = { key: string; label: string; items: NavEntry[] }

export function isNavFolder(entry: NavEntry): entry is NavFolder {
  return Array.isArray((entry as NavFolder).children)
}

/** 展开分组下全部叶子菜单(含文件夹内子项)。凡是「遍历所有页面」的地方都要用它,别直接 .items。 */
export function flattenNavItems(items: NavEntry[]): NavMenuItem[] {
  return items.flatMap((e) => (isNavFolder(e) ? e.children : [e]))
}

export const NAV_CATALOG: NavGroupCatalog[] = [
  {
    key: 'manufacturing',
    label: '制造工程',
    items: [
      { key: 'pcb-cam', label: 'PCB CAM', permission: 'pcb-cam:menu', module: 'pcb-cam' },
    ],
  },
  {
    key: 'biz',
    label: '工作',
    items: [
      // 收件箱:全员只看发给自己的通知,不设权限码。理由见 core/org/nav-permission-guard.ts。
      { key: 'notifications', label: '收件箱', module: 'inapp-notify' },
    ],
  },
  {
    key: 'sys',
    label: '系统管理',
    items: [
      { key: 'org', label: '组织及账号管理', permission: 'org:view', module: 'org' },
      { key: 'roles', label: '角色与权限', permission: 'org:manage', module: 'org' },
      { key: 'notify-config', label: '通知配置', permission: 'notify:config', module: 'notify' },
      { key: 'app-settings', label: '系统设置', permission: 'app-settings:manage', module: 'app-settings' },
      { key: 'audit', label: '审计日志', permission: 'audit:view', module: 'audit' },
      // 个人设置不进菜单,入口是右上角账号菜单。别从目录删掉,否则那个按钮会变成死链。
      { key: 'my-settings', label: '个人设置', module: 'org', hidden: true },
    ],
  },
]
