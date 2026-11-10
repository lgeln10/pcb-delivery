// core/backup/tests/config.test.ts
// 配置解析 + **时区**。时区那几条是本文件的重点:
// 「CI 跑 UTC 恰好正确、东八区生产歪一天」是本仓踩过的坑(见 memory 的 aios-tz 那条),
// 所以这里显式设置 process.env.TZ 跑两遍,不指望机器时区。
import { afterEach, describe, expect, it } from 'vitest'
import { loadBackupConfig, localDateOf, localHourOf } from '../config'
import { checkVersionCompat, majorVersionOf, parseDatabaseUrl } from '../pg-tools'

const ENV_KEYS = [
  'BACKUP_ENABLED', 'BACKUP_DIR', 'BACKUP_HOUR', 'BACKUP_TZ', 'BACKUP_KEEP_DAILY', 'BACKUP_KEEP_WEEKLY',
  'BACKUP_KEEP_MONTHLY', 'BACKUP_KEEP_BAD', 'BACKUP_MAX_TOTAL_BYTES', 'BACKUP_MAX_UPLOAD_BYTES',
  'BACKUP_STALE_ALERT_DAYS', 'BACKUP_PG_DUMP', 'BACKUP_STORAGE_TENANT_ID', 'TZ',
] as const
const saved = new Map<string, string | undefined>()
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved.has(k)) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  saved.clear()
})
function setEnv(k: string, v: string | undefined): void {
  if (!saved.has(k)) saved.set(k, process.env[k])
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

describe('配置默认值', () => {
  it('★默认是开的 —— 备份最经典的死法是「以为在备,其实从来没开过」', () => {
    setEnv('BACKUP_ENABLED', undefined)
    expect(loadBackupConfig().enabled).toBe(true)
  })

  it('BACKUP_ENABLED=0 / false / off 都关得掉', () => {
    for (const v of ['0', 'false', 'off', 'NO']) {
      setEnv('BACKUP_ENABLED', v)
      expect(loadBackupConfig().enabled, v).toBe(false)
    }
  })

  it('默认额度 = 3 日 + 1 周 + 1 月 + 2 份坏的,总额度不限', () => {
    for (const k of ['BACKUP_KEEP_DAILY', 'BACKUP_KEEP_WEEKLY', 'BACKUP_KEEP_MONTHLY', 'BACKUP_KEEP_BAD', 'BACKUP_MAX_TOTAL_BYTES']) setEnv(k, undefined)
    expect(loadBackupConfig().limits).toEqual({ daily: 3, weekly: 1, monthly: 1, bad: 2, maxTotalBytes: null })
  })

  it('日备至少 1 份(配 0 也会被抬到 1)', () => {
    setEnv('BACKUP_KEEP_DAILY', '0')
    expect(loadBackupConfig().limits.daily).toBe(1)
  })

  it('BACKUP_HOUR 夹在 0-23', () => {
    setEnv('BACKUP_HOUR', '99')
    expect(loadBackupConfig().hour).toBe(23)
    setEnv('BACKUP_HOUR', '-5')
    expect(loadBackupConfig().hour).toBe(0)
  })

  it('脏值回落默认值,不抛也不变成 NaN', () => {
    setEnv('BACKUP_KEEP_DAILY', 'abc')
    setEnv('BACKUP_HOUR', '')
    const cfg = loadBackupConfig()
    expect(cfg.limits.daily).toBe(3)
    expect(cfg.hour).toBe(3)
  })
})

describe('★本地日历日 / 小时(不能用 toISOString)', () => {
  it('东八区凌晨 3 点 → 本地日是当天,而 UTC 还在前一天', () => {
    // 2026-08-17T03:00+08:00 = 2026-08-16T19:00Z
    const at = new Date('2026-08-16T19:00:00Z')
    expect(localDateOf(at, 'Asia/Shanghai')).toBe('2026-08-17')
    expect(localHourOf(at, 'Asia/Shanghai')).toBe(3)
    // 用 UTC 算会得到 08-16 —— 幂等键算成昨天,于是同一天跑两次、另一天一次都不跑
    expect(at.toISOString().slice(0, 10)).toBe('2026-08-16')
  })

  it('结果与运行机器的 TZ 无关(只看传进去的时区)', () => {
    const at = new Date('2026-08-16T19:00:00Z')
    for (const machineTz of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
      setEnv('TZ', machineTz)
      expect(localDateOf(at, 'Asia/Shanghai'), machineTz).toBe('2026-08-17')
      expect(localHourOf(at, 'Asia/Shanghai'), machineTz).toBe(3)
    }
  })

  it('午夜 0 点的小时是 0 而不是 24', () => {
    expect(localHourOf(new Date('2026-08-16T16:00:00Z'), 'Asia/Shanghai')).toBe(0)
  })

  it('没配 BACKUP_TZ 时用 TZ,都没有就 Asia/Shanghai(客户都在国内)', () => {
    setEnv('BACKUP_TZ', undefined)
    setEnv('TZ', 'America/Los_Angeles')
    expect(loadBackupConfig().timeZone).toBe('America/Los_Angeles')
    setEnv('TZ', undefined)
    expect(loadBackupConfig().timeZone).toBe('Asia/Shanghai')
    setEnv('BACKUP_TZ', 'Asia/Tokyo')
    expect(loadBackupConfig().timeZone).toBe('Asia/Tokyo')
  })
})

describe('DATABASE_URL 解析', () => {
  it('解出 host/port/user/db', () => {
    expect(parseDatabaseUrl('postgres://bob:pw@10.0.0.1:5434/base_prod')).toEqual({
      host: '10.0.0.1', port: 5434, user: 'bob', password: 'pw', database: 'base_prod',
    })
  })

  it('★百分号编码的密码要解码 —— 带 @ : / 的密码不解码就连不上', () => {
    expect(parseDatabaseUrl('postgresql://u:p%40ss%2Fword@h/db')?.password).toBe('p@ss/word')
  })

  it('缺省端口 5432', () => {
    expect(parseDatabaseUrl('postgres://u:p@h/db')?.port).toBe(5432)
  })

  it('不是 postgres URL / 没库名 / 空 → null(调用方据此 skip,不崩)', () => {
    expect(parseDatabaseUrl(undefined)).toBeNull()
    expect(parseDatabaseUrl('')).toBeNull()
    expect(parseDatabaseUrl('mysql://u:p@h/db')).toBeNull()
    expect(parseDatabaseUrl('postgres://u:p@h/')).toBeNull()
    expect(parseDatabaseUrl('不是个 url')).toBeNull()
  })
})

describe('★pg_dump 版本 preflight(base 上真发生过的那个坑)', () => {
  it('从版本串里取主版本号', () => {
    expect(majorVersionOf('pg_dump (PostgreSQL) 17.11 (Ubuntu 17.11-1.pgdg24.04+2)')).toBe(17)
    expect(majorVersionOf('pg_dump (PostgreSQL) 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)')).toBe(16)
    expect(majorVersionOf('17.10')).toBe(17)
    expect(majorVersionOf(null)).toBeNull()
  })

  it('客户端旧于服务端 → 不通过,报错里要说清装哪个包', () => {
    const r = checkVersionCompat('pg_dump (PostgreSQL) 16.14', '17.10')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('postgresql-client-17')
  })

  it('客户端新于或等于服务端 → 通过(pg_dump 只拒绝比自己新的服务端)', () => {
    expect(checkVersionCompat('pg_dump (PostgreSQL) 17.11', '17.10').ok).toBe(true)
    expect(checkVersionCompat('pg_dump (PostgreSQL) 18.0', '17.10').ok).toBe(true)
  })

  it('压根没有 pg_dump → 不通过,并指出怎么办', () => {
    const r = checkVersionCompat(null, '17.10')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('BACKUP_PG_DUMP')
  })
})
