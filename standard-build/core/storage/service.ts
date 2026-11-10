// core/storage/service.ts
// 统一文件后端:所有模块的上传/下载都经这里,按当前租户「系统设置 → 文件存储」选定的 provider 落地。
//   putObject   → 写到 local / OSS / TOS,返回外网可访问 URL + storage key
//   readObject  → 按 key 读回字节(本地磁盘优先;云端走公共读 HTTP 拉取)
//   deleteObject→ 尽力而为删除(失败只告警)
// ★下载口径(2026-07 起):桶保持**私有**。
//   - 私有文件(合同/发票/报销/付款/HR/审批附件/需求附件):入库存内部标记 storage:private/<key>,
//     出站由 core/http/private-files.ts 换成带票据的 /api/files/<key>;云端最终走预签名 URL。
//   - 公开文件(官网内容 website、系统 logo branding):上传打 public-read ACL,存直链
//     —— 官网访客与登录页未鉴权就要看到它们,走不了票据。
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Ctx, Db } from '../db/client'
import { resolveActiveBackend, resolveProviderCreds, type ActiveBackend } from './config'
import { StorageError } from './errors'
import type { ResolvedCreds, StorageProviderId } from './providers'
import { privateMarker } from './private-url'

/** 本地上传根目录(与 core/http/app.ts 的 /uploads 静态路由一致)。默认 <cwd>/uploads。 */
export const UPLOAD_DIR = resolve(process.cwd(), process.env.UPLOAD_DIR || 'uploads')

/** 文件名消毒:去路径分隔、空白转 _,限长。配 uuid 前缀防覆盖与穿越。 */
function safeName(filename: string): string {
  const base = filename.replace(/[/\\]/g, '_').replace(/\s+/g, '_').trim() || 'file'
  return base.slice(-80)
}

/**
 * 本地存储外网绝对前缀:优先 PUBLIC_BASE_URL;缺省回退部署域名 NGINX_SERVER_NAME(纯主机名补 https);
 * 皆无则返回空串(相对路径)。落库链接带域名才能被外部拉取。
 */
export function localPublicBase(): string {
  const explicit = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '')
  if (explicit) return explicit
  const domain = (process.env.NGINX_SERVER_NAME || '').trim().replace(/\/$/, '')
  if (domain) return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  return ''
}

/** 云端对象的公开访问 URL:优先自定义域名 publicBase,否则按 provider 拼默认虚拟主机域名。 */
function cloudPublicUrl(provider: 'oss' | 'tos', creds: ResolvedCreds, key: string): string {
  if (creds.publicBase) return `${creds.publicBase.replace(/\/$/, '')}/${key}`
  if (provider === 'oss') {
    // region 在 URL 里带 oss- 前缀;用户填 cn-hangzhou 或 oss-cn-hangzhou 都归一。
    const host = creds.endpoint || `${/^oss-/.test(creds.region) ? creds.region : `oss-${creds.region}`}.aliyuncs.com`
    return `https://${creds.bucket}.${host.replace(/^https?:\/\//, '')}/${key}`
  }
  // tos:endpoint 必填(如 tos-cn-beijing.volces.com),虚拟主机风格 <bucket>.<endpoint>
  return `https://${creds.bucket}.${creds.endpoint.replace(/^https?:\/\//, '')}/${key}`
}

async function ossClient(creds: ResolvedCreds) {
  const OSSClient = (await import('ali-oss')).default
  return new OSSClient({
    region: /^oss-/.test(creds.region) ? creds.region : `oss-${creds.region}`,
    bucket: creds.bucket,
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    ...(creds.endpoint ? { endpoint: creds.endpoint } : {}),
  })
}

async function tosClient(creds: ResolvedCreds) {
  // 可选依赖:仅启用 TOS 时才加载。用变量 specifier 避免未安装时 typecheck 报错(生产 npm install 会装)。
  const spec = '@volcengine/tos-sdk'
  const mod: any = await import(spec)
  const TosClient = mod.TosClient ?? mod.default?.TosClient ?? mod.default
  return new TosClient({
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    region: creds.region,
    endpoint: creds.endpoint,
  })
}

/** visibility:'private'(默认,走票据下载)/ 'public'(官网与 logo,打 public-read 存直链)。 */
export type FileVisibility = 'private' | 'public'
export type PutInput = { bytes: Buffer; filename: string; contentType: string; keyPrefix: string; visibility?: FileVisibility }
export type StoredFile = { url: string; key: string }

