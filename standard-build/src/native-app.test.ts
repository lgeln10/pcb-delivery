// @vitest-environment jsdom
// src/native-app.test.ts — App 壳桥的纯函数部分。被测模块连带 src/auth.ts,
// 后者在模块求值时就读 localStorage → 必须 jsdom(默认 node 环境会直接 ReferenceError)。
// 会话领养/语音那半要真机(依赖注入的 window.Capacitor),这里只锁两件事:
// ① token 过期判定读的是 base64url payload 的 exp(壳侧 shell/app.js 有同构实现,
//    这份测试同时是那份的行为规格);② 壳递交的会话串坏掉时一律当没有,不能半领养。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NATIVE_LANDING_SECTION,
  SHELL_HANDOFF_PREFIX,
  landingSectionFor,
  parseNativeSession,
  takeSessionFromHash,
  tokenExpiresAt,
  tokenLooksAlive,
} from './native-app'
import { NAV_CATALOG, flattenNavItems } from './nav-catalog'

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function makeToken(payload: unknown): string {
  return `${b64url(JSON.stringify(payload))}.${b64url('fake-hmac')}`
}

describe('tokenExpiresAt', () => {
  it('解出 payload.exp(秒)并换算成毫秒', () => {
    expect(tokenExpiresAt(makeToken({ employeeId: 'e1', exp: 1_800_000_000 }))).toBe(1_800_000_000_000)
  })

  it('无 exp / 非法 base64 / 非 JSON 一律 null(当作不可判,交给在线校验)', () => {
    expect(tokenExpiresAt(makeToken({ employeeId: 'e1' }))).toBeNull()
    expect(tokenExpiresAt('not-a-token')).toBeNull()
    expect(tokenExpiresAt(`${b64url('plain text')}.sig`)).toBeNull()
  })
})

describe('tokenLooksAlive', () => {
  it('未来的 exp 算活,过去的算死,且过期线前一分钟内也算死(马上就 401 不如现在拦)', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(tokenLooksAlive(makeToken({ exp: now + 3600 }))).toBe(true)
    expect(tokenLooksAlive(makeToken({ exp: now - 1 }))).toBe(false)
    expect(tokenLooksAlive(makeToken({ exp: now + 30 }))).toBe(false)
  })

  it('解不出 exp 时按活处理:让 /api/me 在线校验去判,而不是把可能有效的会话扔了', () => {
    expect(tokenLooksAlive('garbage')).toBe(true)
  })
})

describe('parseNativeSession', () => {
  const employee = { id: 'e1', name: '张三', tenantId: 't1', phone: '13800000000' }

  it('完整会话原样解出', () => {
    const raw = JSON.stringify({ token: 'tok', employee })
    expect(parseNativeSession(raw)).toEqual({ token: 'tok', employee })
  })

  it('员工缺可选字段时补空串,缺 id/name 则整体判无效', () => {
    expect(parseNativeSession(JSON.stringify({ token: 'tok', employee: { id: 'e1', name: '张三' } })))
      .toEqual({ token: 'tok', employee: { id: 'e1', name: '张三', tenantId: '', phone: '' } })
    expect(parseNativeSession(JSON.stringify({ token: 'tok', employee: { name: '张三' } }))).toBeNull()
  })

  it('空值 / 坏 JSON / 缺 token:一律 null,绝不半领养', () => {
    expect(parseNativeSession(null)).toBeNull()
    expect(parseNativeSession('')).toBeNull()
    expect(parseNativeSession('{oops')).toBeNull()
    expect(parseNativeSession(JSON.stringify({ employee }))).toBeNull()
    expect(parseNativeSession(JSON.stringify({ token: '', employee }))).toBeNull()
  })
})

