// core/backup/tests/restore-drill.test.ts
// 恢复演练。★这套用例最要紧的不是「通过时判 passed」,而是两件更危险的事:
//   ① **临时库一定要被删掉**(每周漏一个和原库同样大的库,磁盘会被慢慢吃光);
//   ② **「演练跑不了」不能报成「备份坏了」**(权限受限的客户环境会每周一条假警报)。
//
// pg_restore 与真 PG 连接都靠依赖注入换成假的 —— PGlite 里没有 pg_restore,也没法建第二个库。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../../db/test-helpers'
import type { BackupConfig } from '../config'
import { dbBackupRuns } from '../model'
import type { PgTools } from '../pg-tools'
import { DEFAULT_LIMITS } from '../retention'
import { runRestoreDrill, type DrillClient } from '../restore-drill'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations')

let t: TestDb
let dir: string
let savedUrl: string | undefined

const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
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
})

/** 记录所有执行过的 SQL,用来断言临时库真的被 drop 了 */
function fakeClient(
  counts: Record<string, number>,
  log: string[],
  opts: { failOnCreate?: boolean; probeError?: Error } = {},
) {
  return async (_conn: unknown, database: string): Promise<DrillClient> => ({
    query: async (text: string, params?: unknown[]) => {
      log.push(`[${database}] ${text}${params ? ` -- ${JSON.stringify(params)}` : ''}`)
      if (opts.failOnCreate && /^create database/i.test(text)) throw new Error('permission denied to create database')
      if (opts.probeError && /from public\./.test(text)) throw opts.probeError
      // ★与 restore-drill 的探测语句同形:它显式写 `public."表名"`(见那边的注释)
      const m = /from public\."([^"]+)"/.exec(text)
      if (m) {
        const n = counts[m[1]!]
        if (n === undefined) throw new Error(`relation "${m[1]}" does not exist`)
        return [{ n }]
      }
      return []
    },
    end: async () => {},
  })
}

const fakeTools = (restore: { exitCode: number; stderr: string } = { exitCode: 0, stderr: '' }): PgTools => ({
  toolVersion: async () => 'pg_dump (PostgreSQL) 17.11',
  dump: async () => ({ exitCode: 0, stderr: '' }),
  listObjects: async () => ({ ok: true, objects: 100, stderr: '' }),
  restoreInto: async () => restore,
})

async function seedOkBackup(rowCounts: Record<string, number>, over: Record<string, unknown> = {}): Promise<string> {
  const fileName = 'base-2026-08-17-ok.dump'
  writeFileSync(join(dir, fileName), 'x'.repeat(64))
  const rows = await t.db
    .insert(dbBackupRuns)
    .values({ localDate: '2026-08-17', verdict: 'ok', location: 'local', objectKey: fileName, sizeBytes: 64, rowCounts, reasons: [], ...over })
    .returning({ id: dbBackupRuns.id })
  return rows[0]!.id
}

beforeEach(async () => {
  t = await createTestDb()
  await migrate(t.db as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS })
  dir = mkdtempSync(join(tmpdir(), 'aios-drill-test-'))
  mkdirSync(dir, { recursive: true })
  savedUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:5432/base_prod'
})
afterEach(async () => {
  if (savedUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedUrl
  await t.close()
})

describe('演练通过', () => {
  it('恢复成功且各表都有数据 → passed,结果写回那一行备份', async () => {
    const id = await seedOkBackup({ leads: 100, employees: 16 })
    const log: string[] = []
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 100, employees: 16 }, log) })

    expect(r.status).toBe('done')
    expect(r.status === 'done' && r.verdict).toBe('passed')
    const [row] = await t.db.select().from(dbBackupRuns)
    expect(row!.restoreVerdict).toBe('passed')
    expect(row!.restoreVerifiedAt).not.toBeNull()
    expect((row!.restoreDetail as { tables: unknown[] }).tables).toHaveLength(2)
    expect(row!.id).toBe(id)
  })

  it('行数与快照有偏差但不为空 → 仍是 passed,偏差只记进 notes(快照本来就是估计值)', async () => {
    await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 70 }, []) })
    expect(r.status === 'done' && r.verdict).toBe('passed')
    expect(r.status === 'done' && r.detail.notes.join()).toContain('leads')
    expect(r.status === 'done' && r.detail.problems).toEqual([])
  })
})

