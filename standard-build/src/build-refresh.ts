/**
 * 发版后的自愈刷新。
 *
 * 现象:页面开着(已登录)的时候服务器发了新版 —— vite 产物是内容哈希文件名,旧 HTML 里
 * 记着的 `/assets/XxxPage-<旧哈希>.js` 已经随发版删掉,再点进任何一个懒加载页面就是
 * 「页面加载失败」,手动刷新才好。
 *
 * ★别指望靠错误内容认出这件事:SPA 兜底会把这个 404 回成 index.html(见 core/http/app.ts
 *   末尾那段),于是浏览器报的是 MIME 类型错而不是 404;不同浏览器、装在壳里的 WebView
 *   文案还各不一样。所以这里不认错误,改成直接去问服务器一句:**现在的 index.html 入口
 *   脚本还是不是我手上这份**。
 *
 * 判据只有两种结局:
 *   - 入口哈希变了 = 真发版了 → 自动刷新一次;
 *   - 一样、或者压根请求不通(断网 / 后端还没起来)→ **不刷**,让错误页照常显示。
 *     把真故障藏进一个自动刷新循环,比多点一次「重新加载」糟得多。
 *
 * ⚠️ 刻意**不做**后台轮询版本号那种「发现新版就刷新」:那会在用户正填表的时候把输入冲掉。
 *   这里只在「某个页面已经加载失败、屏幕上本来就没内容」时才动手,没有东西可丢。
 */

/** 刷过一次的时间戳。刷完还失败说明不是发版能解释的,别再刷第二次。 */
const RELOADED_AT_KEY = 'standard-build.build-refresh.at'
const COOLDOWN_MS = 60_000

/** 从一段 HTML 里取入口 module 脚本的 src(vite 产物里有且只有一个)。 */
function entryScriptOf(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']module["']/i.test(tag)) continue
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)
    if (src) return src[1] ?? null
  }
  return null
}

/** 当前这份页面加载的入口脚本。取不到就返回 null —— 判不出来就不刷。 */
function currentEntryScript(): string | null {
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null
}

function reloadedAt(): number {
  try {
    return Number(sessionStorage.getItem(RELOADED_AT_KEY) ?? 0)
  } catch {
    return 0 // 隐私模式没有 sessionStorage:当作没刷过,最坏情况是多刷一次
  }
}

function markReloaded() {
  try {
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()))
  } catch {
    /* 同上:记不下就记不下,冷却窗口失效不影响正确性(新 HTML 的入口哈希会兜住循环) */
  }
}

/**
 * 确认「加载失败是因为服务器发了新版」就刷新页面。
 * @returns 是否已经开始刷新(true 时调用方不必再显示错误页,页面马上就走了)
 */
export async function reloadIfStaleBuild(): Promise<boolean> {
  const mine = currentEntryScript()
  if (!mine) return false

  const last = reloadedAt()
  if (last && Date.now() - last < COOLDOWN_MS) return false

  let html: string
  try {
    // 问的是当前这条路径:未命中的前端路由同样由 SPA 兜底回 index.html,拿到的就是最新那份。
    const res = await fetch(window.location.pathname, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    })
    if (!res.ok) return false
    html = await res.text()
  } catch {
    return false // 网络不通 / 后端没起来 —— 刷新解决不了,别刷
  }

  const latest = entryScriptOf(html)
  if (!latest || latest === mine) return false

  markReloaded()
  window.location.reload()
  return true
}
