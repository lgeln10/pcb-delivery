// core/backup/service.ts
// 一次备份的编排:preflight → 采快照 → dump → 校验定级 → 落地 → 写台账 → 轮转。
//
// ★落地位置的选择(用户口径):**租户配了 OSS/TOS 就传上去,没配就落本地。**
//   实现上直接复用 core/storage 的 active_provider —— 不另起一套「备份专用存储配置」,
//   否则客户换存储时要改两处,迟早只改一处。
//
// ★但 local 分支**故意不走 putObject**:putObject 的 local 落点是 UPLOAD_DIR(用户上传文件),
//   把整库 dump 混进用户附件目录会同时坏两件事 —— 迁移工具(migrate.ts)会把它当业务文件搬,
//   而部署脚本按「uploads 是用户数据」在处理它。所以本地走独立的 BACKUP_DIR,云端才复用 putObject。
//
// ★backups/ 这个 key 前缀**绝不能进 PUBLIC_KEY_PREFIXES** —— 那等于宣布整库 dump 免登录可下载。
//   有一条测试专门钉住这句话(tests/public-prefix-guard.test.ts)。

import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { tenants } from '../org/model'
import { deleteObject, putObject, resolveActiveBackend } from '../storage/api'
import { loadBackupConfig, localDateOf, type BackupConfig } from './config'
import { dbBackupRuns } from './model'
import { checkVersionCompat, parseDatabaseUrl, realPgTools, sha256OfFile, type PgTools } from './pg-tools'
import { planRetention, type RetentionRow } from './retention'
import { verifyDump, type TableRowCounts } from './verify'

/** 云端对象 key 前缀。★不在 PUBLIC_KEY_PREFIXES 里,见文件头 */
export const BACKUP_KEY_PREFIX = 'backups'

/** 取行数快照的表数上限:够粗筛「大批量删除」,又不让快照本身变成负担 */
const ROW_COUNT_TABLES = 20

export type BackupOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; runId: string; verdict: 'ok' | 'suspect' | 'failed'; reasons: string[] }

export type RunBackupOptions = {
  now?: Date
  config?: BackupConfig
  tools?: PgTools
  /** 绕过「今天已备过」与 enabled 闸(手动触发用) */
  force?: boolean
}

// 进程内互斥。单 systemd 服务下这就够了;多进程/重启并发由 db_backup_runs_ok_per_day_uq 兜底。
let inFlight = false

/**
 * 关键表行数快照。用 `pg_stat_user_tables.n_live_tup`(数据库自带统计)取行数最多的若干张表 ——
 * ★它是**估计值**,准度依赖 autovacuum/analyze。选它而不是逐表 count(*) 的理由:零业务耦合
 * (不用硬编码表名,表改名也不会失灵)、恒定开销(大库上 20 次 count(*) 可能要几十秒)。
 * 对应地,它只用来**粗筛大批量删除**,不是精确对账 —— 阈值因此放到 80%(见 verify.ts)。
 */
async function snapshotRowCounts(db: Db): Promise<TableRowCounts> {
  // ★只取 public 这一个 schema,两个理由:
  //   ① `pg_stat_user_tables.relname` **不带 schema**,而恢复演练拿这个名字去 `public` 下点表 ——
  //      非 public 的表(如 `drizzle.__drizzle_migrations`)必然「查不到」,演练于是报 failed。
  //      2026-08-17 生产实测就这么误报过一次:20 张表 19 张行数分毫不差,只因为这一张而判失败。
  //      **假警报比没有警报更糟** —— 它教会人忽略这个告警。
  //   ② 快照的用途是粗筛「业务数据被大批删除」,迁移账本不是业务数据,本来也不该进来。
  const r = (await db.execute(sql`
    select relname, n_live_tup from pg_stat_user_tables
    where schemaname = 'public'
    order by n_live_tup desc limit ${ROW_COUNT_TABLES}
  `)) as { rows: Array<{ relname: string; n_live_tup: number | string }> }
  const out: TableRowCounts = {}
  for (const row of r.rows) out[row.relname] = Number(row.n_live_tup)
  return out
}

