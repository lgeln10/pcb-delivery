// core/org/permissions.ts
// org 自身的权限点(组织/员工/角色管理)。
import type { PermissionDef } from './api'

export const ORG_PERMISSIONS: PermissionDef[] = [
  { code: 'org:view', name: '查看组织/员工', module: 'org', type: 'action' },
  { code: 'org:manage', name: '管理组织/员工/角色', module: 'org', type: 'action' },
]
