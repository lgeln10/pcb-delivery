// core/backup/api.ts — 数据库自动备份对外唯一入口。
// 本轮只有引擎与定时任务,没有 HTTP 路由/设置页(下一轮)。组合根只需调 registerBackupJobs()。
export { registerBackupJobs, runBackupTick, runBackupStaleCheck, runRestoreDrillTick } from './automation'
export { runBackupOnce, pruneOldBackups, reconcileMissingLocalObjects, isUniqueViolation, getBackupHealth, daysBetween, BACKUP_KEY_PREFIX, type BackupHealth, type BackupOutcome } from './service'
export { runRestoreDrill, type DrillOutcome, type DrillDetail, type DrillTableCheck, type DrillClient } from './restore-drill'
export { loadBackupConfig, localDateOf, localHourOf, localWeekdayOf, type BackupConfig } from './config'
export { planRetention, isWeeklyAnchor, isMonthlyAnchor, DEFAULT_LIMITS, BACKUP_VERDICTS, type BackupVerdict, type RetentionLimits, type RetentionPlan, type RetentionRow } from './retention'
export { verifyDump, SIZE_SHRINK_RATIO, ROW_SHRINK_RATIO, MIN_ROWS_FOR_RATIO, type VerifyInput, type VerifyResult } from './verify'
export { checkVersionCompat, parseDatabaseUrl, majorVersionOf, realPgTools, type PgTools, type PgConn, type Preflight } from './pg-tools'
export { dbBackupRuns, type DbBackupRun } from './model'
