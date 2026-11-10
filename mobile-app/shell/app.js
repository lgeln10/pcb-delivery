// 壳登录逻辑:域名 + 手机号 + 密码 → 原生 HTTP 调租户服务器登录 → 会话写入
// Preferences(原生存储,App 全局共享)→ 整个 webview 跳到租户域名跑 H5。
//
// 与 H5 的契约(standard-build/src/native-app.ts 同步维护,改 key 两边一起改):
//   aios.server       string  归一化后的租户 origin,如 https://ai.example.com
//   aios.session      string  JSON.stringify({ token, employee })  登录成功的会话
//                             ★同一份还会经 URL fragment 再递一次(见 enter());
//                               安卓上桥不在租户域名里,Preferences 那条会静默失效。
//   aios.lastPhone    string  上次登录手机号(预填)
//   aios.lastPassword string  上次登录密码(预填)★明文,见下面这段
//
// ★★★ 为什么存明文密码(2026-08-18 需求方明确要求,并选定「就用 Preferences」):
//   要的效果是「服务器抽风登不进去时,人停在这一页,三个字段都是填好的,直接再点一次登录」——
//   所以密码必须**跨冷启动**留着,只存在内存里不够。
//   代价说清楚:Preferences 在安卓是 SharedPreferences、iOS 是 UserDefaults,**都不加密** ——
//   拿到设备文件(root / 越狱 / 备份)就能直接读出密码。要收紧就换系统安全存储
//   (iOS Keychain / Android EncryptedSharedPreferences),那需要加一个 Capacitor 插件并重新出包。
//   另外:主动「退出登录」后密码也仍然留着(需求原话是「始终存储…除非用户自己改掉」),
//   共享设备上下一个人能直接登进来 —— 这是已知取舍,不是漏改。
//
// 登录接口契约(standard-build/core/auth/routes.ts):
//   POST /api/auth/login  { phone, password, tenantId? }
//   200 → { token, employee: { id, name, tenantId, phone } }
//   401 INVALID_CREDENTIALS · 409 AMBIGUOUS_TENANT(带 tenantId 重试)
//   403 EMPLOYEE_NOT_ACTIVE / TENANT_SUSPENDED · 错误体 { error: { code, message } }

const PREF_SERVER = 'aios.server'
const PREF_SESSION = 'aios.session'
const PREF_LAST_PHONE = 'aios.lastPhone'
const PREF_LAST_PASSWORD = 'aios.lastPassword'
// 存的是「同意了哪一版政策」而不是布尔值 —— 政策实质性变更时改下面这个日期,
// 老用户会被重新征求一次同意。存 true/false 的话政策改了没人知道。
const PREF_CONSENT = 'aios.privacyConsent'

// ★必须与官网那一页 app-privacy-content.ts 的 UPDATED 一致。两边不一致的表现是
//   「政策更新了但没人被重新问过」,而这正是监管检查会问的那一条。
const PRIVACY_VERSION = '2026-08-24'

// 完整隐私政策的公网地址。2026-08-25 定:base.sixamtech.ai(官网模块与管理端同机,按 Host 分发)。
//   ★口径变过一次:先定的是 www.6amtech.cn,但那个域名当时仍指向 Vercel 上的旧官网。
// ★ **切换完成之前这个地址是 404 的** —— 那个域名当前还指向 Vercel 上的旧官网。
//   这不是笔误,是刻意先把决定写下来:ios-release.sh 的 preflight 会真去抓它,
//   抓不到 200、或者抓到 200 但正文里没有隐私政策内容(SPA 空壳),就直接红。
//   也就是说**在这个页面真正上线之前,发不出去**——这正是我们要的。
//   切换清单见 standard-build/docs/design/APP_STORE_RELEASE.md §10。
const PRIVACY_POLICY_URL = 'https://base.sixamtech.ai/app-privacy'

/**
 * 壳版本号。会随扫码登录一起上报,显示在电脑的「我的登录设备」里 ——
 * 「哪个版本的 App 出的问题」不靠猜。
 * ★与 standard-build/src/native-app.ts 的 APP_SHELL_VERSION 是同一个东西,两边一起改。
 */
const APP_VERSION = '0.1.0'

const cap = window.Capacitor
const IS_NATIVE = Boolean(cap && cap.isNativePlatform && cap.isNativePlatform())

