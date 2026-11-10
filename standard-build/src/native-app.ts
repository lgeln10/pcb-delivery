// src/native-app.ts — 移动 App 壳(mobile-app/,Capacitor)内运行时的前端一侧。
//
// 只在「App 壳的 webview 里打开本站」这一种场景生效:浏览器/飞书里访问一切照旧。
// 壳是全租户统一的一套:用户在壳里输服务器域名+手机号+密码,壳原生调 /api/auth/login,
// 会话写进 Capacitor Preferences(原生存储,App 全局共享),然后整个 webview 跳到租户域名。
// 本文件负责另一半:启动时从 Preferences 领养会话(走 setSession,顺带清掉
// demo-auto-login-suppressed —— 不清它的话有 token 也会被摁在登录页)、把 H5 里
// 发生的重新登录镜像回 Preferences、退出(主动退出与被动 401)时清壳凭据并退回壳登录页。
//
// 与壳的契约(mobile-app/shell/app.js 同步维护,改 key 两边一起改):
//   aios.server    归一化租户 origin        aios.session  JSON{ token, employee }
//   aios.lastPhone 上次登录手机号(预填用)  aios.lastPassword 上次登录密码(预填用,明文)
// ★lastPhone / lastPassword 只有壳读写,H5 一律不碰 —— 但改 key 名要两边一起改。
//
// ★H5 不 import 任何 @capacitor/* 包 —— 壳的 Capacitor runtime 会注入 window.Capacitor,
//   这里全部经它取插件,并处处判空:同一份构建产物要同时跑在浏览器和壳里。
import { onScopeDispose, getCurrentScope, ref, watch, type Ref } from 'vue'
import { AUTH_EXPIRED_EVENT, TOKEN_KEY, useAuth, type AuthEmployee } from './auth'
import { apiRegisterPushDevice, apiUnregisterPushDevice } from './api/client'

/** 壳版本号,随设备令牌一起上报,便于排查「哪个版本的 App 收不到推送」。 */
const APP_SHELL_VERSION = '0.1.0'

export const NATIVE_SESSION_PREF_KEY = 'aios.session'
// 与 App.vue 的 SESSION_SECTION_KEY 同一 literal(那边是组件内常量,不值得为此建共享模块)
const ACTIVE_SECTION_KEY = 'standard-build.active-section'
/**
 * 壳交接后的落地页:登录(以及冷启动自动进入)之后直接落 PCB CAM。
 *
 * ★决定变更史 —— 这个值被反复确认过两次相反的口径,所以把两次都留着:
 *   · 2026-08-02 底部 tab 栏上线时,需求方确认**维持「我的助手」**(理由:tab 栏第一格是
 *     「随时可回的入口」,落地页要选「打开就能直接开始干活」的那一页,两件事);
 *   · **2026-08-25 需求方改口:登录之后要落「首页」。** 以这一条为准。
 *   下次再看到它和某条注释/测试对不上,先找最新的那次决定,别当成漏改顺手改回去 ——
 *   改这个值会改掉每个 App 用户每天第一眼看到的东西,而且不会有任何报错。
 *   `native-app.test.ts` 钉住了当前值。
 *
 * 落地页是 PCB CAM。没有这页权限时,App.vue 的可见性守卫会把人弹到第一个可见页。
 */
export const NATIVE_LANDING_SECTION = 'pcb-cam'

/**
 * 这一跳该落在哪一页;返回 null = **不要动**(尊重本 webview 会话里已有的位置)。
 *
 * 两种情形要分开,只看 sessionStorage 是不够的:
 *  - `cameFromShell`(地址上带着壳的交接 fragment)= 用户**刚在壳里点了登录 / 刚进入**,
 *    一律回到落地页。★这一支是 2026-08-25「登录之后要落首页」的落点:退出登录会跳回壳
 *    (另一个 origin),再登进来仍是同一个 webview 标签页,租户域名的 sessionStorage
 *    **还留着上次停的位置** —— 只判「storage 为空」的话,第二次之后的登录永远落不到首页。
 *  - 没带 fragment 而 storage 里有值 = 热恢复/页内刷新,那是用户自己走到的地方,别抢。
 */
export function landingSectionFor(cameFromShell: boolean, storedSection: string | null): string | null {
  if (cameFromShell) return NATIVE_LANDING_SECTION
  return storedSection ? null : NATIVE_LANDING_SECTION
}

