// core/audit/api.ts — audit 对外接口唯一入口。
export { recordAudit, recordAuditSafe, resolveActorName, sanitizeDetail, listAudit, type AuditEntry, type AuditFilter } from './logic'
export { AUDIT_PERMISSIONS } from './permissions'
export type { AuditLog } from './model'
