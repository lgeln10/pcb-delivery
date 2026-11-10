// modules/notify/permissions.ts
import type { PermissionDef } from '../../core/org/api'

export const NOTIFY_PERMISSIONS: PermissionDef[] = [
  { code: 'notify:config', name: '配置通知渠道', module: 'notify', type: 'action' },
]
