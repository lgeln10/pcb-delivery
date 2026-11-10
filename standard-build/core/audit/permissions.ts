// core/audit/permissions.ts
import type { PermissionDef } from '../org/api'

export const AUDIT_PERMISSIONS: PermissionDef[] = [
  { code: 'audit:view', name: '查看审计日志', module: 'audit', type: 'action' },
]
