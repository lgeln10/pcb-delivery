// modules/app-settings/storage.ts
// 企业 logo 落地:统一走平台级 core/storage(按「系统设置 → 文件存储」选定 local/OSS/TOS),key 前缀 branding/。
// 返回外网可访问 URL,写进 app_settings.logo_url,供前端壳层加载。
import type { Ctx, Db } from '../../core/db/client'
import { putObject, type StoredFile } from '../../core/storage/api'

export type { StoredFile }

export async function storeLogo(
  db: Db,
  ctx: Ctx,
  input: { bytes: Buffer; filename: string; contentType: string },
): Promise<StoredFile> {
  // ★公开:系统 logo 在**未登录的登录页**就要显示(还被官网 llms.txt/结构化数据引用),走不了票据 → public-read 直链
  return putObject(db, ctx, { ...input, keyPrefix: 'branding', visibility: 'public' })
}
