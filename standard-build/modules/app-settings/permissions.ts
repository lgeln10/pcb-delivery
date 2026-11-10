// modules/app-settings/permissions.ts
import type { PermissionDef } from '../../core/org/api'

export const APP_SETTINGS_PERMISSIONS: PermissionDef[] = [
  { code: 'app-settings:manage', name: '系统设置', module: 'app-settings', type: 'action' },
]
