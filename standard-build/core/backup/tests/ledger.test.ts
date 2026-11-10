// core/backup/tests/ledger.test.ts
// 台账表(迁移 0206)+ 轮转落地。用 PGlite 跑真迁移,所以 SQL 写错会在这里直接炸。
//
// ★这里测不到的那一段:真的 pg_dump。测试库是 PGlite(进程内 Postgres),机器上不保证有
//   pg_dump 二进制,也不该依赖它。所以执行层抽成 PgTools 接口(见 pg-tools.ts),
//   本文件测的是「台账 + 轮转 + 文件真被删掉」这一段。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../../db/test-helpers'
import type { BackupConfig } from '../config'
import { dbBackupRuns } from '../model'
import { DEFAULT_LIMITS } from '../retention'
import { getBackupHealth, isUniqueViolation, pruneOldBackups, reconcileMissingLocalObjects, runBackupOnce } from '../service'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations')

let t: TestDb
let dir: string

function cfgWith(over: Partial<BackupConfig> = {}): BackupConfig {
  return {
    enabled: true,
    dir,
    hour: 3,
    timeZone: 'Asia/Shanghai',
    limits: DEFAULT_LIMITS,
    maxUploadBytes: 512 * 1024 * 1024,
    staleAlertDays: 2,
    pgDump: 'pg_dump',
    pgRestore: 'pg_restore',
    storageTenantId: null,
    drillEnabled: true,
    drillWeekday: 0,
    drillHour: 5,
    drillMaxBytes: 2 * 1024 * 1024 * 1024,
    ...over,
  }
}

/** 造一条已落地的本地备份(台账行 + 真文件) */
async function seedRun(localDate: string, verdict: 'ok' | 'suspect' | 'failed', sizeBytes = 1000): Promise<string> {
  const fileName = `base-${localDate}-${verdict}.dump`
  writeFileSync(join(dir, fileName), 'x'.repeat(10))
  const rows = await t.db
    .insert(dbBackupRuns)
    .values({ localDate, verdict, location: 'local', objectKey: fileName, sizeBytes, reasons: [] })
    .returning({ id: dbBackupRuns.id })
  return rows[0]!.id
}

beforeEach(async () => {
  t = await createTestDb()
  await migrate(t.db as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS })
  dir = mkdtempSync(join(tmpdir(), 'aios-backup-test-'))
  mkdirSync(dir, { recursive: true })
})
afterEach(async () => {
  await t.close()
})

describe('基线迁移 / 台账表', () => {
  it('基线建出空台账', async () => {
    expect((await t.db.select().from(dbBackupRuns)).length).toBe(0)
  })

  it('restore_verdict 只收 passed/failed 或 NULL(三态,NULL = 没演练过)', async () => {
    await expect(
      t.db.insert(dbBackupRuns).values({ localDate: '2026-08-17', verdict: 'ok', restoreVerdict: 'maybe', reasons: [] }),
    ).rejects.toThrow()
  })

  it('verdict 只收 ok/suspect/failed(库层 CHECK,不只是 TS 联合类型)', async () => {
    await expect(
      t.db.insert(dbBackupRuns).values({ localDate: '2026-08-17', verdict: 'weird', reasons: [] }),
    ).rejects.toThrow()
  })

  it('location 只收 local/oss/tos 或 null', async () => {
    await expect(
      t.db.insert(dbBackupRuns).values({ localDate: '2026-08-17', verdict: 'ok', location: 's3', reasons: [] }),
    ).rejects.toThrow()
  })

  it('★同一天至多一份 ok(唯一索引兜住多进程并发)', async () => {
    await seedRun('2026-08-17', 'ok')
    await expect(seedRun('2026-08-17', 'ok')).rejects.toThrow()
    // 但同一天可以有多份坏的 —— 失败重试不该被挡
    await seedRun('2026-08-17', 'failed')
    await seedRun('2026-08-17', 'suspect')
    expect((await t.db.select().from(dbBackupRuns)).length).toBe(3)
  })

  it('★那份被轮转掉/丢了之后,同一天必须还能再备一次(0208 修的)', async () => {
    // 原来的索引只看 verdict='ok' 不看还在不在 —— 于是「备份丢了」会连带变成
    // 「今天不许再有备份」,要熬到过午夜才自愈。2026-08-17 生产实测踩到。
    const id = await seedRun('2026-08-17', 'ok')
    await t.db.update(dbBackupRuns).set({ prunedAt: new Date(), prunedReason: '对象已丢失' }).where(eq(dbBackupRuns.id, id))
    await expect(seedRun('2026-08-17', 'ok')).resolves.toBeTruthy()
    const live = (await t.db.select().from(dbBackupRuns)).filter((r) => r.prunedAt === null)
    expect(live).toHaveLength(1)
  })
})

