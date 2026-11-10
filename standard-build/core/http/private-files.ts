// core/http/private-files.ts
// 私有文件的出站改写中间件 + 带票据的下载端点。设计说明见 core/storage/private-url.ts。
//
// 中间件:响应 JSON 里凡是 `storage:private/<key>`,统一换成 `/api/files/<key>?t=<票据>`。
//   → 前端拿到的就是能直接塞进 <img src> / <a href> 的地址,各展示点一行都不用改。
// 端点:校验票据(HMAC:租户+key+过期时刻)后放行 —— 云存储 302 到预签名 URL,本地存储读盘返回。
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { Ctx, Db } from '../db/client'
import { resolveActiveBackend } from '../storage/config'
import { PRIVATE_URL_PREFIX, TICKET_TTL_SEC, signedDownloadPath, verifyFileTicket } from '../storage/private-url'
import { presignedCloudUrl, readLocalObject } from '../storage/service'
import type { AppEnv } from './middleware'

// 与 migrate.ts 同口径的最小扩展名 → MIME(私有附件多为发票/合同/证件)
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ofd: 'application/octet-stream',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8',
}
function guessContentType(key: string): string {
  return MIME_BY_EXT[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/**
 * 出站改写:把响应 JSON 里的私有标记换成带票据的下载地址。
 * ★只处理 JSON 且确实含标记的响应(绝大多数响应不含 → 一次 indexOf 就返回,开销可忽略)。
 * ★票据按当前登录租户签发,跨租户拿到别人的 key 也签不出能用的票据。
 */
export function signPrivateFileUrls(secret: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next()
    const res = c.res
    if (!res || !(res.headers.get('content-type') || '').includes('application/json')) return
    const ctx = c.get('ctx') as Ctx | undefined
    if (!ctx?.tenantId) return // 未鉴权响应里不该有私有文件
    const text = await res.clone().text()
    if (!text.includes(PRIVATE_URL_PREFIX)) return
    // JSON 字符串里的 key 不含 " 与 \(safeName 已消毒路径分隔符),按非引号片段整体取出
    const replaced = text.replace(new RegExp(`${PRIVATE_URL_PREFIX}([^"\\\\]+)`, 'g'), (_m, key: string) =>
      signedDownloadPath(key, ctx.tenantId, secret),
    )
    const headers = new Headers(res.headers)
    headers.delete('content-length') // 改写后长度变了,交给运行时重算
    c.res = new Response(replaced, { status: res.status, headers })
  }
}

/**
 * 私有文件下载:`GET /api/files/<key>?t=<票据>`。
 * ★不挂 requireAuth —— 票据本身就是凭证(<img>/<a> 带不了 Authorization 头)。票据短时效且绑定租户+key。
 */
export function privateFileRoutes(db: Db, secret: string) {
  return new Hono<AppEnv>().get('/:key{.+}', async (c) => {
    const key = c.req.param('key')
    const tenantId = verifyFileTicket(key, c.req.query('t') ?? '', secret)
    if (!tenantId) {
      return c.json({ error: { code: 'FORBIDDEN', message: '下载链接无效或已过期,请刷新页面重试' } }, 403)
    }

    // 本地磁盘优先(local 模式,以及切云之前的历史文件);readLocalObject 自带防穿越
    const local = await readLocalObject(key)
    if (local) {
      return new Response(new Uint8Array(local), {
        headers: {
          'Content-Type': guessContentType(key),
          'Cache-Control': 'private, max-age=300',
          // ★私有附件是**任意员工传上来的**(报销发票、需求附件、合同扫描件…),这里是它们唯一的
          //   出站口。三道:不许按内容猜类型(否则 text/plain 的 HTML 仍可能被当页面渲染)、
          //   放进无源沙箱(顶层打开时脚本禁用)、不允许被 iframe 嵌进别的页面。
          //   MIME_BY_EXT 表外的扩展名本来就回 application/octet-stream(浏览器下载而非渲染),
          //   这三个头是兜住表内那些可渲染类型的。
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          'X-Frame-Options': 'DENY',
        },
      })
    }

    // 云端:302 到预签名 URL(桶私有,匿名直链会 AccessDenied)
    const ctx: Ctx = { tenantId, employeeId: '' } // 仅用于解析该租户的存储后端,不做业务写
    const backend = await resolveActiveBackend(db, ctx)
    const signed = await presignedCloudUrl(backend, key, TICKET_TTL_SEC)
    if (!signed) return c.json({ error: { code: 'NOT_FOUND', message: '文件不存在' } }, 404)
    return c.redirect(signed, 302)
  })
}