async function serverVersion(db: Db): Promise<string | null> {
  try {
    const r = (await db.execute(sql`show server_version`)) as { rows: Array<{ server_version: string }> }
    return r.rows[0]?.server_version ?? null
  } catch {
    return null
  }
}

/**
 * 上云时用哪个租户的对象存储配置。
 * ★这是本模块唯一一处「实例级的事要挑一个租户」的地方,所以把口径写死在这里:
 *   `BACKUP_STORAGE_TENANT_ID` 显式指定 > 最早创建的租户。AIOS 实际是每客户一套(单租户),
 *   这个选择在现实里没有歧义;但**如果哪天真出现多租户部署,dump 会进第一个租户的桶** ——
 *   那时必须显式配 env,别让它默默选。
 */
async function resolveBackupCtx(db: Db, cfg: BackupConfig): Promise<Ctx | null> {
  const rows = await db
    .select({ id: tenants.id, owner: tenants.ownerEmployeeId })
    .from(tenants)
    .where(cfg.storageTenantId ? and(eq(tenants.isDeleted, false), eq(tenants.id, cfg.storageTenantId)) : eq(tenants.isDeleted, false))
    .orderBy(tenants.createdAt)
    .limit(1)
  const t = rows[0]
  if (!t) return null
  // 以租户主的身份落地(storage_configs 首用时要写 created_by)
  return { tenantId: t.id, employeeId: t.owner ?? t.id }
}

/**
 * 上一份备份的对照基准。
 *
 * ★不限 `pruned_at`:对象删了,它记录的体量/行数依然是有效基准。
 *
 * ★**`suspect` 也算基准,只排除 `failed`。** 直觉上「拿可疑的那份当基准」不对,但反过来更糟:
 *   基准若只认 `ok`,那么任何**持续性的正常变化**(迁移删了一张大表、归档清掉一批历史日志)
 *   都会让此后**每一次**备份都相对那个冻住的旧基准判 suspect —— 天天同一条告警,
 *   而 suspect 不参与好备份额度,last-known-good 也跟着冻住。**一条永远在响的告警等于没有告警。**
 *   `failed` 排除掉是因为那种情况下 dump 本身就不完整,它的快照没有参考价值。
 *   代价:一次真实的骤降只会被报一次(第二天起就成了新常态)。可以接受 ——
 *   缓慢渗漏本来就低于阈值、两种口径都测不出;而突发骤降报一次是足够的,前提是那一次有人看。
 */
async function previousBaseline(db: Db): Promise<{ sizeBytes: number; rowCounts: TableRowCounts } | null> {
  const rows = await db
    .select({ sizeBytes: dbBackupRuns.sizeBytes, rowCounts: dbBackupRuns.rowCounts })
    .from(dbBackupRuns)
    .where(ne(dbBackupRuns.verdict, 'failed'))
    .orderBy(desc(dbBackupRuns.localDate), desc(dbBackupRuns.startedAt))
    .limit(1)
  const r = rows[0]
  if (!r) return null
  return { sizeBytes: Number(r.sizeBytes ?? 0), rowCounts: (r.rowCounts as TableRowCounts | null) ?? {} }
}