/** 上传一个对象。key = `${keyPrefix}/${uuid}-${safeName}`,provider 由租户配置决定。 */
export async function putObject(db: Db, ctx: Ctx, input: PutInput): Promise<StoredFile> {
  const key = `${input.keyPrefix.replace(/\/+$/, '')}/${randomUUID()}-${safeName(input.filename)}`
  const backend = await resolveActiveBackend(db, ctx)

  const isPublic = input.visibility === 'public'

  if (backend.provider === 'oss' && backend.creds) {
    try {
      const client = await ossClient(backend.creds)
      const headers: Record<string, string> = { 'Content-Type': input.contentType }
      if (isPublic) headers['x-oss-object-acl'] = 'public-read' // 公开文件不依赖桶级 ACL
      const res = await client.put(key, input.bytes, { mime: input.contentType, headers })
      if (!isPublic) return { url: privateMarker(key), key }
      const url = backend.creds.publicBase ? cloudPublicUrl('oss', backend.creds, key) : (res as { url: string }).url
      return { url, key }
    } catch (err) {
      throw new StorageError('STORAGE_PROVIDER_ERROR', `阿里云 OSS 上传失败:${(err as Error).message}`)
    }
  }

  if (backend.provider === 'tos' && backend.creds) {
    try {
      const client = await tosClient(backend.creds)
      await client.putObject({
        bucket: backend.creds.bucket,
        key,
        body: input.bytes,
        contentType: input.contentType,
        ...(isPublic ? { acl: 'public-read' } : {}),
      })
      return { url: isPublic ? cloudPublicUrl('tos', backend.creds, key) : privateMarker(key), key }
    } catch (err) {
      throw new StorageError('STORAGE_PROVIDER_ERROR', `火山引擎 TOS 上传失败:${(err as Error).message}`)
    }
  }

  // local:写 UPLOAD_DIR。公开文件走 nginx 静态 /uploads/*;私有文件同样走票据下载(读盘由 /api/files 负责)
  const dest = join(UPLOAD_DIR, key)
  await mkdir(resolve(dest, '..'), { recursive: true })
  await writeFile(dest, input.bytes)
  return { url: isPublic ? `${localPublicBase()}/uploads/${key}` : privateMarker(key), key }
}

/**
 * 只读本地磁盘上的对象(供本地→云迁移判定文件是否还在本地)。防穿越:解析后须仍在 UPLOAD_DIR 内。
 * 本地不存在返回 null(不回落云端)。
 */
export async function readLocalObject(key: string): Promise<Buffer | null> {
  const full = resolve(UPLOAD_DIR, key)
  if (full !== UPLOAD_DIR && !full.startsWith(UPLOAD_DIR + '/')) throw new StorageError('INVALID_INPUT', '非法文件 key')
  try {
    return await readFile(full)
  } catch {
    return null
  }
}

/**
 * 把给定字节以**指定 key**(保 key,不重新生成)上传到给定云 backend。仅 oss/tos。返回外网可访问 URL。
 * 供「本地→云存储」迁移:每个本地文件按原 key 重传,URL 由此函数返回、逐一改写数据指向。
 */
export async function putObjectAtKey(
  backend: ActiveBackend,
  key: string,
  bytes: Buffer,
  contentType: string,
  visibility: FileVisibility = 'private',
): Promise<string> {
  const isPublic = visibility === 'public'
  if (backend.provider === 'oss' && backend.creds) {
    try {
      const client = await ossClient(backend.creds)
      const headers: Record<string, string> = { 'Content-Type': contentType }
      if (isPublic) headers['x-oss-object-acl'] = 'public-read'
      const res = await client.put(key, bytes, { mime: contentType, headers })
      if (!isPublic) return privateMarker(key)
      return backend.creds.publicBase ? cloudPublicUrl('oss', backend.creds, key) : (res as { url: string }).url
    } catch (err) {
      throw new StorageError('STORAGE_PROVIDER_ERROR', `阿里云 OSS 上传失败:${(err as Error).message}`)
    }
  }
  if (backend.provider === 'tos' && backend.creds) {
    try {
      const client = await tosClient(backend.creds)
      await client.putObject({ bucket: backend.creds.bucket, key, body: bytes, contentType, ...(isPublic ? { acl: 'public-read' } : {}) })
      return isPublic ? cloudPublicUrl('tos', backend.creds, key) : privateMarker(key)
    } catch (err) {
      throw new StorageError('STORAGE_PROVIDER_ERROR', `火山引擎 TOS 上传失败:${(err as Error).message}`)
    }
  }
  throw new StorageError('STORAGE_NOT_CONFIGURED', '目标存储不是云存储(OSS/TOS)或未配置连接参数')
}

/**
 * 云端对象的**预签名**下载 URL(私有桶必需:匿名直链会 AccessDenied)。仅 oss/tos;本地返回 null。
 * 纯本地 HMAC 计算,不发网络请求。
 */
export async function presignedCloudUrl(backend: ActiveBackend, key: string, ttlSec: number): Promise<string | null> {
  if (backend.provider === 'oss' && backend.creds) {
    const client = await ossClient(backend.creds)
    return (client as unknown as { signatureUrl: (k: string, o: { expires: number }) => string }).signatureUrl(key, { expires: ttlSec })
  }
  if (backend.provider === 'tos' && backend.creds) {
    const client = await tosClient(backend.creds)
    const out = await client.getPreSignedUrl({ bucket: backend.creds.bucket, key, expires: ttlSec })
    return typeof out === 'string' ? out : (out as { signedUrl?: string })?.signedUrl ?? null
  }
  return null
}