// ── 原生插件封装(浏览器预览时降级到 localStorage/fetch,便于开发自查)──────────
const prefs = IS_NATIVE
  ? {
      get: async (key) => (await cap.Plugins.Preferences.get({ key })).value,
      set: (key, value) => cap.Plugins.Preferences.set({ key, value }),
      remove: (key) => cap.Plugins.Preferences.remove({ key }),
    }
  : {
      get: async (key) => localStorage.getItem('aios.pref.' + key),
      set: async (key, value) => localStorage.setItem('aios.pref.' + key, value),
      remove: async (key) => localStorage.removeItem('aios.pref.' + key),
    }

// 返回 { status, data };只有网络层失败才 throw。
// ★壳的请求走 CapacitorHttp 插件(原生栈,不受 webview CORS 限制;后端的 CORS
//   allowlist 不含壳的本地 origin,浏览器 fetch 跨域必被拦,原生请求则无此约束)。
async function http(method, url, { token, body, timeoutMs = 15000 } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  if (IS_NATIVE) {
    const res = await cap.Plugins.CapacitorHttp.request({
      url,
      method,
      headers,
      data: body,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })
    let data = res.data
    if (typeof data === 'string' && data) {
      try { data = JSON.parse(data) } catch { /* 非 JSON 响应(如网关错误页)原样保留 */ }
    }
    return { status: res.status, data }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

// ── 工具 ─────────────────────────────────────────────────────────────────────
// 域名归一化:补 https、去路径、留 origin。只收 https(明文 http 在 iOS 会被 ATS
// 拦、安卓要开 cleartext,一律不支持,onprem 场景也已全量 https)。
function normalizeServer(input) {
  const raw = (input || '').trim()
  if (!raw) return { error: '请输入服务器地址' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return { error: '服务器地址格式不对,示例:ai.example.com' }
  }
  if (url.protocol !== 'https:') return { error: '仅支持 https 服务器地址' }
  // ★主机名必须带点,且不能含 userinfo。2026-08-02 加,理由:
  //   - 无点主机名(`localhost`、`aios`)在「只收 https」的前提下本来就用不了 —— 公开 CA
  //     不给无点主机签证书,自签证书 webview 又不认。放行只会让人打错字后看到
  //     「无法连接服务器」,而不是「地址格式不对」,白白多绕一圈。
  //   - `user@host` 形式 `new URL` 会**静默丢掉** user 部分照常返回 origin,粘错了发现不了。
  //   与 harmony-app 的 util/ServerUrl.ets 保持同一套规则(实测两边逐例对齐)。
  if (!url.hostname.includes('.') || url.username || url.password) {
    return { error: '服务器地址格式不对,示例:ai.example.com' }
  }
  return { origin: url.origin }
}

// token 是 base64url(payload).base64url(hmac),payload 含 exp(秒)。非 JWT,
// 但过期时间可以本地解出来,离线即可判死,省一次注定 401 的网络往返。
function tokenExpiresAt(token) {
  try {
    const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function apiErrorMessage(data, fallback) {
  return (data && data.error && data.error.message) || fallback
}
function apiErrorCode(data) {
  return (data && data.error && data.error.code) || ''
}

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)
const els = {
  consent: $('consent'), consentAgree: $('consentAgree'),
  consentDecline: $('consentDecline'), consentFull: $('consentFull'),
  boot: $('boot'), bootText: $('bootText'), bootCancel: $('bootCancel'),
  form: $('loginForm'), error: $('error'),
  server: $('server'), phone: $('phone'), password: $('password'),
  tenantField: $('tenantField'), tenantId: $('tenantId'),
  submit: $('submitBtn'), enterAnyway: $('enterAnywayBtn'),
  previewBanner: $('previewBanner'),
  scanner: $('scanner'), scanVideo: $('scanVideo'),
  qrLoginBtn: $('qrLoginBtn'), qrLoginSep: $('qrLoginSep'),
  scanHint: $('scanHint'), scanCancel: $('scanCancel'),
}

function showError(msg) {
  els.error.textContent = msg
  els.error.classList.toggle('show', Boolean(msg))
}
function showBoot(on, text) {
  if (text) els.bootText.textContent = text
  els.boot.classList.toggle('show', on)
}
function setBusy(on) {
  els.submit.disabled = on
  els.submit.textContent = on ? '登录中…' : '登 录'
}

// 会话交接给 H5 的**第二条**通道:URL fragment。
//
// ★为什么不能只靠 Preferences(2026-08-21 实测):安卓上 webview 一旦从
//   https://localhost 跳到租户域名,`window.Capacitor` 就没了 —— 桥不在,
//   H5 侧 `prefsPlugin()` 返回 null,壳写进 Preferences 的会话**没有任何人接得到**。
//   现象是「壳登录成功了,却落在 AIOS 登录页要你再输一遍」,且全程不报错。
//   iOS 不受影响(WKUserScript 跨 origin 注入),所以这条只在安卓上现形。
//
// fragment 是这里唯一可用的通道:它**不会**发往服务端(不进请求行、不进 Referer、
// 不进服务器日志),只在本机 webview 里传一次;H5 在挂载前读走并立刻用
// history.replaceState 抹掉(见 standard-build/src/native-app.ts 的 takeSessionFromHash)。
//
// 取舍写明白:这一跳里 token 短暂出现在同源页面的 location.hash 上,同源脚本读得到 ——
// 但 token 本来就要落进同一个源的 localStorage,同源 XSS 两者都拿得到,
// 所以这条通道**没有**放大既有风险面。真要收紧得走「一次性交换码 + 服务端兑换」,
// 那需要加接口和迁移,不在这次范围内。
const HANDOFF_PREFIX = '#aios-shell-session='

async function enter(origin) {
  await prefs.set(PREF_SERVER, origin)
  const sessionRaw = await prefs.get(PREF_SESSION)
  const frag = sessionRaw ? HANDOFF_PREFIX + encodeURIComponent(sessionRaw) : ''
  // replace 而非 href:壳登录页不进历史,安卓返回键不会退回到登录页
  window.location.replace(origin + '/' + frag)
}

// ── 启动:有存储会话 → 本地验过期 → 在线验 /api/me → 直接进入 ────────────────
/**
 * 首次启动的隐私政策同意闸。**在读任何存储、发任何请求之前**。
 *
 * ★为什么必须挡在最前面:国内应用商店的隐私合规检测就查这一条 ——
 *   「同意之前不得采集任何信息、不得申请任何权限」。而「采集」的口径很宽,
 *   读本机存的服务器地址与手机号也算。所以 boot() 的第一行就是 await 它。
 *
 * ★为什么存版本号不存布尔:政策实质性变更时要重新征求同意。存 true 的话,
 *   政策改了老用户永远不会被再问一次,而那恰恰是监管会查的点。
 */
async function requireConsent() {
  const agreed = await prefs.get(PREF_CONSENT)
  if (agreed === PRIVACY_VERSION) return

  if (PRIVACY_POLICY_URL) {
    els.consentFull.href = PRIVACY_POLICY_URL
    els.consentFull.hidden = false
  } else {
    // 没有可用地址时宁可不给链接 —— 一个点不动的「阅读完整政策」比没有更糟
    els.consentFull.hidden = true
  }
  els.consent.classList.add('show')

  await new Promise((resolve) => {
    els.consentAgree.addEventListener('click', async () => {
      await prefs.set(PREF_CONSENT, PRIVACY_VERSION)
      els.consent.classList.remove('show')
      // 告诉原生层:从这一刻起才可以注入设备信息(见 MainActivity.pushEnvironment)
      window.__AIOS_CONSENT__ = true
      resolve()
    }, { once: true })

    els.consentDecline.addEventListener('click', () => {
      // ★不同意就退出。让它「不同意也能继续用」等于这道闸不存在,
      //   而检测会真的去点那个「不同意」。
      const app = window.Capacitor?.Plugins?.App
      if (app && typeof app.exitApp === 'function') app.exitApp()
      else els.consentDecline.textContent = '需要同意隐私政策才能使用本应用'
    })
  })
}

let bootCancelled = false

async function boot() {
  if (!IS_NATIVE) els.previewBanner.classList.add('show')

  // ★第一件事。同意之前下面一行存储都不读 —— 见 requireConsent 的注释。
  await requireConsent()
  window.__AIOS_CONSENT__ = true

  // ★H5 主动退出时会带着这个标记跳回来。必须在读存储**之前**处理:
  //   桥不在的安卓上,H5 那句 `prefs.remove` 是空操作(prefsPlugin() 为 null),
  //   壳里那份会话还活着 —— 不认这个标记的话,下面几行会立刻判定「有活会话」
  //   然后 enter() 弹回租户域名,人眼里就是「退出登录只能回到 AIOS 登录页」。
  if (location.hash === '#logout') {
    history.replaceState(null, '', location.pathname + location.search)
    await prefs.remove(PREF_SESSION)
  }

  const [server, sessionRaw, lastPhone, lastPassword] = await Promise.all([
    prefs.get(PREF_SERVER), prefs.get(PREF_SESSION), prefs.get(PREF_LAST_PHONE), prefs.get(PREF_LAST_PASSWORD),
  ])
  // ★三个字段都预填:服务器出问题那次,人重启 App 回到这一页时是「填好的」而不是空白的,
  //   直接再点一次登录就行(需求原话:除非用户自己改掉)。
  if (server) els.server.value = server.replace(/^https:\/\//, '')
  if (lastPhone) els.phone.value = lastPhone
  if (lastPassword) els.password.value = lastPassword

  let session = null
  try { session = sessionRaw ? JSON.parse(sessionRaw) : null } catch { /* 存储损坏当作未登录 */ }
  if (!server || !session || !session.token) return

  const expiresAt = tokenExpiresAt(session.token)
  if (expiresAt !== null && expiresAt < Date.now() + 60_000) {
    await prefs.remove(PREF_SESSION)
    showError('登录已过期,请重新登录')
    return
  }

  showBoot(true, '正在进入…')
  try {
    const res = await http('GET', server + '/api/me', { token: session.token, timeoutMs: 10000 })
    if (bootCancelled) return
    if (res.status === 200) {
      await enter(server)
      return
    }
    showBoot(false)
    if (res.status === 401) {
      // token 被吊销/员工停用/租户停用:清会话,回到登录
      await prefs.remove(PREF_SESSION)
      showError('登录已过期,请重新登录')
    } else {
      showError(apiErrorMessage(res.data, `服务器校验失败(${res.status}),可稍后重试`))
      els.enterAnyway.classList.add('show')
    }
  } catch {
    if (bootCancelled) return
    // 网络不可达:不清会话(可能只是断网),给「仍然进入」逃生口
    showBoot(false)
    showError('无法连接服务器,请检查网络后重试')
    els.enterAnyway.classList.add('show')
  }
}

els.bootCancel.addEventListener('click', async () => {
  // ★扫码登录进行中时,这颗按钮的含义不一样:那时还没有会话可清,要中止的是轮询。
  //   不分支的话点它会去删一个不存在的会话、然后把人留在一个还在后台转的流程里。
  if (qrAbort) {
    qrAbort()
    return
  }
  bootCancelled = true
  showBoot(false)
  await prefs.remove(PREF_SESSION)
  els.password.focus()
})

els.enterAnyway.addEventListener('click', async () => {
  const server = await prefs.get(PREF_SERVER)
  if (server) await enter(server)
})

// ── 扫码填服务器地址 ──────────────────────────────────────────────────────────
//
// ★不加原生插件。壳的 webview 里 getUserMedia 本来就是通的,已逐条核实过:
//   · 安卓:Capacitor 的 BridgeWebChromeClient.onPermissionRequest 收到
//     `android.webkit.resource.VIDEO_CAPTURE` 会去申请 android.permission.CAMERA ——
//     该权限清单里早就有(H5 拍照上传要用),uses-feature 也是 required="false"。
//   · iOS:Capacitor 的 WebViewDelegationHandler 对 requestMediaCapturePermissionFor
//     直接 decisionHandler(.grant),Info.plist 的 NSCameraUsageDescription 也已在。
//   加一个扫码插件(ML Kit 那类)要多背 2MB+ 原生依赖,且安卓那条路多半还牵扯 Google 服务 ——
//   国产机上正是我们最不能依赖的东西(语音那个插件已经栽过一次)。
//
// ★解码两条路:优先浏览器原生 BarcodeDetector(安卓 WebView 有,零解码成本、零体积);
//   **iOS 的 WKWebView 至今不实现这个 API**,退回 vendor/jsqr.min.js。
//   jsQR 是**按需注入**的:127KB 挂在 index.html 上等于每次冷启动白解析一遍,
//   而冷启动路径正是这个壳反复优化的地方。

const DECODE_INTERVAL_MS = 120 // 每秒解 8 次够用;每帧都解会把低端机烤热且不会更快扫到

let jsQrPromise = null
/** 按需注入 vendor/jsqr.min.js,返回解码函数。失败会把 promise 清掉,允许下次重试。 */
function loadJsQr() {
  if (jsQrPromise) return jsQrPromise
  jsQrPromise = new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = 'vendor/jsqr.min.js'
    el.onload = () => {
      // UMD 打包在不同宿主下可能给到函数本身或 { default: fn },两种都收
      const fn = window.jsQR && (window.jsQR.default || window.jsQR)
      if (typeof fn === 'function') resolve(fn)
      else { jsQrPromise = null; reject(new Error('jsQR loaded but no decoder')) }
    }
    el.onerror = () => { jsQrPromise = null; reject(new Error('jsQR script failed')) }
    document.head.appendChild(el)
  })
  return jsQrPromise
}

/** 造一个 `(video) => Promise<string|null>` 的解码器。 */
async function makeDecoder() {
  if (typeof window.BarcodeDetector === 'function') {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats()
      if (formats && formats.indexOf('qr_code') !== -1) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
        return async (video) => {
          const codes = await detector.detect(video)
          return codes && codes.length ? codes[0].rawValue : null
        }
      }
    } catch {
      // ★有这个类**不代表能用**:部分 WebView 造出来就抛 NotSupportedError。
      //   所以判据是「真的构造 + 真的问过支持的格式」,不是 'BarcodeDetector' in window。
    }
  }

  const jsQR = await loadJsQr()
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return async (video) => {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null
    // 降采样到长边 640:1080p 整帧纯 JS 解码在低端机上一帧要几百毫秒,而二维码在 640 下绰绰有余
    const scale = Math.min(1, 640 / Math.max(vw, vh))
    canvas.width = Math.round(vw * scale)
    canvas.height = Math.round(vh * scale)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
    return found && found.data ? found.data : null
  }
}