// ── window.Capacitor 的最小类型面(只声明用到的)─────────────────────────────
type PluginListenerHandle = { remove: () => Promise<void> }
type PreferencesPlugin = {
  get: (o: { key: string }) => Promise<{ value: string | null }>
  set: (o: { key: string; value: string }) => Promise<void>
  remove: (o: { key: string }) => Promise<void>
}
type AppPlugin = {
  addListener: (ev: 'backButton', cb: () => void) => Promise<PluginListenerHandle>
  minimizeApp: () => Promise<void>
}
// ★刻意**不声明 setOverlaysWebView** —— 插件是有这个方法的,但本壳一处都不该调(理由见
//   initStatusBar 的注释)。不声明,写出来就编译不过,比一条注释拦得住。
type StatusBarPlugin = {
  setStyle: (o: { style: string }) => Promise<void>
}
// 注意:这里**不声明 addListener** —— 事件一律走 capacitor().addListener(见上方说明)。
type PushNotificationsPlugin = {
  checkPermissions: () => Promise<{ receive: string }>
  requestPermissions: () => Promise<{ receive: string }>
  register: () => Promise<void>
}
// 同上:事件走 capacitor().addListener,这里不声明 addListener。
type SpeechRecognitionPlugin = {
  available: () => Promise<{ available: boolean }>
  requestPermissions: () => Promise<{ speechRecognition: string }>
  start: (o: { language: string; partialResults: boolean; popup: boolean }) => Promise<unknown>
  stop: () => Promise<void>
}
type CapacitorGlobal = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  /**
   * ★事件必须走这个底层 API,不能用 `Capacitor.Plugins.X.addListener(...)`。
   * 注入的 native-bridge.js 里:
   *   cap.addListener = (plugin, event, cb) => cap.nativeCallback(plugin, 'addListener', {eventName}, cb)
   * 用的是 **nativeCallback**(可反复回调)。而 `Plugins.X.addListener` 会被当成普通的一次性
   * promise 方法派发,回调压根没被登记成事件监听器 —— 表现为「注册发出去了,事件永远不回来」。
   * 2026-08-01 真机踩到:推送卡在「正在向 APNs 注册…」,registration/registrationError 双双不触发。
   */
  addListener?: (pluginName: string, eventName: string, callback: (data: unknown) => void) => PluginListenerHandle
  Plugins?: {
    Preferences?: PreferencesPlugin
    App?: AppPlugin
    StatusBar?: StatusBarPlugin
    SpeechRecognition?: SpeechRecognitionPlugin
    PushNotifications?: PushNotificationsPlugin
    // 自研后台定位插件(iOS 见 mobile-app/ios/App/App/LocationTrackerPlugin.swift,
    // 安卓见 mobile-app/android/.../LocationTrackerPlugin.java —— 两端同一份契约;
    // 事件走 capacitor().addListener,这里不声明 addListener)
    LocationTracker?: { start(o: { distanceFilterM: number }): Promise<void>; stop(): Promise<void> }
  }
}

function capacitor(): CapacitorGlobal | null {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor ?? null
}

/** 是否运行在 App 壳内。UA 兜底:壳的 config 里 appendUserAgent 带 AIOSShell。 */
export function isNativeShell(): boolean {
  const cap = capacitor()
  if (cap?.isNativePlatform?.()) return true
  return /AIOSShell/.test(navigator.userAgent)
}

function prefsPlugin(): PreferencesPlugin | null {
  return capacitor()?.Plugins?.Preferences ?? null
}

// ── 会话解析(纯函数,可测)────────────────────────────────────────────────────
/** token 是 base64url(payload).base64url(hmac),payload 含 exp(秒)。解不出返回 null。 */
export function tokenExpiresAt(token: string): number | null {
  try {
    const b64 = token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    ) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/** 还有至少一分钟寿命才算活着:紧贴过期线进入,第一批请求就会 401,不如现在拦下。 */
export function tokenLooksAlive(token: string): boolean {
  const at = tokenExpiresAt(token)
  return at === null || at > Date.now() + 60_000
}

export type NativeShellSession = { token: string; employee: AuthEmployee }

/** 壳写进 Preferences 的会话串 → 结构校验。形状不对(存储损坏/版本不齐)一律当没有。 */
export function parseNativeSession(raw: string | null): NativeShellSession | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { token?: unknown; employee?: Record<string, unknown> }
    if (typeof v.token !== 'string' || !v.token) return null
    const e = v.employee
    if (!e || typeof e.id !== 'string' || typeof e.name !== 'string') return null
    return {
      token: v.token,
      employee: {
        id: e.id,
        name: e.name,
        tenantId: typeof e.tenantId === 'string' ? e.tenantId : '',
        phone: typeof e.phone === 'string' ? e.phone : '',
      },
    }
  } catch {
    return null
  }
}