describe('轮转', () => {
  it('删掉超额的那份:文件真的消失,台账行留着只标 pruned_at', async () => {
    // 四份连续工作日(2026-08-17 是周一,无周/月锚点)
    const oldest = await seedRun('2026-08-17', 'ok')
    await seedRun('2026-08-18', 'ok')
    await seedRun('2026-08-19', 'ok')
    await seedRun('2026-08-20', 'ok')
    expect(existsSync(join(dir, 'base-2026-08-17-ok.dump'))).toBe(true)

    const r = await pruneOldBackups(t.db, cfgWith())
    expect(r.pruned).toBe(1)
    expect(existsSync(join(dir, 'base-2026-08-17-ok.dump'))).toBe(false)
    expect(existsSync(join(dir, 'base-2026-08-20-ok.dump'))).toBe(true)

    // ★行不删:台账要回答「那份备份后来去哪了」
    const all = await t.db.select().from(dbBackupRuns)
    expect(all.length).toBe(4)
    const gone = all.find((x) => x.id === oldest)!
    expect(gone.prunedAt).not.toBeNull()
    expect(gone.prunedReason).toContain('额度')
  })

  it('★坏备份连来三天,三份好的一个文件都没少(用户提的那个场景)', async () => {
    await seedRun('2026-08-12', 'ok')
    await seedRun('2026-08-13', 'ok')
    await seedRun('2026-08-14', 'ok')
    await seedRun('2026-08-15', 'failed')
    await seedRun('2026-08-16', 'suspect')
    await seedRun('2026-08-17', 'suspect')

    await pruneOldBackups(t.db, cfgWith())
    for (const d of ['2026-08-12', '2026-08-13', '2026-08-14']) {
      expect(existsSync(join(dir, `base-${d}-ok.dump`)), d).toBe(true)
    }
    // 坏的只留 2 份(默认额度),最老那份坏的被清
    expect(existsSync(join(dir, 'base-2026-08-15-failed.dump'))).toBe(false)
  })

  it('已经 pruned 的行不会被重复处理', async () => {
    await seedRun('2026-08-17', 'ok')
    await seedRun('2026-08-18', 'ok')
    await seedRun('2026-08-19', 'ok')
    await seedRun('2026-08-20', 'ok')
    expect((await pruneOldBackups(t.db, cfgWith())).pruned).toBe(1)
    expect((await pruneOldBackups(t.db, cfgWith())).pruned).toBe(0)
  })
})

// ★这一族来自一次真事故(2026-08-17):CI 发版那条 `rsync -az --delete` 没排除 `backups/`,
//   当天备好的 dump 被下一次发版整个删掉,而台账那行 pruned_at 仍是 null ——
//   于是健康度报「现存 1 份」,面板看着一切正常,盘上其实一份都没有。
//   **备份系统撒的谎比没有备份更危险**,所以台账与磁盘必须能自己对上账。
describe('★台账与磁盘对账', () => {
  it('文件被外部删掉 → 标成已丢失,并从「现存份数」里消失', async () => {
    await seedRun('2026-08-17', 'ok')
    rmSync(join(dir, 'base-2026-08-17-ok.dump')) // 模拟发版把 backups/ 删了

    const before = await getBackupHealth(t.db, cfgWith(), new Date('2026-08-17T00:00:00Z'))
    expect(before.liveCount, '对账前台账还以为有一份').toBe(1)

    const r = await reconcileMissingLocalObjects(t.db, cfgWith())
    expect(r.lost).toBe(1)

    const after = await getBackupHealth(t.db, cfgWith(), new Date('2026-08-17T00:00:00Z'))
    expect(after.liveCount).toBe(0)
    const [row] = await t.db.select().from(dbBackupRuns)
    expect(row!.prunedAt).not.toBeNull()
    expect(row!.prunedReason).toContain('盘上找不到')
  })

  it('文件还在 → 一行都不动', async () => {
    await seedRun('2026-08-17', 'ok')
    expect((await reconcileMissingLocalObjects(t.db, cfgWith())).lost).toBe(0)
    const [row] = await t.db.select().from(dbBackupRuns)
    expect(row!.prunedAt).toBeNull()
  })

  it('★云端存的不参与对账 —— 读不到可能只是网络抖动,不能把好备份从账上抹掉', async () => {
    await t.db.insert(dbBackupRuns).values({ localDate: '2026-08-17', verdict: 'ok', location: 'oss', objectKey: 'backups/x.dump', sizeBytes: 10, reasons: [] })
    expect((await reconcileMissingLocalObjects(t.db, cfgWith())).lost).toBe(0)
  })

  it('轮转会先对账:丢了的那份不该再占日备额度', async () => {
    await seedRun('2026-08-17', 'ok')
    await seedRun('2026-08-18', 'ok')
    await seedRun('2026-08-19', 'ok')
    rmSync(join(dir, 'base-2026-08-18-ok.dump'))
    const r = await pruneOldBackups(t.db, cfgWith())
    expect(r.lost).toBe(1)
    // 还活着的两份都在额度内,不该被删
    expect(r.pruned).toBe(0)
    expect(existsSync(join(dir, 'base-2026-08-17-ok.dump'))).toBe(true)
    expect(existsSync(join(dir, 'base-2026-08-19-ok.dump'))).toBe(true)
  })
})