export async function runBackupOnce(db: Db, opts: RunBackupOptions = {}): Promise<BackupOutcome> {
  const cfg = opts.config ?? loadBackupConfig()
  const now = opts.now ?? new Date()
  const tools = opts.tools ?? realPgTools()
  if (!cfg.enabled && !opts.force) return { status: 'skipped', reason: '未启用(BACKUP_ENABLED=0)' }

  const localDate = localDateOf(now, cfg.timeZone)
  if (!opts.force) {
    // ★`isNull(prunedAt)` 不能少:今天那份如果被轮转掉或**丢了**,就等于今天没有备份,
    //   下一个 tick 应该重备一次。少了这半句,「备份丢了」会连带变成「今天不许再有备份」,
    //   要熬到过午夜才自愈(2026-08-17 生产实测踩到)。
    const done = await db
      .select({ id: dbBackupRuns.id })
      .from(dbBackupRuns)
      .where(and(eq(dbBackupRuns.localDate, localDate), eq(dbBackupRuns.verdict, 'ok'), isNull(dbBackupRuns.prunedAt)))
      .limit(1)
    if (done[0]) return { status: 'skipped', reason: `${localDate} 已有成功备份` }
  }

  const conn = parseDatabaseUrl(process.env.DATABASE_URL)
  // ★没有 DATABASE_URL = 这台根本不是接真库跑的(本机 demo / 内存库)。这不是备份失败,
  //   所以 skip 而不是写 failed 行 —— 否则本机开发每天刷一条红,真失败反而被淹没。
  if (!conn) return { status: 'skipped', reason: '没有 DATABASE_URL(非真库模式)' }

  if (inFlight) return { status: 'skipped', reason: '上一轮备份还在跑' }
  inFlight = true
  const startedAt = now
  try {
    const [dumpVersion, srvVersion] = await Promise.all([tools.toolVersion(cfg.pgDump), serverVersion(db)])
    const pre = checkVersionCompat(dumpVersion, srvVersion)
    if (!pre.ok) {
      return await writeRun(db, {
        localDate,
        startedAt,
        now,
        verdict: 'failed',
        reasons: [pre.reason ?? 'preflight 未通过'],
        error: pre.reason ?? null,
        pgDumpVersion: dumpVersion,
        pgServerVersion: srvVersion,
      })
    }

    const rowCounts = await snapshotRowCounts(db)
    const tmpDir = join(cfg.dir, '.tmp')
    await mkdir(tmpDir, { recursive: true })
    const fileName = `${conn.database}-${localDate}-${String(startedAt.getTime())}.dump`
    const tmpFile = join(tmpDir, fileName)

    const dumped = await tools.dump(cfg.pgDump, conn, tmpFile)
    const sizeBytes = await stat(tmpFile).then((s) => s.size).catch(() => 0)
    const listed = dumped.exitCode === 0 && sizeBytes > 0
      ? await tools.listObjects(cfg.pgRestore, tmpFile)
      : { ok: false, objects: 0, stderr: '' }

    const graded = verifyDump({
      dumpExitCode: dumped.exitCode,
      dumpStderr: dumped.stderr,
      sizeBytes,
      restoreListOk: listed.ok,
      restoreListObjects: listed.objects,
      rowCounts,
      prev: await previousBaseline(db),
    })

    if (graded.verdict === 'failed') {
      await rm(tmpFile, { force: true })
      return await writeRun(db, {
        localDate,
        startedAt,
        now,
        verdict: 'failed',
        reasons: graded.reasons,
        error: dumped.stderr.trim().slice(0, 2000) || null,
        dumpExitCode: dumped.exitCode,
        sizeBytes,
        restoreListObjects: listed.objects,
        rowCounts,
        pgDumpVersion: dumpVersion,
        pgServerVersion: srvVersion,
      })
    }

    const sha256 = await sha256OfFile(tmpFile)
    const placed = await placeDump(db, cfg, tmpFile, fileName, sizeBytes)

    // ★台账写不成时,刚落地的对象就是孤儿(盘上有文件、账上没有行)—— 必须当场收掉。
    //   这不只针对唯一索引冲突:**任何**写库失败都要收,否则每失败一次就留一份没人认领的
    //   整库 dump 占着磁盘,而对账函数只认得「账上有、盘上没有」那个方向,看不见这一种。
    let written: BackupOutcome
    try {
      written = await writeRun(db, {
        localDate,
        startedAt,
        now,
        verdict: graded.verdict,
        reasons: graded.reasons,
        dumpExitCode: dumped.exitCode,
        sizeBytes,
        sha256,
        restoreListObjects: listed.objects,
        rowCounts,
        location: placed.location,
        objectKey: placed.objectKey,
        uploadSkipped: placed.uploadSkipped,
        pgDumpVersion: dumpVersion,
        pgServerVersion: srvVersion,
      })
    } catch (err) {
      await removeObject(db, cfg, placed.location, placed.objectKey)
      throw err
    }
    // 撞上「一天一份 ok」的唯一索引 → 别的进程已经备好了,这份是多余的,收掉
    if (written.status === 'skipped') await removeObject(db, cfg, placed.location, placed.objectKey)
    else await pruneOldBackups(db, cfg)
    return written
  } finally {
    inFlight = false
  }
}