/** 壳经 URL fragment 递会话时用的前缀。改这里要同步改 mobile-app/shell/app.js 的 HANDOFF_PREFIX。 */
export const SHELL_HANDOFF_PREFIX = 'aios-shell-session='

/**
 * 从 location.hash 取走壳递过来的会话,**并立刻把 hash 抹掉**。
 *
 * ★为什么需要这条第二通道(2026-08-21 实测):安卓上 webview 从 https://localhost
 *   跳到租户域名之后 `window.Capacitor` 就没了 —— 桥不在,`prefsPlugin()` 返回 null,
 *   壳写进 Preferences 的那份会话**没有任何人接得到**。现象是「壳登录成功却落在
 *   AIOS 登录页要你再输一遍」,而且全程不报错(判据:`in-native-app` 这个 class
 *   没被加上,顶栏会被状态栏盖住)。iOS 走 WKUserScript 跨 origin 注入,不受影响。
 *
 * ★必须**同步**抹掉,而且要在 App 挂载之前:App.vue 的 parseHash() 用 hash 做路由,
 *   留着它会被当成一个不认识的 section;更重要的是别让 token 一直挂在地址上。
 *   fragment 不发往服务端(不进请求行、不进 Referer、不进日志),所以这一跳只在本机。
 *
 * 解析失败一律当没有 —— 半领养比不领养更糟(见 parseNativeSession)。
 */
export function takeSessionFromHash(): NativeShellSession | null {
  const hash = window.location.hash
  if (!hash.startsWith('#' + SHELL_HANDOFF_PREFIX)) return null
  const raw = hash.slice(1 + SHELL_HANDOFF_PREFIX.length)
  // 先抹再解:解析抛异常时也不能把 token 留在地址栏上
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    /* 极老 webview 没有 replaceState:抹不掉也要继续,总比领养不到强 */
  }
  try {
    return parseNativeSession(decodeURIComponent(raw))
  } catch {
    return null
  }
}