/**
 * 码里那串东西 → `{ server, ticket }`。四种形态:
 *   纯域名 `ai.example.com` / 完整 URL `https://ai.example.com/x` / `{"server":"..."}`
 *   —— 这三种只填地址(管理员发的「入口码」),ticket 为 null;
 *   `{"v":1,"t":"aios-qr-login","server":"...","ticket":"..."}`
 *   —— 电脑上「个人设置 → 移动端扫码登录」出的**登录码**,扫完直接登进去。
 *
 * ★两种码走同一个扫码器,靠 payload 自己区分 —— 让用户先选「我要扫哪种码」是多余的一步,
 *   而且他多半不知道手上这张是哪种。
 * ★服务端那份格式在 core/org/ui/MobileQrLogin.vue 的 payloadOf()(改这里两边一起改)。
 * 真正的合法性判定仍然交给 normalizeServer —— 二维码不是可信来源,别绕过它。
 */
function parseScan(text) {
  const raw = (text || '').trim()
  if (!raw) return null
  if (raw.charAt(0) === '{') {
    try {
      const obj = JSON.parse(raw)
      if (!obj || typeof obj !== 'object') return null
      const server = obj.server || obj.url || obj.host
      if (typeof server !== 'string' || !server.trim()) return null
      // ★票必须是字符串且够长才当登录码。半个字段(比如码被截断)宁可退化成「只填地址」,
      //   也不要拿一个坏票去调接口 —— 那只会得到一句「二维码无效」,人还以为是码本身坏了。
      const ticket = obj.t === 'aios-qr-login' && typeof obj.ticket === 'string' && obj.ticket.length >= 20 ? obj.ticket : null
      return { server: server.trim(), ticket }
    } catch {
      return null
    }
  }
  return { server: raw, ticket: null }
}

