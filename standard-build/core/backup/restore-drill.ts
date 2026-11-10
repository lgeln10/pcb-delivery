// core/backup/restore-drill.ts
// 恢复演练:把最近一份 ok 的 dump **真的恢复进一个临时库**,点几张表的行数,然后把临时库删掉。
//
// ★为什么必须有这一步:「没试过恢复的备份不算备份」。`verdict='ok'` 只说明 dump 跑完了、
//   清单读得回来 —— 那和「真能恢复出数据」之间隔着一整类失败(权限、扩展缺失、编码、
//   pg_restore 版本、dump 中途被截断但头部完好)。这些只有真恢复一遍才会暴露。
//
// ★三态不许压成两态:`restore_verdict` 是 NULL(没演练过)/ passed / failed。
//   把 NULL 当 passed 渲染就是「把没检查过说成检查通过」;当 failed 告警则是天天狼来了。
//
// ★★这个文件会在**生产数据库服务器上建库、删库**,所以下面三条是硬约束:
//   1. 临时库名恒为 `aios_restore_drill_<毫秒时间戳>`,删库前**再断言一次**名字匹配该模式
//      —— 变量拼错、参数传反时,宁可抛错也不能删到别的库;
//   2. 建/删库走**独立的短命连接**(连 maintenance 库),不碰应用自己的连接池
//      —— CREATE DATABASE 不能在事务里跑,而应用池的行为不该由这里假设;
//   3. 删库放 finally,任何一步炸了都要把临时库收干净,否则每周漏一个库、磁盘慢慢被吃光。
//
// ★「演练跑不了」与「备份恢复不出来」是两件事,必须分开报:
//   没有 CREATE DATABASE 权限、磁盘不够、dump 太大 → `skipped`(带原因),**不是** failed。
//   混为一谈的话,交付到一个权限受限的客户环境上,就会每周一条「备份恢复失败」的假警报。

import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { readObject } from '../storage/api'
import { loadBackupConfig, type BackupConfig } from './config'
import { dbBackupRuns } from './model'
import { parseDatabaseUrl, realPgTools, type PgConn, type PgTools } from './pg-tools'
import type { TableRowCounts } from './verify'

/** 临时库名的唯一合法形状。建与删都按它校验 —— 删库前那次校验是最后一道保险。 */
const DRILL_DB_RE = /^aios_restore_drill_\d+$/

export type DrillTableCheck = { table: string; expected: number; actual: number | null }

export type DrillDetail = {
  restoreExitCode: number
  restoreStderr?: string
  tables: DrillTableCheck[]
  /** 判 failed 的硬问题(表没了 / 期望有数据却是空的) */
  problems: string[]
  /** 只记录不判失败的偏差(行数快照本来就是估计值) */
  notes: string[]
  durationMs: number
  tempDatabase: string
}

export type DrillOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'done'; runId: string; verdict: 'passed' | 'failed'; detail: DrillDetail }

/**
 * PG `42P01 = undefined_table`。★这是唯一能证明「表真的不在恢复出来的库里」的信号。
 * 别的任何查询失败(连接断了、权限不对)都**不是**这件事 —— 把它们混为一谈,
 * 一次连接抖动就会被报成「这份备份恢复不出来」,又是一条假警报。
 */
function isUndefinedTable(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === '42P01') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /relation .+ does not exist/i.test(msg)
}

/** 行数与快照差多少算「值得记一笔」(不判失败)。n_live_tup 是估计值,见 service.snapshotRowCounts */
const ROW_DRIFT_TOLERANCE = 0.2

type DrillDeps = {
  tools?: PgTools
  /** 开一个连到指定库的短命客户端。抽出来是为了能在测试里替换掉(真连接需要真 PG) */
  openClient?: (conn: PgConn, database: string) => Promise<DrillClient>
}

