// core/storage/private-url.ts
// 私有文件的「内部标记 URL」与「带票据的下载地址」互转。
//
// ★为什么要这套东西:前端是 `<img :src="url">` / `<a :href="url">` 直接用 URL 的,加不了 Authorization 头。
//   所以私有文件不能直接给一个需要鉴权头的地址。做法:
//   ① 私有文件入库存内部标记 `storage:private/<key>`(不是可访问地址,泄露也没用);
//   ② 出站时(core/http/private-files.ts 的中间件)统一改写成 `/api/files/<key>?t=<票据>`;
//   ③ 票据是 HMAC(租户+key+过期时间),短时效、不查库;/api/files 校验票据后放行。
//   这样桶保持私有,前端各展示点一行不用改。
import { createHmac, timingSafeEqual } from 'node:crypto'

/** 私有文件入库时写的内部标记前缀。绝不是可访问地址——出站中间件负责换成带票据的真实地址。 */
export const PRIVATE_URL_PREFIX = 'storage:private/'

/** 下载票据有效期(秒)。够一次页面浏览/下载,过期后刷新页面自动拿新票据。 */
export const TICKET_TTL_SEC = 900

export function isPrivateMarker(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith(PRIVATE_URL_PREFIX)
}

/** `storage:private/<key>` → `<key>`;不是标记则返回 null。 */
export function keyFromPrivateMarker(url: string): string | null {
  return url.startsWith(PRIVATE_URL_PREFIX) ? url.slice(PRIVATE_URL_PREFIX.length) : null
}

export function privateMarker(key: string): string {
  return `${PRIVATE_URL_PREFIX}${key}`
}

type TicketPayload = { tid: string; exp: number }

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** 签一张下载票据:内容 = 租户 + key + 过期时刻,任一被篡改都验不过。 */
export function signFileTicket(key: string, tenantId: string, secret: string, ttlSec = TICKET_TTL_SEC): string {
  const payload: TicketPayload = { tid: tenantId, exp: Math.floor(Date.now() / 1000) + ttlSec }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(`${body}|${key}`, secret)}`
}

/** 校验票据。通过返回 tenantId(用于解析该租户的存储后端);失败返回 null。 */
export function verifyFileTicket(key: string, ticket: string, secret: string): string | null {
  const dot = ticket.lastIndexOf('.')
  if (dot <= 0) return null
  const body = ticket.slice(0, dot)
  const got = ticket.slice(dot + 1)
  const want = sign(`${body}|${key}`, secret)
  // 定长比较防时序侧信道;长度不等直接判否(timingSafeEqual 要求等长)
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload
    if (!payload?.tid || typeof payload.exp !== 'number') return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null // 过期
    return payload.tid
  } catch {
    return null
  }
}

/** 内部标记 → 前端可直接使用的下载地址(key 逐段编码,兼容中文/空格文件名)。 */
export function signedDownloadPath(key: string, tenantId: string, secret: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  return `/api/files/${encoded}?t=${signFileTicket(key, tenantId, secret)}`
}

/**
 * ★把「带票据的下载地址」`/api/files/<key>?t=...` 归一回稳定内部标记 `storage:private/<key>`。
 * 用于「前端拿到上传响应(fileUrl 已被出站中间件改写成带票据地址)后原样回传、要落库」的场景:
 * 报销发票 / 付款单发票与附件 / 财务发票池 / 需求附件 等。**必须落稳定标记**,否则库里存的是一次性
 * 票据(15 分钟过期),文件很快就打不开。读取时出站中间件会把标记重新签发成新鲜票据。
 * 非本形态的值(http 直链 / 已是 storage:private 标记 / /uploads 相对路径 / null)原样返回。
 *
 * ★两层接线,查「这个模块归一了没有」要**两层都看**(2026-08-19 踩过):
 *   ① routes.ts 的 zod 字段 `.transform(normalizeStoredFileUrl)` —— 2026-07-25 建立的原始做法,
 *      从 core/storage/api.ts 转导入。reimbursement / finance / payment-voucher /
 *      general-request / feedback 五个模块走这层。
 *   ② logic.ts 落库前直接调 —— contract / document / website(及 fund 分支的 portal)走这层。
 * 幂等,套两次没有副作用。
 *
 * ★这是**约定,不是护栏**:新模块自己不会继承它。上面 ①②两批的分界线就是时间 ——
 *   2026-07-25 之后加的存文件 URL 的模块(contract/document/website/portal)全都漏了,
 *   一直到 2026-08-19 fund 官网公告附件打不开才被发现。加新的「客户端回传文件 URL 落库」
 *   字段时,自己记得套一层;没有任何东西会提醒你。
 */
export function normalizeStoredFileUrl<T extends string | null | undefined>(url: T): T {
  if (typeof url !== 'string') return url
  const m = /^\/api\/files\/([^?]+)(?:\?|$)/.exec(url)
  if (!m) return url
  const key = m[1]!.split('/').map(decodeURIComponent).join('/')
  return privateMarker(key) as T
}