let scanStream = null
let scanRunning = false
let scanTrack = null
let refocusTimer = null
let hintTimer = null

/**
 * 让摄像头**持续自动对焦**。
 *
 * ★安卓 WebView 默认给的常常是定焦流:预览看着挺清楚,近处的二维码就是一直糊 ——
 *   而且它不报任何错,症状表现成「扫不出来」,极容易被当成解码器坏了去查解码器。
 *   两处都下手:getUserMedia 的 `advanced` 里先要一次(能一步到位最好),拿到轨道后再
 *   applyConstraints 要一次 —— 有些机型只认后者。`advanced` 是**尽力而为**语义:
 *   不支持就被忽略,不会抛 OverconstrainedError,所以敢直接写进初始约束里。
 *
 * ★iOS 的 WKWebView 不实现 getCapabilities/focusMode,这段会整体跳过 ——
 *   那边 AVFoundation 默认就是连续自动对焦,本来也不需要管。
 *   **所以「iPhone 上能扫到」从来不是安卓也能扫到的证据。**
 */
async function applyFocusMode(track, mode) {
  if (!track || typeof track.getCapabilities !== 'function') return false
  let caps
  try { caps = track.getCapabilities() } catch { return false }
  const modes = (caps && caps.focusMode) || []
  if (modes.indexOf(mode) === -1) return false
  try {
    await track.applyConstraints({ advanced: [{ focusMode: mode }] })
    return true
  } catch {
    return false // 尽力而为:对不上焦也还能扫,只是要举得准一些
  }
}