export type DrillClient = {
  /** params 走占位符($1…)。库名/表名是标识符,PG 不允许参数化,只能拼 —— 那两处各有自己的护栏。 */
  query(text: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>
  end(): Promise<void>
}

/** 默认实现:node-postgres 的短命 Client。★不复用应用连接池,理由见文件头第 2 条。 */
async function openPgClient(conn: PgConn, database: string): Promise<DrillClient> {
  const { Client } = await import('pg')
  const c = new Client({ host: conn.host, port: conn.port, user: conn.user, password: conn.password, database })
  await c.connect()
  return {
    query: async (text: string, params?: unknown[]) => (await c.query(text, params)).rows as Array<Record<string, unknown>>,
    end: () => c.end(),
  }
}

/** 把待演练的 dump 落到本地一个临时文件;本地存的直接用原路径(不复制) */
async function materialize(db: Db, cfg: BackupConfig, row: { location: string | null; objectKey: string | null }): Promise<{ path: string; temp: boolean } | null> {
  if (!row.objectKey) return null
  if (row.location === 'local') {
    const p = join(cfg.dir, row.objectKey)
    return (await stat(p).catch(() => null)) ? { path: p, temp: false } : null
  }
  // 云端:读回字节再落盘。★同 service.placeDump 的体量闸 —— readObject 也是整个进内存。
  const ctx = await drillStorageCtx(db, cfg)
  if (!ctx) return null
  const bytes = await readObject(db, ctx, row.objectKey)
  const dir = join(cfg.dir, '.tmp')
  await mkdir(dir, { recursive: true })
  const p = join(dir, `drill-${row.objectKey.split('/').pop()}`)
  await writeFile(p, bytes)
  return { path: p, temp: true }
}

/** 与 service.resolveBackupCtx 同口径(上云用谁的存储配置,取回来也用谁的) */
async function drillStorageCtx(db: Db, cfg: BackupConfig): Promise<Ctx | null> {
  const { tenants } = await import('../org/model')
  const rows = await db
    .select({ id: tenants.id, owner: tenants.ownerEmployeeId })
    .from(tenants)
    .where(cfg.storageTenantId ? and(eq(tenants.isDeleted, false), eq(tenants.id, cfg.storageTenantId)) : eq(tenants.isDeleted, false))
    .orderBy(tenants.createdAt)
    .limit(1)
  const t = rows[0]
  return t ? { tenantId: t.id, employeeId: t.owner ?? t.id } : null
}

/**
 * 跑一次恢复演练。目标 = **最近一份还活着的 ok 备份** —— 那正是真出事时你会去恢复的那一份,
 * 所以验它才有意义(验一份早晚要被轮转掉的老备份是白验)。
 * 已经验过的就不重复验(`force` 可绕过)。
 */
export async function runRestoreDrill(
  db: Db,
  opts: { now?: Date; config?: BackupConfig; force?: boolean } & DrillDeps = {},
): Promise<DrillOutcome> {
  const cfg = opts.config ?? loadBackupConfig()
  const now = opts.now ?? new Date()
  const tools = opts.tools ?? realPgTools()
  const openClient = opts.openClient ?? openPgClient
  if (!cfg.drillEnabled && !opts.force) return { status: 'skipped', reason: '未启用(BACKUP_DRILL_ENABLED=0)' }

  const conn = parseDatabaseUrl(process.env.DATABASE_URL)
  if (!conn) return { status: 'skipped', reason: '没有 DATABASE_URL(非真库模式)' }

  const rows = await db
    .select({
      id: dbBackupRuns.id,
      localDate: dbBackupRuns.localDate,
      location: dbBackupRuns.location,
      objectKey: dbBackupRuns.objectKey,
      sizeBytes: dbBackupRuns.sizeBytes,
      rowCounts: dbBackupRuns.rowCounts,
      restoreVerdict: dbBackupRuns.restoreVerdict,
    })
    .from(dbBackupRuns)
    .where(and(eq(dbBackupRuns.verdict, 'ok'), isNull(dbBackupRuns.prunedAt), sql`${dbBackupRuns.objectKey} is not null`))
    .orderBy(desc(dbBackupRuns.localDate), desc(dbBackupRuns.startedAt))
    .limit(1)
  const target = rows[0]
  if (!target) return { status: 'skipped', reason: '没有可演练的备份(一份存活的 ok 都没有)' }
  if (target.restoreVerdict && !opts.force) return { status: 'skipped', reason: `最近一份备份(${target.localDate})已演练过:${target.restoreVerdict}` }

  const size = Number(target.sizeBytes ?? 0)
  // 临时库大致等于原库大小,所以体量闸拦的是「演练本身把磁盘撑爆」——
  // 这是 skipped 不是 failed:备份没问题,是这台机跑不动这个演练。
  if (size > cfg.drillMaxBytes) {
    return { status: 'skipped', reason: `dump ${size} 字节超过演练上限 ${cfg.drillMaxBytes}(BACKUP_DRILL_MAX_BYTES)` }
  }

  const file = await materialize(db, cfg, target)
  if (!file) return { status: 'skipped', reason: '备份对象取不到(本地文件已不在,或云端读取失败)' }

  const tempDb = `aios_restore_drill_${now.getTime()}`
  if (!DRILL_DB_RE.test(tempDb)) return { status: 'skipped', reason: '临时库名不合法(不该发生)' }

  const startedAt = Date.now()
  let admin: DrillClient | null = null
  let created = false
  try {
    // maintenance 库:连 'postgres';没有它就退回连自己(CREATE DATABASE 从哪个库发都行)
    admin = await openClient(conn, 'postgres').catch(() => openClient(conn, conn.database))
    await admin.query(`create database ${tempDb}`)
    created = true
  } catch (err) {
    await cleanup(file, admin, false, tempDb)
    // 建不了库 = 演练跑不了(权限/磁盘),**不是**备份坏了
    return { status: 'skipped', reason: `建不了临时库:${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    const restored = await tools.restoreInto(cfg.pgRestore, conn, tempDb, file.path)
    const expected = (target.rowCounts as TableRowCounts | null) ?? {}
    const checks: DrillTableCheck[] = []
    const problems: string[] = []
    const notes: string[] = []

    if (restored.exitCode !== 0) problems.push(`pg_restore 退出码 ${restored.exitCode}:${restored.stderr.trim().slice(0, 300)}`)

    // 点表点不下去(不是「表不存在」,是查询本身失败)时的原因;非空 = 整轮演练算「跑不了」
    let probeFailure: string | null = null
    let probe: DrillClient | null = null
    try {
      probe = await openClient(conn, tempDb)
      for (const [table, est] of Object.entries(expected)) {
        // 表名来自 pg_stat_user_tables(库自己给的),不是用户输入;仍加引号防大小写/保留字。
        // ★显式写死 `public.`:快照那边也只取 public(见 service.snapshotRowCounts 的注释),
        //   两边必须用同一个口径,否则就是 2026-08-17 那次误报 —— 靠 search_path 撞运气迟早对不上。
        let actual: number | null = null
        try {
          const r = await probe.query(`select count(*)::bigint as n from public."${table.replace(/"/g, '""')}"`)
          actual = r[0] ? Number(r[0].n) : null
        } catch (err) {
          // ★原来这里是 `.catch(() => null)`,把**任何**查询失败都当成了「表查不到」→ 判 failed。
          //   连接抖一下就给一份好备份定罪,这是第三次撞上同一类假警报。
          //   查不下去 = **演练跑不了**(skipped,下周再来),不是备份坏了。
          if (!isUndefinedTable(err)) {
            probeFailure = `点表 ${table} 时查询失败(不是「表不存在」):${err instanceof Error ? err.message : String(err)}`
            break
          }
        }
        checks.push({ table, expected: est, actual })
        if (actual == null) {
          problems.push(`表 ${table} 在恢复出来的库里查不到`)
          continue
        }
        // ★判失败的只有这一条:快照说有数据,恢复出来却是空的。
        //   行数对不上不判失败 —— 快照是 n_live_tup 估计值,本来就不精确(见 verify.ts)。
        if (est > 0 && actual === 0) problems.push(`表 ${table} 恢复出来是空的(快照约 ${est} 行)`)
        else if (est > 0 && Math.abs(actual - est) > est * ROW_DRIFT_TOLERANCE) notes.push(`表 ${table} 行数 ${actual},快照估计 ${est}`)
      }
    } finally {
      await probe?.end().catch(() => {})
    }
    // 不写台账、不改 restore_verdict —— 保持 NULL(「没演练过」),下周原样再试一次。
    if (probeFailure) return { status: 'skipped', reason: probeFailure }

    const detail: DrillDetail = {
      restoreExitCode: restored.exitCode,
      restoreStderr: restored.stderr.trim().slice(0, 1000) || undefined,
      tables: checks,
      problems,
      notes,
      durationMs: Date.now() - startedAt,
      tempDatabase: tempDb,
    }
    const verdict: 'passed' | 'failed' = problems.length === 0 ? 'passed' : 'failed'
    await db
      .update(dbBackupRuns)
      .set({ restoreVerifiedAt: new Date(), restoreVerdict: verdict, restoreDetail: detail })
      .where(eq(dbBackupRuns.id, target.id))
    return { status: 'done', runId: target.id, verdict, detail }
  } finally {
    await cleanup(file, admin, created, tempDb)
  }
}

async function cleanup(file: { path: string; temp: boolean } | null, admin: DrillClient | null, created: boolean, tempDb: string): Promise<void> {
  try {
    if (created && admin) {
      // ★删库前**再断言一次**名字。这是最后一道保险:上面任何一处把变量传错,
      //   宁可这里抛错留下一个临时库,也不能 drop 到真库。
      if (!DRILL_DB_RE.test(tempDb)) throw new Error(`拒绝删除非演练库:${tempDb}`)
      // 演练期间 pg_restore 的连接可能还没完全释放,先踢掉再删
      // datname 是字符串**值**,能参数化就参数化(库名那两句是标识符,PG 不允许占位符,只能靠上面的正则)
      await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [tempDb]).catch(() => [])
      await admin.query(`drop database if exists ${tempDb}`)
    }
  } catch (err) {
    // 删不掉要吼一声:漏一个库就一直占着磁盘,而演练每周都跑
    console.error('[backup] 演练临时库没删掉,需要人工处理:', tempDb, err instanceof Error ? err.message : err)
  } finally {
    await admin?.end().catch(() => {})
    if (file?.temp) await rm(file.path, { force: true }).catch(() => {})
  }
}