describe('演练不通过', () => {
  it('pg_restore 非零退出 → failed,stderr 带进去', async () => {
    await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, {
      config: cfg(),
      tools: fakeTools({ exitCode: 1, stderr: 'pg_restore: error: could not read from input file' }),
      openClient: fakeClient({ leads: 100 }, []),
    })
    expect(r.status === 'done' && r.verdict).toBe('failed')
    expect(r.status === 'done' && r.detail.problems.join()).toContain('could not read')
  })

  it('★快照说有数据、恢复出来是空的 → failed(这是最该抓住的那种坏)', async () => {
    await seedOkBackup({ leads: 100, employees: 16 })
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 0, employees: 16 }, []) })
    expect(r.status === 'done' && r.verdict).toBe('failed')
    expect(r.status === 'done' && r.detail.problems.join()).toContain('恢复出来是空的')
  })

  it('表在恢复出来的库里根本不存在 → failed', async () => {
    await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({}, []) })
    expect(r.status === 'done' && r.verdict).toBe('failed')
    expect(r.status === 'done' && r.detail.problems.join()).toContain('查不到')
  })
})

describe('★「演练跑不了」不能报成「备份坏了」', () => {
  it('建不了临时库(权限不够)→ skipped,不写 restore_verdict', async () => {
    await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, {
      config: cfg(),
      tools: fakeTools(),
      openClient: fakeClient({ leads: 100 }, [], { failOnCreate: true }),
    })
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reason).toContain('permission denied')
    // ★关键:不能留下 failed —— 否则权限受限的客户每周一条「备份恢复失败」的假警报
    const [row] = await t.db.select().from(dbBackupRuns)
    expect(row!.restoreVerdict).toBeNull()
  })

  it('dump 超过演练上限 → skipped(临时库约等于原库大小,别把磁盘撑爆)', async () => {
    await seedOkBackup({ leads: 100 }, { sizeBytes: 10_000 })
    const r = await runRestoreDrill(t.db, { config: cfg({ drillMaxBytes: 1000 }), tools: fakeTools(), openClient: fakeClient({}, []) })
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reason).toContain('超过演练上限')
  })

  it('本地文件已经不在了 → skipped', async () => {
    await t.db.insert(dbBackupRuns).values({ localDate: '2026-08-17', verdict: 'ok', location: 'local', objectKey: '不存在.dump', sizeBytes: 64, reasons: [] })
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({}, []) })
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reason).toContain('取不到')
  })

  it('一份存活的 ok 都没有 → skipped', async () => {
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({}, []) })
    expect(r.status).toBe('skipped')
  })

  it('没有 DATABASE_URL → skipped', async () => {
    delete process.env.DATABASE_URL
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({}, []) })
    expect(r.status === 'skipped' && r.reason).toContain('DATABASE_URL')
  })

  it('★点表时查询失败(不是「表不存在」)→ skipped,不给备份定罪', async () => {
    // 2026-08-18:原来这里是 `.catch(() => null)`,任何查询失败都被当成「表查不到」→ 判 failed。
    // 连接抖一下就把一份好备份报成「恢复不出来」,这是同一类假警报的第三次。
    await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, {
      config: cfg(),
      tools: fakeTools(),
      openClient: fakeClient({ leads: 100 }, [], { probeError: new Error('Connection terminated unexpectedly') }),
    })
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reason).toContain('Connection terminated')
    // ★保持 NULL = 「没演练过」,下周原样再试;写成 failed 或 passed 都是撒谎
    const [row] = await t.db.select().from(dbBackupRuns)
    expect(row!.restoreVerdict).toBeNull()
  })

  it('★但「表真的不存在」照旧判 failed —— 两者必须分得开', async () => {
    await seedOkBackup({ leads: 100 })
    const err = Object.assign(new Error('boom'), { code: '42P01' })
    const r = await runRestoreDrill(t.db, {
      config: cfg(),
      tools: fakeTools(),
      openClient: fakeClient({ leads: 100 }, [], { probeError: err }),
    })
    expect(r.status === 'done' && r.verdict).toBe('failed')
    expect(r.status === 'done' && r.detail.problems.join()).toContain('查不到')
  })

  it('未启用 → skipped', async () => {
    await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, { config: cfg({ drillEnabled: false }), tools: fakeTools(), openClient: fakeClient({}, []) })
    expect(r.status).toBe('skipped')
  })
})

