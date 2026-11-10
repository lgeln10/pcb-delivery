// core/backup/pg-tools.ts
// 真正调 pg_dump / pg_restore 的那一层,外加一个**版本 preflight**。
//
// ★为什么抽成 PgTools 接口:测试库是 PGlite(进程内 Postgres),机器上不一定有、也不该依赖
//   pg_dump 二进制。service.ts 收一个 PgTools 依赖,测试塞假的,生产塞 realPgTools()。
//
// ★★两条踩过的坑,写死在这里:
//   1. **绝不用管道。** `pg_dump ... | gzip > f` 的退出码来自 gzip —— pg_dump 炸了也是 0,
//      于是「备份成功」而文件是半截的。所以一律 `-Fc -f <文件>` 直接落盘,读进程自己的退出码。
//      (-Fc 自带压缩,本来也不需要外挂 gzip。)
//   2. **密码只走子进程 env,不进 argv。** argv 在 `ps aux` 里全机可见,任何本地用户都能抄走
//      生产库密码。PGPASSWORD 只对该子进程可见。

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export type PgConn = {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export type PgTools = {
  /** `pg_dump --version` 那行原文;取不到返回 null(视为不可用) */
  toolVersion(bin: string): Promise<string | null>
  /** pg_dump -Fc。**必须**把退出码原样返回,不许经过管道 */
  dump(bin: string, conn: PgConn, outFile: string): Promise<{ exitCode: number; stderr: string }>
  /** pg_restore --list:dump 读不读得出来 */
  listObjects(bin: string, file: string): Promise<{ ok: boolean; objects: number; stderr: string }>
  /** pg_restore 进指定库(恢复演练用,见 restore-drill.ts)。库必须已存在。 */
  restoreInto(bin: string, conn: PgConn, database: string, file: string): Promise<{ exitCode: number; stderr: string }>
}

/** 从 DATABASE_URL 解出连接参数。解不出返回 null(调用方据此写一条 failed 台账,而不是崩) */
export function parseDatabaseUrl(url: string | undefined): PgConn | null {
  if (!url || !url.trim()) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return null
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (!database) return null
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 5432,
    // 用户名/密码在 URL 里是百分号编码的,不解码会把带 @ : / 的密码用错
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database,
  }
}

/** 从 `pg_dump (PostgreSQL) 17.11 (Ubuntu …)` 里取主版本号 */
export function majorVersionOf(versionText: string | null | undefined): number | null {
  if (!versionText) return null
  const m = /(\d+)(?:\.\d+)*/.exec(versionText.replace(/^\D*?(?=\d)/, ''))
  return m ? Number(m[1]) : null
}

export type Preflight = { ok: boolean; reason?: string; dumpVersion: string | null; serverVersion: string | null }

/**
 * 版本闸。**pg_dump 拒绝导出比自己新的服务端**(客户端旧于服务端 = 直接 abort),
 * 而客户端新于服务端是允许的。所以判据是 `pg_dump 主版本 >= 服务端主版本`。
 *
 * ★这一条不是理论问题:2026-08-17 实测 base 那台机宿主机 pg_dump 是 16.14、库是 17.10 ——
 *   照直写完,第一天就会天天失败。所以这里要**显式报错并写进台账**,不能等运维半年后
 *   想恢复时才发现。(该机已装 postgresql-client-17。)
 */
export function checkVersionCompat(dumpVersion: string | null, serverVersion: string | null): Preflight {
  const dumpMajor = majorVersionOf(dumpVersion)
  const serverMajor = majorVersionOf(serverVersion)
  if (dumpMajor == null) {
    return { ok: false, reason: '找不到可用的 pg_dump(装 postgresql-client,或用 BACKUP_PG_DUMP 指定路径)', dumpVersion, serverVersion }
  }
  if (serverMajor == null) return { ok: false, reason: '读不出服务端版本', dumpVersion, serverVersion }
  if (dumpMajor < serverMajor) {
    return {
      ok: false,
      reason: `pg_dump 主版本 ${dumpMajor} 低于服务端 ${serverMajor},pg_dump 会拒绝导出;装 postgresql-client-${serverMajor} 或用 BACKUP_PG_DUMP 指定路径`,
      dumpVersion,
      serverVersion,
    }
  }
  return { ok: true, dumpVersion, serverVersion }
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { env: { ...process.env, ...env } })
    } catch (err) {
      resolve({ exitCode: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      return
    }
    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    // 二进制不存在时是 error 事件不是非零退出,两条路都要收口,否则 Promise 永不 settle
    child.on('error', (err) => resolve({ exitCode: 127, stdout, stderr: stderr + err.message }))
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

export function realPgTools(): PgTools {
  return {
    async toolVersion(bin) {
      const r = await run(bin, ['--version'], {})
      return r.exitCode === 0 ? r.stdout.trim() : null
    },
    async dump(bin, conn, outFile) {
      // -Fc = custom format(自带压缩、可选择性恢复);--no-password 避免它在无密码时挂起等 TTY 输入
      const args = [
        '-h', conn.host,
        '-p', String(conn.port),
        '-U', conn.user,
        '-d', conn.database,
        '-Fc',
        '--no-password',
        '-f', outFile,
      ]
      const r = await run(bin, args, { PGPASSWORD: conn.password })
      return { exitCode: r.exitCode, stderr: r.stderr }
    },
    async listObjects(bin, file) {
      const r = await run(bin, ['--list', file], {})
      if (r.exitCode !== 0) return { ok: false, objects: 0, stderr: r.stderr }
      // 清单里以 ';' 开头的是注释行,真正的对象条目是其余非空行
      const objects = r.stdout.split('\n').filter((l) => l.trim() && !l.trimStart().startsWith(';')).length
      return { ok: true, objects, stderr: r.stderr }
    },
    async restoreInto(bin, conn, database, file) {
      // ★--no-owner / --no-privileges:演练库的属主与生产不一定同名(客户环境尤其),
      //   不加这两个会因为 role 不存在报一堆错,把「能恢复」误判成「恢复失败」。
      const args = [
        '-h', conn.host,
        '-p', String(conn.port),
        '-U', conn.user,
        '-d', database,
        '--no-owner',
        '--no-privileges',
        '--no-password',
        file,
      ]
      const r = await run(bin, args, { PGPASSWORD: conn.password })
      return { exitCode: r.exitCode, stderr: r.stderr }
    },
  }
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (d) => hash.update(d)).on('end', () => resolve()).on('error', reject)
  })
  return hash.digest('hex')
}