// ── 启动引导(main.ts 在 createApp 之前 await 它)──────────────────────────────
// 必须在挂载前完成的原因有二:App.vue setup 同步读 ACTIVE_SECTION_KEY 决定落地页;
// 会话领养走 setSession 又要发生在受保护查询启动之前,否则首屏闪一下登录页。
export async function nativeShellBootstrap(): Promise<void> {
  if (!isNativeShell()) return

  // CSS 钩子:styles.css 里 html.in-native-app 的安全区(刘海/Home 条)规则挂在它上
  document.documentElement.classList.add('in-native-app')

  const prefs = prefsPlugin()

  // ★必须在 takeSessionFromHash **之前**问一次:那个函数会同步把 hash 抹掉,
  //   之后就再也判断不出「这一跳是壳刚交接过来的」。而这正是「登录之后落哪一页」的判据。
  //   注意判的是**前缀在不在**,不是会话解没解析成功 —— 解析失败照样是「刚从壳进来」。
  const cameFromShell = window.location.hash.startsWith('#' + SHELL_HANDOFF_PREFIX)

  // ★先把 fragment 里那份取走(无论桥在不在都要抹掉),它是安卓上唯一到得了的通道。
  const handoff = takeSessionFromHash()
  const localToken = localStorage.getItem(TOKEN_KEY)
  const localAlive = Boolean(localToken && tokenLooksAlive(localToken))
  if (!localAlive && handoff && tokenLooksAlive(handoff.token)) {
    // setSession 同时清 demo-auto-login-suppressed(★不清它有 token 也进不去)
    useAuth().setSession(handoff.token, handoff.employee)
  }

  if (prefs) {
    // 领养壳递交的会话。webview 自己 localStorage 里有活 token 时以它为准
    // (可能是在 H5 登录页里刚重新登录的、也可能是上面刚从 fragment 领养的),只把它镜像回壳。
    try {
      const { value } = await prefs.get({ key: NATIVE_SESSION_PREF_KEY })
      const shellSession = parseNativeSession(value)
      const local2 = localStorage.getItem(TOKEN_KEY)
      const alive2 = Boolean(local2 && tokenLooksAlive(local2))
      if (!alive2 && shellSession && tokenLooksAlive(shellSession.token)) {
        useAuth().setSession(shellSession.token, shellSession.employee)
      } else if (!alive2 && shellSession) {
        await prefs.remove({ key: NATIVE_SESSION_PREF_KEY }) // 壳存的也死了:清掉,冷启动直接见壳登录页
      }
    } catch {
      /* 桥不可用:退化成普通浏览器行为,fragment 那条已经兜过一次了 */
    }

    // ★服务端说这个 token 不认了(401)→ **立刻**把壳里那份也清掉。
    //
    // 在此之前只有「本地过期」会清(上面那段 tokenLooksAlive),而**被吊销但还没到期**的 token
    // 本地看着是活的 —— 壳每次冷启动都会把它再交出来一遍,H5 再 401 一次,重启也一样,
    // 形成一个只能等到期才自己解开的循环。原来靠壳启动时那次 `/api/me` 探活兜住;
    // 探活是一整个 RTT 而且走原生 HTTP 栈(与 webview 不共用连接),那一跳期间
    // H5 一个字节都还没开始下。把「判死」的责任挪到这里,壳就不必为此多等一跳(见 mobile-app 侧改动)。
    //
    // 只在真 401 时清:本地置空(退出、被动过期)不走这条 —— 主动退出有 nativeShellLogout,
    // 被动过期由上面那段在下次冷启动时清。
    window.addEventListener(AUTH_EXPIRED_EVENT, () => {
      void (async () => {
        try {
          await prefs.remove({ key: NATIVE_SESSION_PREF_KEY })
        } catch {
          /* 清不掉也要退出去:壳启动那次 /api/me 探活同样会把它判死 */
        }
        // ★★退回**壳**登录页,而不是停在 H5 自己的登录页(2026-08-18 需求方要求)。
        //   理由是「最外层」那一页才是能自救的一页:它能改服务器地址、能处理
        //   409 AMBIGUOUS_TENANT,而且三个字段都是预填好的(壳存了 server/phone/password),
        //   服务器抽风时人只要再点一次「登录」。停在 H5 登录页则换不了域名 ——
        //   而「服务器有异常」恰恰是最需要换域名/重试的时候。
        //   ⚠️ 这里**不调 unregisterPushDevice**:那个接口要带一枚还有效的 token,
        //      而走到这一步 token 已经被服务端拒了,调也是白调。设备与人的绑定
        //      由下一次登录重新注册时覆盖(见 registerPushDevice)。
        window.location.replace(shellLoginOrigin() + SHELL_LOGOUT_HASH)
      })()
    })

    // H5 里重新登录(被动过期后在内嵌登录页登的)→ 新会话镜像回壳,冷启动才接得上
    const { token, employee } = useAuth()
    watch(token, (t) => {
      if (!t) return // 置空可能是被动过期,壳侧留着由启动校验去判死;主动退出走 nativeShellLogout
      const payload: NativeShellSession = {
        token: t,
        employee: employee.value ?? { id: '', name: '', tenantId: '', phone: '' },
      }
      void prefs.set({ key: NATIVE_SESSION_PREF_KEY, value: JSON.stringify(payload) }).catch(() => {})
    })
  }

  const landing = landingSectionFor(cameFromShell, sessionStorage.getItem(ACTIVE_SECTION_KEY))
  if (landing) sessionStorage.setItem(ACTIVE_SECTION_KEY, landing)

  initAndroidBackButton()
  void initStatusBar()
  void initPushNotifications()
}

// ── 推送通知 ─────────────────────────────────────────────────────────────────
// 设备令牌:平台随时可能换发(重装/恢复备份/系统换发),所以每次启动都注册一次,
// 后端按 (platform, token) 幂等 upsert。**不主动弹权限**要等到有会话之后 ——
// 一进 App 就弹「允许通知吗」而用户还没登录,拒绝率高得多,且拒绝后 iOS 不给第二次机会。
const PUSH_TOKEN_KEY = 'standard-build.push.token' // 记住本机 token,退出登录时要拿它去注销