type PlacedDump = { location: 'local' | 'oss' | 'tos'; objectKey: string; uploadSkipped: boolean }

async function placeDump(db: Db, cfg: BackupConfig, tmpFile: string, fileName: string, sizeBytes: number): Promise<PlacedDump> {
  const ctx = await resolveBackupCtx(db, cfg)
  // ★读不出存储配置就只能落本地 —— 但**必须留痕**:主密钥换了、配置被删,表现都是
  //   「备份悄悄从上云退回单机」,而面板上一切正常。体量闸那条有 uploadSkipped 记账,这条原先什么都没有。
  const backend = ctx
    ? await resolveActiveBackend(db, ctx).catch((err) => {
        console.error('[backup] 读不出存储配置,这次只能落本地:', err instanceof Error ? err.message : err)
        return null
      })
    : null
  const cloud = backend && (backend.provider === 'oss' || backend.provider === 'tos')
  // ★体量闸:putObject 只吃 Buffer(core/storage 没有流式口),几个 G 的 dump 整个进内存
  //   会在内存紧张的机器上把进程打挂。超了就只落本地,并把这件事记进台账(uploadSkipped)。
  const tooBig = sizeBytes > cfg.maxUploadBytes
  if (cloud && ctx && !tooBig) {
    const bytes = await readFile(tmpFile)
    const stored = await putObject(db, ctx, {
      bytes,
      filename: fileName,
      contentType: 'application/octet-stream',
      keyPrefix: BACKUP_KEY_PREFIX,
      visibility: 'private',
    })
    await rm(tmpFile, { force: true })
    return { location: backend.provider as 'oss' | 'tos', objectKey: stored.key, uploadSkipped: false }
  }
  await mkdir(cfg.dir, { recursive: true })
  await rename(tmpFile, join(cfg.dir, fileName))
  return { location: 'local', objectKey: fileName, uploadSkipped: Boolean(cloud) && tooBig }
}

async function removeObject(db: Db, cfg: BackupConfig, location: string | null, objectKey: string | null): Promise<void> {
  if (!objectKey) return
  try {
    if (location === 'local') await rm(join(cfg.dir, objectKey), { force: true })
    else {
      const ctx = await resolveBackupCtx(db, cfg)
      if (ctx) await deleteObject(db, ctx, objectKey)
    }
  } catch (err) {
    // 删不掉只是多占盘,不该让整轮备份失败 —— 但要留声
    console.error('[backup] 清理备份对象失败:', err instanceof Error ? err.message : err)
  }
}

type WriteRunInput = {
  localDate: string
  startedAt: Date
  now: Date
  verdict: 'ok' | 'suspect' | 'failed'
  reasons: string[]
  error?: string | null
  dumpExitCode?: number
  sizeBytes?: number
  sha256?: string
  restoreListObjects?: number
  rowCounts?: TableRowCounts
  location?: 'local' | 'oss' | 'tos'
  objectKey?: string
  uploadSkipped?: boolean
  pgDumpVersion?: string | null
  pgServerVersion?: string | null
}

async function writeRun(db: Db, i: WriteRunInput): Promise<BackupOutcome> {
  const finishedAt = new Date()
  try {
    const rows = await db
      .insert(dbBackupRuns)
      .values({
        localDate: i.localDate,
        startedAt: i.startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - i.startedAt.getTime(),
        verdict: i.verdict,
        location: i.location ?? null,
        objectKey: i.objectKey ?? null,
        sizeBytes: i.sizeBytes ?? null,
        sha256: i.sha256 ?? null,
        dumpExitCode: i.dumpExitCode ?? null,
        restoreListObjects: i.restoreListObjects ?? null,
        rowCounts: i.rowCounts ?? null,
        reasons: i.reasons,
        error: i.error ?? null,
        pgServerVersion: i.pgServerVersion ?? null,
        pgDumpVersion: i.pgDumpVersion ?? null,
        uploadSkipped: i.uploadSkipped ?? false,
      })
      .returning({ id: dbBackupRuns.id })
    return { status: 'done', runId: rows[0]!.id, verdict: i.verdict, reasons: i.reasons }
  } catch (err) {
    // 唯一索引撞车 = 别的进程今天已经备成功了。不是错误,是并发被正确挡住。
    if (isUniqueViolation(err)) return { status: 'skipped', reason: `${i.localDate} 已有成功备份(并发)` }
    throw err
  }
}

