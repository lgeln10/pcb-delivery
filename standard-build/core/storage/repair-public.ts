// core/storage/repair-public.ts
// 一次性修复:私有桶启用前上传的**公开文件**(系统 logo / 官网图片)当初没打 public-read ACL,
// 桶是私有的 → 官网访客与登录页拿不到图。这里扫出这些对象的 key,逐个重打 public-read。
// ★只处理公开前缀(branding/ 与 website/);私有文件绝不在此列(它们本就该私有,走票据下载)。
import { sql } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { resolveActiveBackend } from './config'
import { StorageError } from './errors'
import { setObjectPublicRead } from './service'

/** 公开文件所在的列(与 migrate.ts 的 FILE_COLUMNS 同源,只挑放公开图的那几列)。 */
const PUBLIC_COLUMNS: { table: string; column: string }[] = [
  { table: 'app_settings', column: 'logo_url' },
]

// 公开对象 key:branding/... 或 website/...,止于引号/空白/括号等 JSON 分隔符
const PUBLIC_KEY_RE = /(?:branding|website)\/[^\s"'<>(){},\\]+/g

export type PublicAclRepairSummary = { provider: string; objectsFixed: number; failed: { key: string; reason: string }[] }

async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column} limit 1`,
  )) as { rows: unknown[] }
  return r.rows.length > 0
}

/**
 * 扫本租户数据里引用到的公开文件 key,逐个重打 public-read。幂等(重复跑只是再设一次同样的 ACL)。
 */
export async function repairPublicObjectAcl(db: Db, ctx: Ctx): Promise<PublicAclRepairSummary> {
  const backend = await resolveActiveBackend(db, ctx)
  if (backend.provider !== 'oss' && backend.provider !== 'tos') {
    throw new StorageError('STORAGE_NOT_CONFIGURED', '当前生效的不是云存储(OSS/TOS),无需修复对象权限')
  }

  const keys = new Set<string>()
  for (const { table, column } of PUBLIC_COLUMNS) {
    if (!(await columnExists(db, table, column))) continue // fork 未必有官网表
    const rows = (await db.execute(
      sql`select ${sql.raw(`"${column}"`)}::text as val from ${sql.raw(`"${table}"`)} where tenant_id = ${ctx.tenantId} and ${sql.raw(`"${column}"`)} is not null`,
    )) as { rows: { val: string | null }[] }
    for (const r of rows.rows) {
      for (const m of (r.val ?? '').matchAll(PUBLIC_KEY_RE)) keys.add(m[0])
    }
  }

  const summary: PublicAclRepairSummary = { provider: backend.provider, objectsFixed: 0, failed: [] }
  for (const key of keys) {
    try {
      await setObjectPublicRead(backend, key)
      summary.objectsFixed += 1
    } catch (err) {
      summary.failed.push({ key, reason: (err as Error).message })
    }
  }
  return summary
}