describe('runBackupOnce 的两条 skip 路径', () => {
  it('★没有 DATABASE_URL → skipped 而不是 failed(本机内存库模式不该每天刷一条红)', async () => {
    const saved = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    try {
      const r = await runBackupOnce(t.db, { config: cfgWith(), now: new Date('2026-08-17T00:00:00Z') })
      expect(r.status).toBe('skipped')
      expect(r.status === 'skipped' && r.reason).toContain('DATABASE_URL')
      expect((await t.db.select().from(dbBackupRuns)).length).toBe(0)
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })

  it('今天已经备成功过 → skipped(幂等,按本地日历日算)', async () => {
    // 2026-08-16T19:00Z = 东八区 2026-08-17 凌晨 3 点
    await seedRun('2026-08-17', 'ok')
    const r = await runBackupOnce(t.db, { config: cfgWith(), now: new Date('2026-08-16T19:00:00Z') })
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reason).toContain('2026-08-17')
  })

  it('未启用 → skipped', async () => {
    const r = await runBackupOnce(t.db, { config: cfgWith({ enabled: false }) })
    expect(r.status).toBe('skipped')
  })
})

describe('健康度(告警与面板共用)', () => {
  it('从未备份过 = stale,且 daysSinceOk 为 null', async () => {
    const h = await getBackupHealth(t.db, cfgWith(), new Date('2026-08-17T00:00:00Z'))
    expect(h.stale).toBe(true)
    expect(h.daysSinceOk).toBeNull()
    expect(h.lastRunId).toBeNull()
  })

  it('今天刚备过 = 不 stale;份数与占用算的是还活着的', async () => {
    await seedRun('2026-08-17', 'ok', 4096)
    const h = await getBackupHealth(t.db, cfgWith(), new Date('2026-08-16T19:00:00Z'))
    expect(h.daysSinceOk).toBe(0)
    expect(h.stale).toBe(false)
    expect(h.liveCount).toBe(1)
    expect(h.liveBytes).toBe(4096)
    expect(h.lastRunId).not.toBeNull()
  })

  it('★超过 staleAlertDays 天没成功 → stale(备份停了要有人知道)', async () => {
    await seedRun('2026-08-14', 'ok')
    const h = await getBackupHealth(t.db, cfgWith(), new Date('2026-08-16T19:00:00Z')) // 本地 08-17
    expect(h.daysSinceOk).toBe(3)
    expect(h.stale).toBe(true)
  })

  it('轮转掉的备份不再计入现存份数', async () => {
    await seedRun('2026-08-17', 'ok')
    await seedRun('2026-08-18', 'ok')
    await seedRun('2026-08-19', 'ok')
    await seedRun('2026-08-20', 'ok')
    await pruneOldBackups(t.db, cfgWith())
    const h = await getBackupHealth(t.db, cfgWith(), new Date('2026-08-20T00:00:00Z'))
    expect(h.liveCount).toBe(3)
  })
})

