// core/backup/config.ts
// 备份配置:全部来自 env(本轮没有设置页,UI 下一轮)。
// ★备份是**实例级**的 —— 一次 dump 覆盖整个数据库、所有租户 —— 所以配置不入库、不分租户。
//   唯一一处要「挑一个租户」的地方是上云用谁的对象存储配置,见 service.ts 的 resolveBackupTenantId。

import { resolve } from 'node:path'
import { DEFAULT_LIMITS, type RetentionLimits } from './retention'

export type BackupConfig = {
  enabled: boolean
  /** 本地落地目录(local 存储后端,或云端上传被体量闸挡下时的兜底) */
  dir: string
  /** 每天几点跑(本地小时,0-23) */
  hour: number
  /** 算「本地日历日」用的时区。★不能用 toISOString:东八区凌晨 3 点备份,UTC 还在前一天,
   *  幂等键会算成昨天,于是同一天跑两次、而某一天一次都不跑(CI 跑 UTC 恰好正确,生产歪)。 */
  timeZone: string
  limits: RetentionLimits
  /** 超过这个字节数就不上云,只落本地。putObject 只吃 Buffer(没有流式口),
   *  几个 G 的 dump 整个进内存会在内存紧张的机器上把进程打挂。 */
  maxUploadBytes: number
  /** 连续这么多天没有成功备份就告警 */
  staleAlertDays: number
  /** 二进制路径可覆盖(同机多版本 PG 客户端时用) */
  pgDump: string
  pgRestore: string
  // ── 恢复演练(restore-drill.ts)────────────────────────────────────────────
  drillEnabled: boolean
  /** 周几跑(0=周日),默认周日 —— 挑一周里最闲的时候,它会建一个和原库同样大的临时库 */
  drillWeekday: number
  /** 几点跑(本地小时)。默认排在备份点之后两小时,让当天那份先备完 */
  drillHour: number
  /** dump 超过这个字节数就跳过演练:临时库约等于原库大小,别把磁盘撑爆。
   *  ★超限是 skipped 不是 failed —— 备份没问题,是这台机跑不动这个演练。 */
  drillMaxBytes: number
  /** 上云时用哪个租户的存储配置;不设则取最早创建的租户 */
  storageTenantId: string | null
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

export function loadBackupConfig(): BackupConfig {
  const maxTotal = int('BACKUP_MAX_TOTAL_BYTES', 0)
  return {
    // ★默认开。备份这件事的经典死法是「以为在备,其实从来没开过」,所以默认值站在「开」这一侧;
    //   跑不起来(比如 pg_dump 版本不兼容)会留下 failed 台账行并告警,而不是静默什么都不做。
    enabled: bool('BACKUP_ENABLED', true),
    dir: resolve(process.cwd(), process.env.BACKUP_DIR || 'backups'),
    hour: Math.min(23, Math.max(0, int('BACKUP_HOUR', 3))),
    timeZone: process.env.BACKUP_TZ || process.env.TZ || 'Asia/Shanghai',
    limits: {
      daily: Math.max(1, int('BACKUP_KEEP_DAILY', DEFAULT_LIMITS.daily)),
      weekly: Math.max(0, int('BACKUP_KEEP_WEEKLY', DEFAULT_LIMITS.weekly)),
      monthly: Math.max(0, int('BACKUP_KEEP_MONTHLY', DEFAULT_LIMITS.monthly)),
      bad: Math.max(0, int('BACKUP_KEEP_BAD', DEFAULT_LIMITS.bad)),
      maxTotalBytes: maxTotal > 0 ? maxTotal : null,
    },
    maxUploadBytes: int('BACKUP_MAX_UPLOAD_BYTES', 512 * 1024 * 1024),
    staleAlertDays: Math.max(1, int('BACKUP_STALE_ALERT_DAYS', 2)),
    pgDump: process.env.BACKUP_PG_DUMP || 'pg_dump',
    pgRestore: process.env.BACKUP_PG_RESTORE || 'pg_restore',
    storageTenantId: process.env.BACKUP_STORAGE_TENANT_ID || null,
    drillEnabled: bool('BACKUP_DRILL_ENABLED', true),
    drillWeekday: Math.min(6, Math.max(0, int('BACKUP_DRILL_WEEKDAY', 0))),
    drillHour: Math.min(23, Math.max(0, int('BACKUP_DRILL_HOUR', 5))),
    drillMaxBytes: int('BACKUP_DRILL_MAX_BYTES', 2 * 1024 * 1024 * 1024),
  }
}

/** 该时区下的星期几(0=周日)。★与 retention 的锚点同源口径:算的是**日历日**的星期几 */
export function localWeekdayOf(at: Date, timeZone: string): number {
  return new Date(`${localDateOf(at, timeZone)}T00:00:00Z`).getUTCDay()
}

/** `YYYY-MM-DD`,按给定时区算 —— 全模块只有这一处把时刻换成日历日 */
export function localDateOf(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  return parts // en-CA 的格式就是 YYYY-MM-DD
}

/** 该时区下的小时(0-23) */
export function localHourOf(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(at))
}
