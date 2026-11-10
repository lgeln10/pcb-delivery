// core/http/security-headers.ts
// 全站安全响应头。挂在最外层(所有路由之前),覆盖 API 响应、SPA 的 index.html、官网 HTML。
//
// ★为什么这套头在这个系统里格外重要:
//   登录令牌存在 localStorage(src/api/client.ts),而 core/auth/token.ts 是 HMAC **无状态**的。
//   在 token 变可吊销之前,任意一处同源 XSS = 完整账号接管且 7 天内无法止血。
//   CSP 的 script-src 是唯一能在「代码里真出了个 XSS」时还兜得住的一层。
//
// ★逐指令显式写,**不靠 default-src 兜底**:
//   default-src 会连带约束 connect-src 与 img-src,而本系统有两条真实的跨源需求 ——
//   ① 对象存储直传/预签名下载(OSS/火山,域名随租户配置而变,代码里列不全);
//   ② 开发态前端 vite(:5175)直连后端(VITE_API_BASE_URL)。
//   写死 'self' 会在客户环境里表现成「上传转圈但不报错」,那种故障比没有 CSP 更难查。
//   所以:script-src 收紧(这是防 XSS 的那条),连接与图片放宽到协议级。

import type { MiddlewareHandler } from 'hono'

/**
 * 默认策略。逐条的理由:
 * - `script-src 'self'`      —— **核心**。index.html 只有 `<script type="module" src="…">`,
 *                               无内联脚本;注入进来的 `<script>` 与 `onerror=` 都执行不了。
 *                               不给 'unsafe-eval':本仓源码无 eval / new Function。
 * - `style-src` 带 'unsafe-inline' —— 没得选:index.html 的启动骨架是内联 `<style>`,
 *                               Element Plus / Vue 也在运行时注入样式。内联样式不是取 token 的路径。
 * - `img-src` / `media-src`  —— data: 与 blob:(本地预览、Canvas 导出)+ https:(对象存储)。
 * - `connect-src 'self' https: wss:` —— 保住 OSS 直传与 SSE;仍挡掉明文 http: 的外发。
 * - `object-src 'none'`      —— 关掉 <object>/<embed> 这条老 XSS 通道。零风险。
 * - `base-uri 'self'`        —— 防注入 `<base href>` 把全站相对路径劫持到外部域。零风险。
 * - `form-action 'self'`     —— 防注入表单把凭据 POST 到外部。零风险。
 * - `frame-ancestors 'none'` —— 防点击劫持;比 X-Frame-Options 更准(后者仍为老浏览器保留)。
 */
const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' data: blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export type SecurityHeadersOptions = {
  /** 完整覆盖策略串。客户环境接了 CDN / 第三方脚本时用,免得为了一个域名改代码重新发版。 */
  policy?: string
  /**
   * 只上报不拦截。**排障用,不是常态** —— 开着它 CSP 一条都不生效。
   * 客户现场怀疑是 CSP 打断了功能时,先开这个看控制台报哪条,再决定是加白名单还是改代码。
   */
  reportOnly?: boolean
  /**
   * 允许把本站嵌进哪些来源的 iframe。留空 = `'none'`(谁都不许嵌,默认)。
   *
   * ★为什么这一条要单独开口子,而不是让客户去整条覆盖 `CSP_POLICY`:
   *   本系统**真的会被嵌**。飞书「网页应用」在桌面/移动客户端里是 webview(不受影响),
   *   但在**浏览器版飞书工作台里是 iframe**;`src/nav-collapse.ts` 里那句
   *   「禁用第三方存储的 iframe 里访问 localStorage 本身就会抛」就是这种场景踩出来的。
   *   让客户为了放行一个来源而重抄整条策略,大概率会连 script-src 一起抄松 ——
   *   那就把最要紧的那条弄丢了。
   *
   *   例:`CSP_FRAME_ANCESTORS="https://*.feishu.cn https://*.larksuite.com"`
   */
  frameAncestors?: string
}

/**
 * 从环境变量读配置。
 * - `CSP_POLICY`         整条覆盖
 * - `CSP_REPORT_ONLY=1`  降级为只上报
 * - `CSP_FRAME_ANCESTORS` 允许被哪些来源嵌(空 = 谁都不许)
 */
export function securityHeadersOptionsFromEnv(env = process.env): SecurityHeadersOptions {
  return {
    policy: env.CSP_POLICY?.trim() || undefined,
    reportOnly: env.CSP_REPORT_ONLY === '1',
    frameAncestors: env.CSP_FRAME_ANCESTORS?.trim() || undefined,
  }
}

export function buildCsp(opts: SecurityHeadersOptions = {}): string {
  if (opts.policy) return opts.policy
  if (!opts.frameAncestors) return DEFAULT_CSP
  return DEFAULT_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${opts.frameAncestors}`)
}

/**
 * 安全响应头中间件。
 *
 * ★不覆盖已有的头:`/uploads/*` 与 `/api/files` 对用户上传的文件用的是更严的
 *   `Content-Security-Policy: sandbox`(把文件放进无源沙箱)。那两处自己设过头,
 *   这里就不能再拿全站策略去盖 —— 否则等于把刚收窄的那道闸又打开。
 */
export function securityHeaders(opts: SecurityHeadersOptions = {}): MiddlewareHandler {
  const csp = buildCsp(opts)
  const cspHeader = opts.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'
  const allowsFraming = Boolean(opts.frameAncestors) || !csp.includes("frame-ancestors 'none'")
  return async function securityHeadersHandler(c, next) {
    await next()
    const h = c.res.headers
    if (!h.has('Content-Security-Policy') && !h.has('Content-Security-Policy-Report-Only')) {
      h.set(cspHeader, csp)
    }
    if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff')
    // ★允许被嵌时**不能**再发 X-Frame-Options:它只有 DENY/SAMEORIGIN,表达不了「只允许某个来源」,
    //   而老浏览器优先认它 —— 发出去就等于把 frame-ancestors 的白名单作废,客户改了 env 却依然打不开。
    if (!allowsFraming && !h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY')
    // no-referrer-when-downgrade 是浏览器默认,会把完整 URL(含 :id)发给外链站点。
    // strict-origin-when-cross-origin:同源保留完整路径,跨源只给 origin。
    if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    // 默认关掉本系统用不到的高权限设备接口(定位/摄像头/麦克风由具体页面按需再开)。
    if (!h.has('Permissions-Policy')) h.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()')
  }
}