// ★这是一条**决策锁**,不是行为测试:这个值决定每个 App 用户每天第一眼看到什么,
//   改它不会有任何报错。它已经被反过来定过一次(2026-08-02 定「我的助手」,
//   2026-08-25 需求方改口定「首页」),所以看到它和某处旧注释对不上时,
//   要找最新的那次决定,别当成漏改顺手改回去。要改请连这条测试一起改。
describe('App 落地页', () => {
  it('落 PCB CAM', () => {
    expect(NATIVE_LANDING_SECTION).toBe('pcb-cam')
  })

  // ★这一组守的是那个只在**第二次**登录才现形的缺陷:
  //   原实现只在 sessionStorage 为空时才设落地页 —— 冷启动是空的,所以第一次看着没问题。
  //   但「退出登录 → 回壳 → 再登录」全程在同一个 webview 标签页里,租户域名的
  //   sessionStorage 还留着上次停的位置,于是从第二次登录起就再也落不到首页,
  //   而且不报任何错。判据必须是「这一跳是不是壳交接过来的」,不是「storage 空不空」。
  it('壳交接进来(刚登录/刚进入)→ 落首页,哪怕 storage 里还留着上次的位置', () => {
    expect(landingSectionFor(true, 'notifications')).toBe('pcb-cam')
    expect(landingSectionFor(true, null)).toBe('pcb-cam')
  })

  it('不是壳交接(页内刷新/热恢复)→ 留在原地,别抢用户自己走到的页', () => {
    expect(landingSectionFor(false, 'finance-invoices')).toBeNull()
  })

  it('不是壳交接但也没有去处 → 仍给落地页(普通冷启动)', () => {
    expect(landingSectionFor(false, null)).toBe('pcb-cam')
    expect(landingSectionFor(false, '')).toBe('pcb-cam')
  })

  // 落地页必须是 tab 栏/菜单里真实存在的 key —— 写错的表现是「进去一片空白」,
  // 而 App.vue 的可见性守卫只在「不可见」时兜底,拼错的 key 它同样会兜,于是错得很安静。
  it('★落地页是 nav-catalog 里真实存在的菜单项', () => {
    const keys = NAV_CATALOG.flatMap((g) => flattenNavItems(g.items)).map((i) => i.key)
    expect(keys, `${NATIVE_LANDING_SECTION} 不在 nav-catalog 里`).toContain(NATIVE_LANDING_SECTION)
  })
})

