// core/backup/model.ts
// 数据库备份台账(1 张表)。
//
// ★**没有 tenant_id**,这是对全局公共字段的一处**有意例外**(同 core/db/common-fields.ts 里
//   「tenant 是隔离根 / permission 是系统级清单」那两条)。理由:一次 pg_dump 覆盖的是整个数据库、
//   所有租户,没有任何一个租户「拥有」这一行。硬塞一个 tenant_id 会让人误以为备份是按租户做的,
//   进而写出「只备份本租户」这种做不到的代码。
//
// ★**没有 is_deleted**。台账不是业务实体,行永远不删:对象被轮转清掉时只写 pruned_at,
//   历史行留着回答「上个月 3 号那份备份后来去哪了」。
//
// ★**不存 tier(日/周/月)与 pinned**。档位与「钉住哪一份」全部由 (local_date, verdict) 现算,
//   见 retention.ts 顶部注释 —— 存派生状态就会漂移,而漂移只在你真要恢复的那天才暴露。
import { sql } from 'drizzle-orm'
import { bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const dbBackupRuns = pgTable(
  'db_backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 本地日历日(按 BACKUP_TZ 算,见 config.ts):幂等键 + 分层保留的锚点判定都用它 */
    localDate: date('local_date').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    /** ok / suspect / failed —— 只有 ok 参与好备份的额度(见 retention.ts) */
    verdict: text('verdict').notNull(),
    /** local / oss / tos;failed 不落地,为 null */
    location: text('location'),
    /** local=相对 BACKUP_DIR 的文件名;oss/tos=对象 key */
    objectKey: text('object_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    dumpExitCode: integer('dump_exit_code'),
    restoreListObjects: integer('restore_list_objects'),
    /** 关键表行数快照(估计值,见 service.ts 取数注释):下一份备份拿它当对照基准 */
    rowCounts: jsonb('row_counts'),
    /** suspect/failed 的原因数组(给人看的中文短句) */
    reasons: jsonb('reasons'),
    error: text('error'),
    pgServerVersion: text('pg_server_version'),
    pgDumpVersion: text('pg_dump_version'),
    /** 体量超闸没能上云、只落了本地 —— 这行为要能被查出来,不能只写在日志里 */
    uploadSkipped: boolean('upload_skipped').notNull().default(false),
    // ── 恢复演练(0207,见 restore-drill.ts)────────────────────────────────
    // ★三态,不许压成两态:NULL=还没演练过 / 'passed'=真的恢复出来过 / 'failed'=恢复不出来。
    //   把 NULL 当 passed 渲染,就是「把没检查过说成检查通过」;当 failed 告警则是天天狼来了。
    restoreVerifiedAt: timestamp('restore_verified_at', { withTimezone: true }),
    restoreVerdict: text('restore_verdict'),
    restoreDetail: jsonb('restore_detail'),
    /** 对象已被轮转删除(行保留做台账) */
    prunedAt: timestamp('pruned_at', { withTimezone: true }),
    prunedReason: text('pruned_reason'),
  },
  (t) => [
    index('db_backup_runs_date_idx').on(t.localDate),
    // 还活着的备份(对象没被清)按 verdict 找,轮转与「上一份 ok」都走这条
    index('db_backup_runs_live_idx').on(t.verdict).where(sql`pruned_at is null`),
    // 找「最近一份真恢复过的备份」(保留计划每轮都要查,见 retention.ts 的 restore-verified 钉子)
    index('db_backup_runs_restore_verified_idx')
      .on(t.restoreVerifiedAt)
      .where(sql`restore_verdict = 'passed' and pruned_at is null`),
    // ★幂等兜底:同一个本地日历日至多一份**还活着的**成功备份。进程内还有一道 inFlight 闸
    //   (见 service.ts),这条索引是多进程/重启并发下的最后一道 —— 撞上了就丢弃这次 dump。
    //   ★`pruned_at is null` 这半句不能少(0208 补):不加的话,当天那份被轮转掉或丢失之后,
    //   **同一天再也备不了第二次** —— 「备份丢了」会连带变成「今天不许再有备份」,要等过午夜才自愈。
    uniqueIndex('db_backup_runs_ok_per_day_uq').on(t.localDate).where(sql`verdict = 'ok' and pruned_at is null`),
  ],
)

export type DbBackupRun = typeof dbBackupRuns.$inferSelect