describe('★临时库必须被删掉', () => {
  it('通过时删', async () => {
    await seedOkBackup({ leads: 100 })
    const log: string[] = []
    await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 100 }, log) })
    expect(log.some((l) => /create database aios_restore_drill_\d+/.test(l))).toBe(true)
    expect(log.some((l) => /drop database if exists aios_restore_drill_\d+/.test(l))).toBe(true)
    // ★踢连接那句的库名是字符串**值**,走占位符;能参数化的就不许拼进 SQL
    expect(log.some((l) => l.includes('datname = $1') && /aios_restore_drill_\d+/.test(l))).toBe(true)
  })

  it('★恢复失败时也删(不然每周漏一个和原库同样大的库)', async () => {
    await seedOkBackup({ leads: 100 })
    const log: string[] = []
    await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools({ exitCode: 1, stderr: 'boom' }), openClient: fakeClient({ leads: 100 }, log) })
    expect(log.some((l) => /drop database if exists aios_restore_drill_\d+/.test(l))).toBe(true)
  })

  it('★点表的过程中抛异常也删', async () => {
    await seedOkBackup({ leads: 100 })
    const log: string[] = []
    const boom = async (_c: unknown, database: string): Promise<DrillClient> => ({
      query: async (text: string) => {
        log.push(`[${database}] ${text}`)
        if (/count\(\*\)/.test(text)) throw new Error('连接断了')
        return []
      },
      end: async () => {},
    })
    await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: boom }).catch(() => {})
    expect(log.some((l) => /drop database if exists aios_restore_drill_\d+/.test(l))).toBe(true)
  })

  it('★删之前会先踢掉残留连接(否则 DROP DATABASE 会因为有人连着而失败)', async () => {
    await seedOkBackup({ leads: 100 })
    const log: string[] = []
    await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 100 }, log) })
    const kill = log.findIndex((l) => l.includes('pg_terminate_backend'))
    const drop = log.findIndex((l) => l.includes('drop database'))
    expect(kill).toBeGreaterThanOrEqual(0)
    expect(kill).toBeLessThan(drop)
  })

  it('★删库语句只会打在 aios_restore_drill_ 开头的库上 —— 全程没有别的 drop', async () => {
    await seedOkBackup({ leads: 100 })
    const log: string[] = []
    await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 100 }, log) })
    const drops = log.filter((l) => /drop database/i.test(l))
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatch(/drop database if exists aios_restore_drill_\d+$/)
  })
})

describe('幂等', () => {
  it('最近那份已经演练过 → skipped,不重复跑', async () => {
    await seedOkBackup({ leads: 100 }, { restoreVerdict: 'passed', restoreVerifiedAt: new Date() })
    const log: string[] = []
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 100 }, log) })
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reason).toContain('已演练过')
    expect(log).toEqual([]) // 连库都没建
  })

  it('force 可以强制重跑', async () => {
    await seedOkBackup({ leads: 100 }, { restoreVerdict: 'passed', restoreVerifiedAt: new Date() })
    const r = await runRestoreDrill(t.db, { config: cfg(), force: true, tools: fakeTools(), openClient: fakeClient({ leads: 100 }, []) })
    expect(r.status).toBe('done')
  })

  it('演练的是最近那份,不是老的那份', async () => {
    writeFileSync(join(dir, 'old.dump'), 'x')
    await t.db.insert(dbBackupRuns).values({ localDate: '2026-08-10', verdict: 'ok', location: 'local', objectKey: 'old.dump', sizeBytes: 1, rowCounts: { leads: 1 }, reasons: [] })
    const newId = await seedOkBackup({ leads: 100 })
    const r = await runRestoreDrill(t.db, { config: cfg(), tools: fakeTools(), openClient: fakeClient({ leads: 100 }, []) })
    expect(r.status === 'done' && r.runId).toBe(newId)
  })
})