/**
 * 点一下画面 → 重新对一次焦。
 *
 * ★连续对焦也会跟丢:码贴得太近、光线差、或画面里有别的高对比物体抢了焦点。
 *   这时人的本能就是点屏幕(手机相机 App 教了十几年),没有这一下他只能来回晃手机。
 *   做法是「切到单次对焦逼它重扫一遍焦,2.5 秒后再切回连续」——
 *   只重下一遍 continuous 多数机型不会重新扫;而**停在单次上等于把焦锁死**,下一张码又白搭。
 */
function refocus() {
  if (!scanTrack) return
  if (refocusTimer) { clearTimeout(refocusTimer); refocusTimer = null }
  void applyFocusMode(scanTrack, 'single-shot').then((ok) => {
    if (!ok || !scanRunning) return
    refocusTimer = setTimeout(() => {
      refocusTimer = null
      if (scanRunning) void applyFocusMode(scanTrack, 'continuous')
    }, 2500)
  })
}

function closeScanner() {
  scanRunning = false
  els.scanner.classList.remove('show')
  els.scanVideo.pause()
  els.scanVideo.srcObject = null
  if (refocusTimer) { clearTimeout(refocusTimer); refocusTimer = null }
  if (hintTimer) { clearTimeout(hintTimer); hintTimer = null }
  scanTrack = null
  if (scanStream) {
    // ★必须逐条 stop:只清 srcObject 不会关摄像头,状态栏的绿点会一直亮着
    scanStream.getTracks().forEach((t) => t.stop())
    scanStream = null
  }
}