/**
 * 按 key 读回字节。本地磁盘存在则读本地(兼容切换 provider 前的历史文件);
 * 否则从当前云端后端的公开 URL 拉取(公共读桶)。
 */
export async function readObject(db: Db, ctx: Ctx, key: string): Promise<Buffer> {
  // 防穿越:解析后的路径必须仍落在 UPLOAD_DIR 内(允许 unicode 文件名,只拦 ../ 越界)
  const full = resolve(UPLOAD_DIR, key)
  if (full !== UPLOAD_DIR && !full.startsWith(UPLOAD_DIR + '/')) throw new StorageError('INVALID_INPUT', '非法文件 key')
  try {
    return await readFile(full)
  } catch {
    // 本地没有 → 走云端
  }
  // 云端:走 SDK 带签名读取(桶是私有的,匿名 HTTP 直链会 AccessDenied)
  const backend = await resolveActiveBackend(db, ctx)
  if (backend.provider === 'oss' && backend.creds) {
    try {
      const client = await ossClient(backend.creds)
      const r = (await client.get(key)) as { content?: Buffer }
      if (!r?.content) throw new Error('empty content')
      return Buffer.from(r.content)
    } catch (err) {
      throw new StorageError('STORAGE_PROVIDER_ERROR', `读取云端文件失败:${(err as Error).message}`)
    }
  }
  if (backend.provider === 'tos' && backend.creds) {
    try {
      const client = await tosClient(backend.creds)
      const r: any = await client.getObjectV2({ bucket: backend.creds.bucket, key, dataType: 'buffer' })
      const buf = r?.data?.content ?? r?.data
      if (!buf) throw new Error('empty content')
      return Buffer.from(buf)
    } catch (err) {
      throw new StorageError('STORAGE_PROVIDER_ERROR', `读取云端文件失败:${(err as Error).message}`)
    }
  }
  throw new StorageError('STORAGE_PROVIDER_ERROR', '文件不存在或无法读取')
}

/** 尽力而为删除(失败只告警,不阻塞业务软删除元数据)。 */
export async function deleteObject(db: Db, ctx: Ctx, key: string): Promise<void> {
  const backend: ActiveBackend = await resolveActiveBackend(db, ctx)
  try {
    if (backend.provider === 'oss' && backend.creds) {
      const client = await ossClient(backend.creds)
      await client.delete(key)
      return
    }
    if (backend.provider === 'tos' && backend.creds) {
      const client = await tosClient(backend.creds)
      await client.deleteObject({ bucket: backend.creds.bucket, key })
      return
    }
    const full = resolve(UPLOAD_DIR, key)
    if (full === UPLOAD_DIR || full.startsWith(UPLOAD_DIR + '/')) await rm(full, { force: true })
  } catch (err) {
    console.warn(`[storage] delete failed for ${key}:`, (err as Error).message)
  }
}

/**
 * 给已存在的云端对象重打 public-read。
 * 用途:私有桶启用前上传的公开文件(系统 logo、官网图片)当初没打 ACL,桶转私有后打不开 —— 一次性修复。
 */
export async function setObjectPublicRead(backend: ActiveBackend, key: string): Promise<void> {
  if (backend.provider === 'oss' && backend.creds) {
    const client = await ossClient(backend.creds)
    await (client as unknown as { putACL: (k: string, acl: string) => Promise<unknown> }).putACL(key, 'public-read')
    return
  }
  if (backend.provider === 'tos' && backend.creds) {
    const client = await tosClient(backend.creds)
    await client.putObjectAcl({ bucket: backend.creds.bucket, key, acl: 'public-read' })
    return
  }
  throw new StorageError('STORAGE_NOT_CONFIGURED', '当前不是云存储(OSS/TOS),无需修复对象权限')
}

/**
 * 测试某 provider 的连接:用其已保存的参数上传一个 1 字节探针再删除。
 * 成功返回,失败抛 STORAGE_PROVIDER_ERROR(带厂商报错 message,供 UI 提示)。
 */
export async function testProvider(db: Db, ctx: Ctx, provider: string): Promise<void> {
  if (provider !== 'oss' && provider !== 'tos') throw new StorageError('INVALID_INPUT', `不支持测试的 provider: ${provider}`)
  const creds = await resolveProviderCreds(db, ctx, provider)
  if (!creds) throw new StorageError('STORAGE_NOT_CONFIGURED', '请先填完并保存参数（含 AccessKey Secret）再测试')
  const key = `_probe/${randomUUID()}.txt`
  const bytes = Buffer.from('ok')
  try {
    if (provider === 'oss') {
      const client = await ossClient(creds)
      await client.put(key, bytes, { mime: 'text/plain', headers: { 'Content-Type': 'text/plain' } })
      await client.delete(key)
    } else {
      const client = await tosClient(creds)
      await client.putObject({ bucket: creds.bucket, key, body: bytes, contentType: 'text/plain' })
      await client.deleteObject({ bucket: creds.bucket, key })
    }
  } catch (err) {
    throw new StorageError('STORAGE_PROVIDER_ERROR', `连接失败:${(err as Error).message}`)
  }
}

export type { StorageProviderId }