/**
 * 是不是唯一索引冲突(PG 23505)。
 *
 * ★必须**沿着 cause 链**找,不能只看最外层 message:drizzle 把驱动的错误包了一层,
 *   外层只剩 `Failed query: insert into "db_backup_runs" …`,既没有 `duplicate key`
 *   也没有索引名。2026-08-17 生产实测就栽在这:原来只匹配外层 message,于是并发兜底那条路
 *   不是返回 skipped 而是**直接抛出去** —— dump 文件已经落地、台账行没写成,留下一个孤儿文件。
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, hop = 0; e && hop < 5; e = (e as { cause?: unknown }).cause, hop++) {
    if (typeof e === 'object' && (e as { code?: string }).code === '23505') return true
    const msg = e instanceof Error ? e.message : ''
    if (/db_backup_runs_ok_per_day_uq|duplicate key|unique constraint/i.test(msg)) return true
  }
  return false
}

/**
 * 对账:台账说还在、盘上却找不到的本地备份,标成已丢失。
 *
 * ★2026-08-17 真发生过:CI 发版那条 `rsync -az --delete` 没排除 `backups/`,当天备好的 dump
 *   被下一次发版整个删掉,而台账那行 `pruned_at` 仍是 null —— 于是 `getBackupHealth` 报
 *   「现存 1 份」,面板看着一切正常,盘上其实一份都没有。**备份系统撒的谎比没有备份更危险。**
 *   工作流那条 exclude 已经补上,但「台账与磁盘对不上」这件事本身要能自愈,否则下次换个原因
 *   (手工清理、换盘、改 BACKUP_DIR)又会出现同样的谎。
 *
 * ★只对 `location='local'` 判定:本地能 stat 出确定答案。云端读不到可能只是网络抖动,
 *   把它当「丢了」会把好备份从账上抹掉 —— 宁可漏报,不可误杀。
 */
export async function reconcileMissingLocalObjects(db: Db, cfg: BackupConfig = loadBackupConfig()): Promise<{ lost: number }> {
  const rows = await db
    .select({ id: dbBackupRuns.id, objectKey: dbBackupRuns.objectKey })
    .from(dbBackupRuns)
    .where(and(isNull(dbBackupRuns.prunedAt), eq(dbBackupRuns.location, 'local'), sql`${dbBackupRuns.objectKey} is not null`))
  let lost = 0
  for (const r of rows) {
    if (await stat(join(cfg.dir, r.objectKey!)).then(() => true).catch(() => false)) continue
    await db
      .update(dbBackupRuns)
      .set({ prunedAt: new Date(), prunedReason: '对象已丢失(台账说在,盘上找不到)' })
      .where(eq(dbBackupRuns.id, r.id))
    lost++
  }
  if (lost > 0) console.error(`[backup] ${lost} 份备份的文件在盘上找不到了,已在台账标记丢失。查 BACKUP_DIR 是否被发版/清理脚本删过。`)
  return { lost }
}

/** 轮转:先对账(台账与磁盘)→ 算保留计划 → 删对象 → 台账行标 pruned_at(行永不删) */
export async function pruneOldBackups(db: Db, cfg: BackupConfig = loadBackupConfig()): Promise<{ pruned: number; lost: number }> {
  // ★先对账再算保留:否则「已经丢了的那份」会占着日备额度,把真正还在的那份挤下去
  const { lost } = await reconcileMissingLocalObjects(db, cfg)
  const live = await db
    .select({
      id: dbBackupRuns.id,
      localDate: dbBackupRuns.localDate,
      verdict: dbBackupRuns.verdict,
      sizeBytes: dbBackupRuns.sizeBytes,
      location: dbBackupRuns.location,
      objectKey: dbBackupRuns.objectKey,
      restoreVerdict: dbBackupRuns.restoreVerdict,
    })
    .from(dbBackupRuns)
    .where(and(isNull(dbBackupRuns.prunedAt), sql`${dbBackupRuns.objectKey} is not null`))

  const rows: RetentionRow[] = live.map((r) => ({
    id: r.id,
    localDate: String(r.localDate),
    verdict: r.verdict as RetentionRow['verdict'],
    sizeBytes: Number(r.sizeBytes ?? 0),
    // ★只有 'passed' 才算验过。NULL(没演练过)与 'failed' 都不是 —— 三态不许压成两态。
    restoreVerified: r.restoreVerdict === 'passed',
  }))
  const plan = planRetention(rows, cfg.limits)
  const byId = new Map(live.map((r) => [r.id, r]))
  let pruned = 0
  for (const p of plan.prune) {
    const row = byId.get(p.id)
    if (!row) continue
    await removeObject(db, cfg, row.location, row.objectKey)
    await db.update(dbBackupRuns).set({ prunedAt: new Date(), prunedReason: p.reason }).where(eq(dbBackupRuns.id, p.id))
    pruned++
  }
  return { pruned, lost }
}