// ★这一族钉住的是 2026-08-17 生产实测栽的那一跤:原来的唯一索引冲突判定只看最外层 message,
//   而 drizzle 把驱动的错误包了一层,外层只剩 `Failed query: insert into "db_backup_runs" …`
//   —— 既没有 `duplicate key` 也没有索引名。于是并发兜底那条路不是返回 skipped 而是**直接抛出去**,
//   dump 文件已经落地、台账行没写成,留下一个孤儿文件。
describe('★唯一索引冲突要认得出来(不能只看最外层 message)', () => {
  it('真实的 drizzle 冲突错误能被认出来', async () => {
    await seedRun('2026-08-17', 'ok')
    let caught: unknown = null
    try {
      await seedRun('2026-08-17', 'ok')
    } catch (err) {
      caught = err
    }
    expect(caught, '这一步本来就该冲突').not.toBeNull()
    // 先证明「只看最外层 message」确实不够 —— 否则这条测试是在测一个不存在的问题
    const outer = caught instanceof Error ? caught.message : ''
    expect(/duplicate key|db_backup_runs_ok_per_day_uq/i.test(outer), `最外层 message 竟然带了标记:${outer.slice(0, 120)}`).toBe(false)
    // 沿 cause 链找就认得出来
    expect(isUniqueViolation(caught)).toBe(true)
  })

  it('别的错误不会被误判成冲突', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
  })

  it('cause 链再深也找得到,但不会无限走下去', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('duplicate key value violates unique constraint') }) })
    expect(isUniqueViolation(deep)).toBe(true)
    // 造一个自引用的环:不该挂死
    const loop = new Error('x') as Error & { cause?: unknown }
    loop.cause = loop
    expect(isUniqueViolation(loop)).toBe(false)
  })
})

// ★2026-08-17 生产实测的一次**误报**:行数快照取自 pg_stat_user_tables,而 relname 不带 schema;
//   恢复演练拿这个名字去 public 下点表,于是 `drizzle.__drizzle_migrations` 必然「查不到」,
//   20 张表里 19 张行数分毫不差,只因为这一张判了 failed。
//   **假警报比没有警报更糟** —— 它教会人忽略这个告警。两边现在都钉死在 public。
describe('★行数快照只取 public schema(否则演练必然误报)', () => {
  it('非 public schema 的表不进快照', async () => {
    await t.raw.exec(`
      create schema if not exists side;
      create table if not exists side.side_rows (id int);
      insert into side.side_rows select generate_series(1, 208);
      create table if not exists public.biz_rows (id int);
      insert into public.biz_rows select generate_series(1, 50);
      analyze;
    `)
    const r = (await t.db.execute(
      // 与 service.snapshotRowCounts 同一条 SQL 的判据部分
      `select relname from pg_stat_user_tables where schemaname = 'public'`,
    )) as { rows: Array<{ relname: string }> }
    const names = r.rows.map((x) => x.relname)
    expect(names).toContain('biz_rows')
    expect(names, 'public 以外的表不该进快照').not.toContain('side_rows')
  })
})

// ★对照基准取哪一份:2026-08-17 生产实测发现的陷阱。
//   基准若只认 ok,那么任何**持续性的正常变化**(迁移删了一张大表、归档清掉一批历史日志)
//   都会让此后每一次备份都相对那个冻住的旧基准判 suspect —— 天天同一条告警。
//   **一条永远在响的告警等于没有告警。**
describe('★对照基准:suspect 也算,只排除 failed', () => {
  const baseline = async (date: string, verdict: 'ok' | 'suspect' | 'failed', size: number) => {
    await t.db.insert(dbBackupRuns).values({ localDate: date, verdict, sizeBytes: size, rowCounts: { leads: size }, reasons: [] })
  }

  it('最近一份是 suspect 时,它就是新基准(否则同一条告警会天天响)', async () => {
    await baseline('2026-08-16', 'ok', 1000)
    await baseline('2026-08-17', 'suspect', 400) // 昨天骤降过一次,已经报过了
    // 今天仍是 400 —— 相对「新常态」不该再报
    const { verifyDump } = await import('../verify')
    const prev = { sizeBytes: 400, rowCounts: { leads: 400 } }
    expect(verifyDump({
      dumpExitCode: 0, dumpStderr: '', sizeBytes: 400, restoreListOk: true, restoreListObjects: 10,
      rowCounts: { leads: 400 }, prev,
    }).verdict).toBe('ok')
  })

  it('failed 的那份不能当基准(它的 dump 本来就不完整,快照没参考价值)', async () => {
    await baseline('2026-08-16', 'ok', 1000)
    await baseline('2026-08-17', 'failed', 0)
    const rows = await t.db.select().from(dbBackupRuns)
    const usable = rows.filter((r) => r.verdict !== 'failed')
    expect(usable).toHaveLength(1)
    expect(Number(usable[0]!.sizeBytes)).toBe(1000)
  })
})