// ★谁负责「判死一个被吊销的会话」——这是壳与 H5 之间的一条契约,改错会造出一个死循环。
//
// 背景:壳把会话存在 Preferences,H5 冷启动时领养。**被吊销但还没到期**的 token 本地看着是活的,
// 所以只要没人清它,壳每次冷启动都会再交出来一遍、H5 再 401 一次,重启也一样,
// 只能等到期才自己解开。原来这件事由壳启动时那次 `/api/me` 探活兜住,代价是**每次冷启动
// 都要先等一整个 RTT**(而且走原生 HTTP 栈,与 webview 不共用连接,那一跳期间 H5 没开始下)。
// 现在责任移到 H5:真收到 401 就当场清掉壳里那份,壳因此不必再为此多等一跳。
// 这条断言扫源码而不是跑行为 —— 领养那半要真机注入的 window.Capacitor(见文件头)。
describe('★吊销会话由 H5 当场清掉(壳不必靠探活判死)', () => {
  const src = readFileSync(join(import.meta.dirname, 'native-app.ts'), 'utf8')

  it('监听 AUTH_EXPIRED_EVENT', () => {
    expect(src, '401 时没有清壳里的会话 —— 被吊销的 token 会让冷启动陷入「交出→401→再交出」').toMatch(
      /addEventListener\(\s*AUTH_EXPIRED_EVENT/,
    )
  })

  it('监听里做的是删 NATIVE_SESSION_PREF_KEY', () => {
    const idx = src.search(/addEventListener\(\s*AUTH_EXPIRED_EVENT/)
    expect(idx).toBeGreaterThan(-1)
    const body = src.slice(idx, idx + 1200)
    expect(body).toContain('prefs.remove')
    expect(body).toContain('NATIVE_SESSION_PREF_KEY')
  })

  // ★2026-08-18 需求方要求:服务器出问题时人要停在**最外层(壳)**登录页,不是 H5 自己的登录页。
  //   只有壳那一页能改服务器地址、能处理 409 AMBIGUOUS_TENANT,而且三个字段都是预填好的
  //   —— 而「服务器有异常」恰恰是最需要换域名/重试的时候。少了这一跳,表现是「登录失败后
  //   卡在一个换不了域名的页面上」,四道闸全绿、只有真机上看得出来。
  it('★清完之后退回壳登录页(不是停在 H5 登录页)', () => {
    const idx = src.search(/addEventListener\(\s*AUTH_EXPIRED_EVENT/)
    const body = src.slice(idx, idx + 1200)
    expect(body, '401 之后没有退回壳登录页 —— 用户会卡在 H5 登录页,换不了服务器地址').toContain(
      'window.location.replace(shellLoginOrigin() + SHELL_LOGOUT_HASH)',
    )
  })

  it('壳登录页 origin 只有一处定义(主动退出与被动 401 共用)', () => {
    expect(src.match(/capacitor:\/\/localhost\//g) ?? []).toHaveLength(1)
    expect(src.match(/window\.location\.replace\(shellLoginOrigin\(\) \+ SHELL_LOGOUT_HASH\)/g) ?? []).toHaveLength(2)
  })
})

// ★壳配置里 appendUserAgent 的**层级**。扫的是 mobile-app/capacitor.config.ts 的字面量。
//
// 背景(2026-08-21 查安卓登录跳转时发现):这一句从壳的第一个提交起就被写在 `server:` 里,
// 而 Capacitor 读的是**顶层** `appendUserAgent`(可被 `android.` / `ios.` 覆盖),
// `server` 只认 hostname / iosScheme / androidScheme / url / cleartext /
// allowNavigation / errorPath / appStartPath。放错层级**不报错、不警告、也不影响构建**,
// 只是被整个忽略 —— 于是 UA 里永远没有 AIOSShell。
//
// 它没早点现形,是因为 iOS/安卓上 isNativeShell() 的**主**判据 window.Capacitor 一直好使,
// 鸿蒙壳又是自己在原生侧拼 UA(harmony-app/.../WebHost.ets)。也就是说:代码注释里承诺的
// 那条「备份判据」其实一天都没生效过 —— 主判据哪天出问题,就没有第二条腿。
//
// ⚠️ 这条扫的是源码,挡得住「有人又把它挪回 server 里」,挡不住「Capacitor 换了键名」。
//    真机上一句 `navigator.userAgent` 才是最终判据。
describe('★壳的 appendUserAgent 必须在顶层(放进 server 会被静默忽略)', () => {
  const cfg = readFileSync(join(import.meta.dirname, '../../mobile-app/capacitor.config.ts'), 'utf8')
  // `server: {` 到与之同缩进的 `},` 之间
  const serverBlock = cfg.match(/\n {2}server: \{[\s\S]*?\n {2}\},/)?.[0] ?? ''

  it('config 里确实有这一句', () => {
    expect(cfg).toMatch(/appendUserAgent:\s*'[^']+'/)
  })

  it('不在 server 块里', () => {
    expect(serverBlock, 'server 块没抠出来,解析逻辑坏了').not.toBe('')
    expect(
      serverBlock,
      'appendUserAgent 又被放回 server 里了 —— Capacitor 不读那一层,UA 里不会有 AIOSShell',
    ).not.toContain('appendUserAgent')
  })

  it('在顶层(两空格缩进,与 appId/webDir 同级)', () => {
    expect(cfg, 'appendUserAgent 不在顶层 —— 只有顶层(或 android./ios. 覆盖)才会被读取').toMatch(
      /\n {2}appendUserAgent:\s*'[^']+',/,
    )
  })

  it('UA 里那个串正是 isNativeShell() 拿去匹配的那个', () => {
    const ua = cfg.match(/\n {2}appendUserAgent:\s*'([^']+)'/)?.[1] ?? ''
    const src = readFileSync(join(import.meta.dirname, 'native-app.ts'), 'utf8')
    const needle = src.match(/return \/([A-Za-z0-9]+)\/\.test\(navigator\.userAgent\)/)?.[1] ?? ''
    expect(needle, 'native-app.ts 里那条 UA 兜底判据不见了,这条对账就白跑了').not.toBe('')
    expect(ua, `壳发的 UA「${ua}」里不含 H5 要找的「${needle}」—— 兜底判据永远为假`).toContain(needle)
  })
})

// ★壳→H5 的**第二条**会话通道(URL fragment)。2026-08-21 加,原因是安卓上第一条通道会静默断掉:
//   webview 从 https://localhost 跳到租户域名后 window.Capacitor 就没了,壳写进 Preferences
//   的会话没有任何人接得到 —— 表现成「壳登录成功却落在 AIOS 登录页要你再输一遍」,而且不报错。
//   与壳侧 mobile-app/shell/app.js 的 HANDOFF_PREFIX 是同一个串,改一边两边都要改。
describe('壳经 URL fragment 递来的会话', () => {
  const employee = { id: 'e1', name: '张三', tenantId: 't1', phone: '13800000000' }
  const session = { token: 'tok-abc', employee }

  function setHash(h: string) {
    window.history.replaceState(null, '', '/some/path?q=1' + h)
  }

  it('取得出会话,并且**当场**把 token 从地址上抹掉(path/query 保留)', () => {
    setHash('#' + SHELL_HANDOFF_PREFIX + encodeURIComponent(JSON.stringify(session)))
    expect(takeSessionFromHash()).toEqual(session)
    expect(window.location.hash, 'token 还挂在 hash 上 —— 会被 App.vue 的 parseHash 当成路由,也不该留着').toBe('')
    expect(window.location.pathname + window.location.search).toBe('/some/path?q=1')
  })

  it('不是这个前缀的 hash 一律不碰(别把正常路由 #/messenger/xx 抹了)', () => {
    setHash('#/messenger/c-1')
    expect(takeSessionFromHash()).toBeNull()
    expect(window.location.hash, '把 H5 自己的路由 hash 抹掉了 —— 深链会失效').toBe('#/messenger/c-1')
  })

  it('没有 hash 时返回 null', () => {
    setHash('')
    expect(takeSessionFromHash()).toBeNull()
  })

  it('★内容坏掉时:返回 null,但 hash 仍然被抹掉(不能把 token 留在地址上)', () => {
    setHash('#' + SHELL_HANDOFF_PREFIX + encodeURIComponent('{oops'))
    expect(takeSessionFromHash()).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('缺 id/name 的会话判无效(与 Preferences 那条同一套规则,不能半领养)', () => {
    setHash('#' + SHELL_HANDOFF_PREFIX + encodeURIComponent(JSON.stringify({ token: 't', employee: { id: 'e1' } })))
    expect(takeSessionFromHash()).toBeNull()
    expect(window.location.hash).toBe('')
  })
})

// ★壳与 H5 之间那两个字面量必须逐字相同 —— 它们分处两个不会一起编译的工程,
//   拼错只会表现成「登录后还是要再输一遍」,没有任何编译期或运行期报错。
describe('★壳侧与 H5 侧的交接约定必须对得上', () => {
  const shell = readFileSync(join(import.meta.dirname, '../../mobile-app/shell/app.js'), 'utf8')

  it('fragment 前缀两边一致', () => {
    const m = shell.match(/const HANDOFF_PREFIX = '#([^']+)'/)
    expect(m, "壳里找不到 HANDOFF_PREFIX —— 交接通道被删了?").not.toBeNull()
    expect(m![1], '壳发的前缀与 H5 认的前缀对不上,会话交接会静默失败').toBe(SHELL_HANDOFF_PREFIX)
  })

  it('壳的 enter() 真的把会话拼进了 URL(不是只定义了常量)', () => {
    expect(shell, 'enter() 没有带上 fragment —— 安卓上会话交接仍然只有 Preferences 那一条腿').toMatch(
      /window\.location\.replace\(origin \+ '\/' \+ frag\)/,
    )
  })

  it('壳的 boot() 认得退出标记(否则退出后会被弹回租户域名)', () => {
    expect(shell, "壳不认 #logout —— 桥不在时 H5 那句 prefs.remove 是空操作,壳会立刻 enter() 弹回去").toMatch(
      /location\.hash === '#logout'/,
    )
    const idx = shell.search(/location\.hash === '#logout'/)
    expect(shell.slice(idx, idx + 400), '认了标记却没清会话,等于没认').toContain('prefs.remove(PREF_SESSION)')
  })
})