/**
 * 本机推送注册走到哪一步了。
 * ★原来这里全程 try/catch 静默吞错 —— 结果是「设备没登记」时**完全无从判断断在哪**:
 *   桥没有?权限被拒?APNs 没回 token?后端登记失败?现象一模一样。
 *   把每一步记下来,通知面板会显示它(仅 App 内),排查从猜变成读。
 */
export const pushDiagnostic = ref('未开始')

async function initPushNotifications(): Promise<void> {
  const push = capacitor()?.Plugins?.PushNotifications
  if (!push) {
    pushDiagnostic.value = '推送插件不可用(壳没装 PushNotifications,或桥未注入)'
    return
  }
  const { isAuthenticated } = useAuth()

  let started = false
  const start = async () => {
    if (started) return
    started = true
    try {
      pushDiagnostic.value = '正在申请通知权限…'
      let perm = await push.checkPermissions()
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
        perm = await push.requestPermissions()
      }
      // 用户拒绝:正常使用,只是没横幅。**不反复弹**(iOS 也不会再弹第二次)
      if (perm.receive !== 'granted') {
        pushDiagnostic.value = `通知权限未授予(${perm.receive})—— 去系统设置里打开本 App 的通知`
        return
      }

      const on = capacitor()?.addListener
      if (!on) {
        pushDiagnostic.value = '桥不支持事件监听(Capacitor.addListener 缺失)'
        return
      }
      on('PushNotifications', 'registration', (raw) => {
        const token = (raw as { value?: string })?.value
        if (!token) {
          pushDiagnostic.value = 'APNs 回了空 token'
          return
        }
        localStorage.setItem(PUSH_TOKEN_KEY, token)
        const platform = capacitor()?.getPlatform?.() === 'android' ? 'android' : 'ios'
        // ★通道由**壳**说了算,H5 猜不出来:安卓上到底走华为/荣耀/小米/OPPO/vivo 哪一家,
        //   取决于壳里集成了谁家的 SDK。壳在 registration 事件里带 provider 就用它,
        //   没带才退回 fcm(= 现状:厂商 SDK 未接,后端会跳过发送)。
        //   写死 'fcm' 的那一版意味着**厂商发送器即使凭据到位也永远拿不到输入**。
        // 壳给的是任意字符串,必须按白名单收(壳是外部输入,别把野值送进登记接口)
        const ANDROID_CHANNELS = ['huawei', 'honor', 'xiaomi', 'oppo', 'vivo', 'fcm'] as const
        type AndroidChannel = (typeof ANDROID_CHANNELS)[number]
        const rawProvider = (raw as { provider?: unknown })?.provider
        const shellProvider = ANDROID_CHANNELS.find((c) => c === rawProvider)
        const provider: 'apns' | AndroidChannel = platform === 'ios' ? 'apns' : (shellProvider ?? 'fcm')
        pushDiagnostic.value = '已拿到设备令牌,正在登记…'
        void apiRegisterPushDevice({
          token,
          platform,
          provider,
          appVersion: APP_SHELL_VERSION,
        })
          .then(() => { pushDiagnostic.value = '已登记 ✓' })
          // 登记失败只是收不到推送,不打扰用户,但要留下痕迹
          .catch((e: unknown) => { pushDiagnostic.value = `登记到服务器失败:${e instanceof Error ? e.message : '未知错误'}` })
      })
      on('PushNotifications', 'registrationError', (raw) => {
        // 常见原因:App ID 没开 Push 能力、entitlement 与 profile 不匹配
        pushDiagnostic.value = `APNs 注册失败:${JSON.stringify(raw)}`
      })
      // 点通知进来:带 section 就切到对应页面(H5 的导航是 section 不是 URL)
      on('PushNotifications', 'pushNotificationActionPerformed', (raw) => {
        const data = (raw as { notification?: { data?: Record<string, unknown> } })?.notification?.data ?? {}
        const section = typeof data.section === 'string' ? data.section : ''
        if (!section) return
        sessionStorage.setItem(ACTIVE_SECTION_KEY, section)
        const sourceId = typeof data.sourceId === 'string' ? data.sourceId : ''
        if (sourceId) {
          // 二级深链(目前只有消息:`#/messenger/<会话id>`)。★走 hash 不走 si:navigate ——
          // 后者只带得动 section,点进去停在会话**列表**上,用户还得自己再找一次那个会话;
          // 而 App.vue 的 hashchange 会把 section 与 sub 一起解出来,直接落到那条会话里。
          location.hash = `#/${section}/${sourceId}`
          return
        }
        window.dispatchEvent(new CustomEvent('si:navigate', { detail: section }))
      })
      pushDiagnostic.value = '权限已授予,正在向 APNs 注册…'
      await push.register()
    } catch (e) {
      pushDiagnostic.value = `出错:${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (isAuthenticated.value) return void start()
  // 还没登录:等会话建立再申请权限
  pushDiagnostic.value = '等待登录后再申请通知权限'
  const stop = watch(isAuthenticated, (ok) => {
    if (!ok) return
    stop()
    void start()
  })
}

/** 退出登录时把本机设备注销掉。★不注销的话,下一个在这台手机上登录的人会收到前一个人的通知。 */
async function unregisterPushDevice(): Promise<void> {
  const token = localStorage.getItem(PUSH_TOKEN_KEY)
  if (!token) return
  localStorage.removeItem(PUSH_TOKEN_KEY)
  await apiUnregisterPushDevice(token).catch(() => {})
}

// 安卓实体返回键:开着浮层先关浮层(Element Plus 的弹窗/抽屉都认 Escape),
// 有页面历史则回上一页(App.vue 的 pushState/popstate 机制),都没有就把 App 收到后台
// (微信式;真退出让系统去杀,免得用户一按就丢上下文)。iOS 无此事件,注册了也不响。
function initAndroidBackButton(): void {
  const app = capacitor()?.Plugins?.App
  if (!app || capacitor()?.getPlatform?.() !== 'android') return
  void app
    .addListener('backButton', () => {
      const overlay = document.querySelector('.el-overlay')
      if (overlay && getComputedStyle(overlay).display !== 'none') {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        return
      }
      if ((history.state as { siSection?: string } | null)?.siSection) {
        history.back()
        return
      }
      void app.minimizeApp()
    })
    .catch(() => {})
}

// 状态栏:**只**切图标明暗跟随 H5 主题;窗口铺不铺满、安全区多大,一律交给原生壳。
//
// ★千万别在这里调 setOverlaysWebView(哪个平台都别调):
//   · iOS 上 setOverlaysWebView(false) **是实现了的**(不是空操作):会插一个默认黑色的
//     状态栏背景 view,并把 webview 整体下移 origin.y = statusBarHeight —— 真机实测就是
//     「顶部一条黑带 + 页面被压下去」。本壳走 viewport-fit=cover + safe-area 内边距,webview 必须满屏。
//   · 安卓上 setOverlaysWebView 用的是 **View#setSystemUiVisibility**,而壳的 targetSdk = 35:
//     Android 15 起 edge-to-edge 是强制的、这套老 API 已被废成空操作 —— 调了拦不住,
//     只会在 ≤ Android 14 上跟 MainActivity 的 setDecorFitsSystemWindows(false) 打架,
//     变成「一部分机器让位两次(顶部空一条),另一部分完全不让位」。
//     窗口形态与真实 inset 现由 MainActivity 统一负责(它把 --sb-safe-* 注入 documentElement)。
async function initStatusBar(): Promise<void> {
  const bar = capacitor()?.Plugins?.StatusBar
  if (!bar) return
  const sync = () => {
    const theme = document.documentElement.dataset.theme
    // 插件语义:DARK = 深色背景配浅色图标;LIGHT = 浅色背景配深色图标
    void bar.setStyle({ style: theme === 'dark' || theme === 'gold' ? 'DARK' : 'LIGHT' }).catch(() => {})
  }
  sync()
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

// ── 退出登录(App.vue 的 onLogout 调)──────────────────────────────────────────
// 清壳凭据 → 整个 webview 退回壳登录页(域名/手机号/密码都留着预填,见壳侧 app.js 文件头)。
// 跳不动(桥挂了)也无妨:Preferences 已清,下次冷启动自然落在壳登录页。
export async function nativeShellLogout(): Promise<void> {
  if (!isNativeShell()) return
  // ★先注销推送设备,再清会话 —— 注销接口要带着还没失效的 token 才调得通。
  //   漏这一步的后果是下一个在这台手机上登录的人收到前一个人的通知。
  await unregisterPushDevice()
  try {
    await prefsPlugin()?.remove({ key: NATIVE_SESSION_PREF_KEY })
  } catch {
    /* 清不掉也继续退:壳启动还会在线验一次 token,吊销后的 token 过不了 /api/me */
  }
  window.location.replace(shellLoginOrigin() + SHELL_LOGOUT_HASH)
}

/**
 * 壳登录页的 origin。Capacitor 在 iOS 用 `capacitor://` 自定义 scheme、安卓用 `https://localhost`。
 * ★两处要用(主动退出、被动 401 退出),抽成一个函数 —— 写两份迟早只改一处。
 */
function shellLoginOrigin(): string {
  return capacitor()?.getPlatform?.() === 'ios' ? 'capacitor://localhost/' : 'https://localhost/'
}

/**
 * 退回壳登录页时带上的标记。壳的 boot() 见到它就清掉自己存的会话(mobile-app/shell/app.js)。
 *
 * ★为什么不能只靠这边 `prefs.remove`:安卓上桥在租户域名里是不在的,`prefsPlugin()` 返回 null,
 *   那句 remove 是**空操作**。壳里那份会话还活着 → 壳一启动就判定「有活会话」直接 enter()
 *   弹回租户域名 → 人眼里就是「退出登录只能回到 AIOS 登录页,回不到 App 登录页」。
 *   带上这个标记,清不清得掉就不再取决于桥在不在。
 */
const SHELL_LOGOUT_HASH = '#logout'

// ── 语音输入(对话 composer 用)────────────────────────────────────────────────
// 原生听写:iOS 走 SFSpeechRecognizer,安卓走系统 SpeechRecognizer。
// ★无 Google 服务的国产安卓机 available() 会是 false —— 按钮直接不出现,
//   属预期降级;要覆盖这批设备得走服务端 ASR(见 docs/design/MOBILE_APP_SHELL.md)。
export type NativeVoiceInput = {
  /** 设备可用才为 true;浏览器/不支持的设备恒 false,按钮据此隐藏 */
  supported: Ref<boolean>
  listening: Ref<boolean>
  /** 开始听写;每次识别更新调 onText(整段累计文本)。拿不到权限返回 false。 */
  start: (onText: (text: string) => void) => Promise<boolean>
  stop: () => Promise<void>
}

export function useNativeVoiceInput(): NativeVoiceInput {
  const supported = ref(false)
  const listening = ref(false)
  let handles: PluginListenerHandle[] = []

  const plugin = () => capacitor()?.Plugins?.SpeechRecognition ?? null

  if (isNativeShell()) {
    void (async () => {
      try {
        supported.value = Boolean((await plugin()?.available())?.available)
      } catch {
        supported.value = false
      }
    })()
  }

  async function cleanup() {
    const hs = handles
    handles = []
    for (const h of hs) await h.remove().catch(() => {})
  }

  async function start(onText: (text: string) => void): Promise<boolean> {
    const p = plugin()
    if (!p || listening.value) return listening.value
    try {
      const perm = await p.requestPermissions()
      if (perm.speechRecognition !== 'granted') return false
      // ★事件走底层 addListener,不能用 p.addListener —— 后者被当成一次性 promise 方法派发,
      //   回调收不到任何事件(与推送同一个坑,见 CapacitorGlobal.addListener 的说明)。
      const on = capacitor()?.addListener
      if (!on) return false
      handles.push(
        on('SpeechRecognition', 'partialResults', (raw) => {
          const m = (raw as { matches?: string[] })?.matches?.[0]
          if (typeof m === 'string' && m) onText(m)
        }),
      )
      handles.push(
        on('SpeechRecognition', 'listeningState', (raw) => {
          // 安卓静音会自动停(iOS 只认手动 stop):按钮态跟着事件走,别让它一直红着
          if ((raw as { status?: string })?.status === 'stopped') {
            listening.value = false
            void cleanup()
          }
        }),
      )
      await p.start({ language: 'zh-CN', partialResults: true, popup: false })
      listening.value = true
      return true
    } catch {
      listening.value = false
      await cleanup()
      return false
    }
  }

  async function stop(): Promise<void> {
    try {
      await plugin()?.stop()
    } catch {
      /* 没在听时 stop 会抛,无所谓 */
    } finally {
      listening.value = false
      await cleanup()
    }
  }

  // 组件卸载顺手停:别让离开对话页后麦克风还开着
  if (getCurrentScope()) onScopeDispose(() => void stop())

  return { supported, listening, start, stop }
}
