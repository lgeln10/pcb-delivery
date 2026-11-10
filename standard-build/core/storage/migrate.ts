// core/storage/migrate.ts
// 「一键把本地磁盘 /uploads 文件迁移到云存储」的实现:把当前租户各业务表里引用到的本地文件,
// 按**原 key** 重传到当前生效的云 backend(OSS/TOS),再把这些行里的本地 URL 改写成云端 URL。
//   ★保留本地文件做备份(不删);★仅当前租户;★前提=当前生效存储必须是云(否则抛错)。
// key 与 provider 无关(putObject 生成的 key 里不含 provider 信息),故 *_key 列无需改;只改 *_url / 附件 JSON。
import { sql } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import type { ActiveBackend } from './config'
import { resolveActiveBackend } from './config'
import { StorageError } from './errors'
import { putObjectAtKey, readLocalObject } from './service'

// ── 待改写的文件列(以后新增「存文件 URL 的列」在此登记)。类型决定回写时的强制转换。──────────────
type ColType = 'text' | 'text[]' | 'jsonb'
type FileColumn = { table: string; column: string; type: ColType }
export const FILE_COLUMNS: FileColumn[] = [
  { table: 'app_settings', column: 'logo_url', type: 'text' },
]

const UPLOADS_MARKER = '/uploads/'
// 匹配本地文件 URL:绝对(任意 http 主机含 /uploads/)或相对(/uploads/ 开头)。分隔符止于引号/空白/括号/逗号/花括号/反斜杠。
const LOCAL_URL_RE = /(https?:\/\/[^\s"'<>(){},\\]*\/uploads\/[^\s"'<>(){},\\]+|\/uploads\/[^\s"'<>(){},\\]+)/g

/** 从一段文本(text 值 / jsonb::text / text[]::text)里抽出所有本地文件 URL,去重保序。 */
export function extractLocalUrls(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(LOCAL_URL_RE)) seen.add(m[0])
  return [...seen]
}

/** 从本地 URL 反推存储 key = `/uploads/` 之后的部分(绝对/相对同解)。 */
export function keyFromLocalUrl(url: string): string {
  const i = url.indexOf(UPLOADS_MARKER)
  return i < 0 ? '' : url.slice(i + UPLOADS_MARKER.length)
}

/**
 * 纯替换:把 text 里每个本地 URL 换成 mapping 里的云端 URL(无映射则保留)。
 * ★先替换更长的 URL(绝对含相对为子串),防相对形先替换污染绝对形。
 */
export function replaceUrls(text: string, mapping: Map<string, string>): string {
  const olds = [...mapping.keys()].sort((a, b) => b.length - a.length)
  let out = text
  for (const oldUrl of olds) out = out.split(oldUrl).join(mapping.get(oldUrl)!)
  return out
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  bmp: 'image/bmp', gif: 'image/gif', svg: 'image/svg+xml', ofd: 'application/octet-stream',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
}
function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column} limit 1`,
  )) as { rows: unknown[] }
  return r.rows.length > 0
}

export type MigrationSummary = {
  provider: string
  filesMigrated: number
  filesSkipped: { key: string; reason: string }[]
  rowsUpdated: number
  byTable: Record<string, number>
}

/**
 * 把当前租户各表引用到的本地文件迁移到当前生效的云存储,并改写这些行的文件指向。
 * 前提:当前生效存储必须是 OSS/TOS(否则抛 STORAGE_NOT_CONFIGURED)。本地文件不删除(备份)。幂等:重复运行时列里已无 /uploads/ → 空操作。
 */
export async function migrateLocalToActiveCloud(db: Db, ctx: Ctx): Promise<MigrationSummary> {
  const backend: ActiveBackend = await resolveActiveBackend(db, ctx)
  if (backend.provider !== 'oss' && backend.provider !== 'tos')
    throw new StorageError('STORAGE_NOT_CONFIGURED', '请先在「文件存储」启用并配置云存储(OSS/TOS)后再迁移')
  if (!backend.creds) throw new StorageError('STORAGE_NOT_CONFIGURED', '云存储连接参数缺失,无法迁移')

  // key → 云端 URL(缓存,一个文件只上传一次,被多处引用时共用)
  const uploaded = new Map<string, string>()
  const skipped = new Map<string, string>() // key → reason(去重)
  const byTable: Record<string, number> = {}
  let rowsUpdated = 0

  // 上传单个 key(缓存 + 跳过记账),返回云端 URL 或 null(本地文件缺失)。
  async function ensureUploaded(key: string): Promise<string | null> {
    if (uploaded.has(key)) return uploaded.get(key)!
    if (skipped.has(key)) return null
    const bytes = await readLocalObject(key)
    if (!bytes) { skipped.set(key, '本地磁盘无此文件(可能已在云端或已被清理)'); return null }
    const url = await putObjectAtKey(backend, key, bytes, guessContentType(key))
    uploaded.set(key, url)
    return url
  }

  for (const { table, column, type } of FILE_COLUMNS) {
    if (!(await columnExists(db, table, column))) continue // fork 可能缺表/列
    const tenantScoped = await columnExists(db, table, 'tenant_id')
    const rows = (await db.execute(
      sql`select id, ${sql.identifier(column)}::text as val from ${sql.identifier(table)}
          where ${sql.identifier(column)}::text like ${'%' + UPLOADS_MARKER + '%'}
          ${tenantScoped ? sql`and tenant_id = ${ctx.tenantId}` : sql``}`,
    )) as { rows: Array<{ id: unknown; val: string | null }> }

    for (const row of rows.rows) {
      const val = row.val
      if (!val) continue
      const urls = extractLocalUrls(val)
      if (urls.length === 0) continue
      const mapping = new Map<string, string>()
      for (const oldUrl of urls) {
        const cloudUrl = await ensureUploaded(keyFromLocalUrl(oldUrl))
        if (cloudUrl) mapping.set(oldUrl, cloudUrl)
      }
      if (mapping.size === 0) continue // 全部缺失 → 不改写
      const newVal = replaceUrls(val, mapping)
      if (newVal === val) continue
      const castSuffix = type === 'jsonb' ? sql`::jsonb` : type === 'text[]' ? sql`::text[]` : sql``
      await db.execute(
        sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${newVal}${castSuffix}
            where id = ${row.id as string}
            ${tenantScoped ? sql`and tenant_id = ${ctx.tenantId}` : sql``}`,
      )
      rowsUpdated++
      byTable[table] = (byTable[table] ?? 0) + 1
    }
  }

  return {
    provider: backend.provider,
    filesMigrated: uploaded.size,
    filesSkipped: [...skipped.entries()].map(([key, reason]) => ({ key, reason })),
    rowsUpdated,
    byTable,
  }
}