export type BackupHealth = {
  enabled: boolean
  lastOkAt: Date | null
  lastOkDate: string | null
  /** 距上次成功备份多少天;从未成功过为 null */
  daysSinceOk: number | null
  stale: boolean
  liveCount: number
  liveBytes: number
  /** 最近一次备份(任何 verdict)的台账行 id;一次都没跑过为 null */
  lastRunId: string | null
  /** 最近一次**恢复演练通过**的时刻;从未演练通过为 null。
   *  ★null 只代表「没验过」,不代表「验过没通过」—— 展示时别把它写成「验证失败」。 */
  lastRestoreVerifiedAt: Date | null
  /** 现存备份里有几份是真恢复过的 */
  restoreVerifiedCount: number
}

/** 面板/告警共用的一份健康度。★「有没有在备」必须能被一眼看到 —— 备份最经典的死法是没人发现它停了。 */
export async function getBackupHealth(db: Db, cfg: BackupConfig = loadBackupConfig(), now: Date = new Date()): Promise<BackupHealth> {
  const okRows = await db
    .select({ localDate: dbBackupRuns.localDate, finishedAt: dbBackupRuns.finishedAt })
    .from(dbBackupRuns)
    .where(eq(dbBackupRuns.verdict, 'ok'))
    .orderBy(desc(dbBackupRuns.localDate), desc(dbBackupRuns.startedAt))
    .limit(1)
  const live = await db
    .select({ sizeBytes: dbBackupRuns.sizeBytes, restoreVerdict: dbBackupRuns.restoreVerdict })
    .from(dbBackupRuns)
    .where(and(isNull(dbBackupRuns.prunedAt), sql`${dbBackupRuns.objectKey} is not null`))
  const verifiedRows = await db
    .select({ at: dbBackupRuns.restoreVerifiedAt })
    .from(dbBackupRuns)
    .where(eq(dbBackupRuns.restoreVerdict, 'passed'))
    .orderBy(desc(dbBackupRuns.restoreVerifiedAt))
    .limit(1)
  const lastRun = await db
    .select({ id: dbBackupRuns.id })
    .from(dbBackupRuns)
    .orderBy(desc(dbBackupRuns.startedAt))
    .limit(1)

  const lastOkDate = okRows[0] ? String(okRows[0].localDate) : null
  const today = localDateOf(now, cfg.timeZone)
  const daysSinceOk = lastOkDate ? daysBetween(lastOkDate, today) : null
  return {
    enabled: cfg.enabled,
    lastOkAt: okRows[0]?.finishedAt ?? null,
    lastOkDate,
    daysSinceOk,
    stale: daysSinceOk == null || daysSinceOk >= cfg.staleAlertDays,
    liveCount: live.length,
    liveBytes: live.reduce((s, r) => s + Number(r.sizeBytes ?? 0), 0),
    lastRunId: lastRun[0]?.id ?? null,
    lastRestoreVerifiedAt: verifiedRows[0]?.at ?? null,
    restoreVerifiedCount: live.filter((r) => r.restoreVerdict === 'passed').length,
  }
}

/** 两个 `YYYY-MM-DD` 差几天。★按 UTC 午夜算,与运行机器时区无关(同 retention.isWeeklyAnchor) */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}