async function openScanner() {
  showError('')
  els.scanHint.textContent = '把二维码放进取景框 · 点画面可重新对焦'
  els.scanner.classList.add('show')
  scanRunning = true

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: {
        // ideal 而不是 exact:没有后置摄像头的设备(部分平板/模拟器)用 exact 会直接抛错
        facingMode: { ideal: 'environment' },
        // ★分辨率要够:很多安卓机在低分辨率档位上直接走定焦,而且给的档位越低细节越糊。
        //   要 720p 不怕解码变慢 —— 解码那头本来就把长边降采样到 640(见 makeDecoder)。
        width: { ideal: 1280 },
        height: { ideal: 720 },
        // 尽力而为:支持就直接开着连续对焦进来,不支持这一条会被忽略(不会抛 Overconstrained)
        advanced: [{ focusMode: 'continuous' }],
      },
      audio: false,
    })
  } catch (err) {
    closeScanner()
    const name = (err && err.name) || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      showError('没有相机权限,请在系统设置里允许本 App 使用相机,或手动输入服务器地址')
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      showError('没有找到可用的摄像头,请手动输入服务器地址')
    } else {
      showError('打不开相机,请手动输入服务器地址')
    }
    return
  }

  els.scanVideo.srcObject = scanStream
  try {
    await els.scanVideo.play()
  } catch {
    /* 自动播放被拦时 muted+playsinline 一般已经够;真播不了下面的 videoWidth 会一直是 0 */
  }

  // 拿到轨道后再要一次连续对焦 —— 初始约束里那次被忽略的机型只认这一次
  scanTrack = scanStream.getVideoTracks()[0] || null
  void applyFocusMode(scanTrack, 'continuous')

  // 扫了 6 秒还没中,多半不是解码的问题而是**举得太近**:手机后摄的最近对焦距离普遍 10cm 上下,
  // 贴到屏幕上时再好的对焦算法也无解。与其让人一直晃,不如把这句说出来。
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    hintTimer = null
    if (scanRunning) els.scanHint.textContent = '扫不到?把手机拿远些(约 20cm),或点一下画面对焦'
  }, 6000)

  let decode
  try {
    decode = await makeDecoder()
  } catch {
    closeScanner()
    showError('扫码组件加载失败,请手动输入服务器地址')
    return
  }

  let last = 0
  const tick = async (ts) => {
    if (!scanRunning) return
    if (ts - last >= DECODE_INTERVAL_MS) {
      last = ts
      let text = null
      try {
        text = await decode(els.scanVideo)
      } catch {
        /* 单帧解码失败(尺寸未就绪/detector 抖动)不算数,下一帧继续 */
      }
      if (text) {
        const parsed = parseScan(text)
        const normalized = parsed ? normalizeServer(parsed.server) : { error: '' }
        if (normalized.origin) {
          closeScanner()
          els.server.value = normalized.origin.replace(/^https:\/\//, '')
          if (parsed.ticket) {
            // 登录码:不停在填地址这一步,直接走「等电脑确认 → 拿令牌 → 进入」
            void qrLogin(normalized.origin, parsed.ticket)
          } else {
            els.phone.focus()
          }
          return
        }
        // 扫到了码但不是服务器地址(WiFi 码、名片码…):停下来说清楚,
        // 别让人举着手机在那儿一直扫一个永远不会被接受的东西。
        closeScanner()
        showError('这个二维码不是服务器地址,请扫管理员提供的那张,或手动输入')
        return
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// 没有 getUserMedia(旧 WebView / 非安全上下文)就整个藏掉入口 —— 留着就是个点了没反应的死键。
// ★只有一个扫码入口(2026-08-26:地址栏旁边那颗小「扫码」去掉了)。它同时收两种码:
//   「入口码」只把地址填进去,「登录码」直接登进去 —— 分得清由**码本身**决定(见 parseScan),
//   不由用户点了哪颗决定。所以两颗按钮从来没有必要,只是多一次「该点哪个」的犹豫。
if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
  els.qrLoginBtn.hidden = false
  els.qrLoginSep.hidden = false
  els.qrLoginBtn.addEventListener('click', () => { void openScanner() })
}
els.scanCancel.addEventListener('click', closeScanner)
// 点取景画面重新对焦。★挂在 video 上而不是整个 scanner 上 —— 挂外层会把「取消」那一下也算成对焦。
//   能收到事件的前提是取景框/提示那两层 `pointer-events: none`(见 styles.css,改那两处会静默废掉这一行)。
els.scanVideo.addEventListener('click', refocus)

// ── 扫码登录(电脑上「个人设置 → 移动端扫码登录」出的码)──────────────────────
//
// 流程:扫到码 → POST /api/qr-login/scan 登记本机机型(顺带拿到「要登录成谁」)
//      → 提示人回电脑上按确认 → 轮询 /api/qr-login/redeem → 拿到 90 天令牌 → 进入。
//
// ★手机这一侧**没有任何闸**,闸全在服务端(见 standard-build/core/auth/qr-login.ts):
//   码里没有凭据、票 2 分钟就死、必须电脑上 scanned→approved 才签令牌、兑换一次性。
//   所以这里把哪一步画错都不会削弱安全性 —— 但也别在这儿自作主张「优化」掉那次确认等待。
// ★服务器地址来自二维码,是**不可信输入**:上面已经过 normalizeServer(只收 https、
//   主机名必须带点、不许 userinfo)。此处不会把任何既有凭据发给它 —— 只拿票换令牌。

/** 轮询周期与上限。90 秒够人拿起手机走回电脑点一下;再久就该重扫了(票本身也活不过那么久)。 */
const QR_POLL_MS = 2000
const QR_POLL_LIMIT_MS = 100_000

/** 正在进行的扫码登录的中止函数(bootCancel 会调它);没有进行中时为 null。 */
let qrAbort = null

/** 本机机型串,给电脑上的确认框显示。★服务端会截断并去掉控制字符,这里不做净化。 */
function deviceLabel() {
  const ua = navigator.userAgent || ''
  // 取 UA 里括号中那段(机型/系统),比整串 UA 可读得多;取不到就退回整串
  const m = ua.match(/\(([^)]+)\)/)
  return (m ? m[1] : ua).slice(0, 120) || '未知设备'
}

function devicePlatform() {
  try {
    const p = cap && cap.getPlatform && cap.getPlatform()
    if (p) return p
  } catch { /* 桥不在:退回 UA 猜 */ }
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'unknown'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function qrLogin(origin, ticket) {
  showError('')
  els.enterAnyway.classList.remove('show')
  let cancelled = false
  qrAbort = () => { cancelled = true }
  showBoot(true, '正在连接…')

  try {
    // ① 登记本机,顺便拿到「要登录成谁」—— 扫错码的人在这一步就能发现
    let scan
    try {
      scan = await http('POST', origin + '/api/qr-login/scan', {
        body: { ticket, device: { label: deviceLabel(), platform: devicePlatform(), appVersion: APP_VERSION } },
        timeoutMs: 12000,
      })
    } catch {
      showBoot(false)
      showError('无法连接该服务器,请检查网络后重新扫码')
      return
    }
    if (cancelled) return showBoot(false)
    if (scan.status !== 200) {
      showBoot(false)
      showError(apiErrorMessage(scan.data, '二维码无效或已过期,请在电脑上刷新后重新扫码'))
      return
    }

    const who = (scan.data && scan.data.loginAs) || ''
    showBoot(true, who ? `请在电脑上确认登录「${who}」` : '请在电脑上确认这次登录')

    // ② 轮询兑换。★网络抖动不算数(continue),只有服务端明确说「不行」才停 ——
    //    人已经在电脑前按了确认,因为一次超时就把他打回登录页是最气人的失败。
    const deadline = Date.now() + QR_POLL_LIMIT_MS
    while (Date.now() < deadline) {
      if (cancelled) return showBoot(false)
      await sleep(QR_POLL_MS)
      if (cancelled) return showBoot(false)

      let res
      try {
        res = await http('POST', origin + '/api/qr-login/redeem', { body: { ticket }, timeoutMs: 12000 })
      } catch {
        continue
      }
      if (res.status !== 200) {
        showBoot(false)
        showError(apiErrorMessage(res.data, '二维码已失效,请在电脑上刷新后重新扫码'))
        return
      }
      const st = res.data && res.data.status

      if (st === 'approved' && res.data.token) {
        await prefs.set(PREF_SESSION, JSON.stringify({ token: res.data.token, employee: res.data.employee }))
        // 顺手记下手机号:下次万一要用密码登录,这一栏是填好的(密码那栏仍然空着 ——
        // 扫码登录从来没拿到过密码,不能装作有)
        if (res.data.employee && res.data.employee.phone) await prefs.set(PREF_LAST_PHONE, res.data.employee.phone)
        await enter(origin)
        return
      }
      if (st === 'rejected') {
        showBoot(false)
        showError('电脑上点了「不是我」,本次登录已取消')
        return
      }
      if (st === 'expired') {
        showBoot(false)
        showError('二维码已过期,请在电脑上换一张再扫')
        return
      }
      // pending / scanned:继续等
    }

    showBoot(false)
    showError('等待电脑确认超时,请在电脑上换一张二维码重新扫码')
  } finally {
    qrAbort = null
  }
}

// ── 登录提交 ──────────────────────────────────────────────────────────────────
els.form.addEventListener('submit', async (e) => {
  e.preventDefault()
  showError('')

  const normalized = normalizeServer(els.server.value)
  if (normalized.error) return showError(normalized.error)
  const origin = normalized.origin

  const phone = els.phone.value.trim()
  const password = els.password.value
  if (!phone) return showError('请输入手机号')
  if (!password) return showError('请输入密码')

  const tenantVisible = els.tenantField.classList.contains('show')
  const tenantId = tenantVisible ? els.tenantId.value.trim() : ''
  const body = { phone, password }
  if (tenantId) body.tenantId = tenantId

  // ★在**发请求之前**存,而不是在成功回调里存 —— 需求要的是「一旦输入过就始终留着」:
  //   服务器 500 / 网络不通 / 密码打错的那一次同样要留下,否则重启 App 回来又是空白的。
  //   密码是明文,理由与代价见文件头。
  await Promise.all([
    prefs.set(PREF_SERVER, origin),
    prefs.set(PREF_LAST_PHONE, phone),
    prefs.set(PREF_LAST_PASSWORD, password),
  ])

  setBusy(true)
  try {
    const res = await http('POST', origin + '/api/auth/login', { body })

    if (res.status === 200 && res.data && res.data.token) {
      await prefs.set(PREF_SESSION, JSON.stringify({ token: res.data.token, employee: res.data.employee }))
      await enter(origin)
      return
    }

    const code = apiErrorCode(res.data)
    if (code === 'AMBIGUOUS_TENANT') {
      // 同一手机号存在于多个租户:展开租户输入让用户补填后重试
      els.tenantField.classList.add('show')
      els.tenantId.focus()
      showError(apiErrorMessage(res.data, '该手机号存在于多个企业,请填写租户 ID 后重试'))
    } else if (res.status === 401) {
      showError('手机号或密码不对')
    } else if (res.status === 403) {
      showError(apiErrorMessage(res.data, '该账号当前不可登录,请联系企业管理员'))
    } else if (res.status === 404 || typeof res.data !== 'object' || res.data === null) {
      // 能连上但不是 AIOS 登录接口:多半是域名填错(打到别的站/网关)
      showError('该地址不是有效的企业服务器,请核对服务器地址')
    } else {
      showError(apiErrorMessage(res.data, `登录失败(${res.status}),请稍后重试`))
    }
  } catch {
    showError('无法连接服务器,请检查服务器地址与网络')
  } finally {
    setBusy(false)
  }
})

boot()
