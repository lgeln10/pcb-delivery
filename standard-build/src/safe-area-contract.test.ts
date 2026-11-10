// 安全区契约的护栏(扫源码,同 responsive-breakpoints.test.ts 的做法)。
//
// ★为什么值得写:2026-08-03 之前,全站直接写 `env(safe-area-inset-*)`,而**安卓上那个值是错的** ——
//   安卓 WebView 只把刘海(display cutout)算进 safe-area,状态栏高度和底部手势条高度它一概不报。
//   壳的 targetSdk = 35,Android 15 起强制 edge-to-edge(内容铺到系统栏底下),
//   于是:顶栏标题被状态栏的时间/信号盖住、底部 tab 栏被手势条盖住,而 CSS 侧毫无察觉。
//
//   修法是把安全区收成四个变量,安卓/鸿蒙壳由原生注入真值覆盖。这就产生了两条必须钉住的约束:
//   ① 页面样式不能再退回去直接写 env() —— 那等于绕过原生注入,安卓上又变回 0;
//   ② 原生注入的变量名必须和 CSS 消费的变量名一致 —— 拼错不会报错,只是永远回退到默认值,
//      现象和「压根没做适配」一模一样,极难从现场反查。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const repoRoot = join(root, '..')
const stylesCss = readFileSync(join(root, 'src/styles.css'), 'utf8')

/** 前端样式的全部落点:src(壳层)+ core/ui-kit(公共组件)+ modules(各业务页) */
const SCAN_DIRS = ['src', 'core', 'modules']

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(css|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 安全区四变量的规范名字 */
const SAFE_VARS = ['--sb-safe-top', '--sb-safe-bottom', '--sb-safe-left', '--sb-safe-right'] as const

/** styles.css 里定义默认值(回退到 env())的那个 :root 块 */
function contractBlock(): string {
  const m = stylesCss.match(/:root\s*\{[^}]*--sb-safe-top[^}]*\}/)
  expect(m, 'styles.css 里找不到定义 --sb-safe-* 的 :root 块').not.toBeNull()
  return m![0]
}

describe('安全区契约', () => {
  it('四个变量都在 styles.css 的 :root 里定义,且默认值回退到 env()', () => {
    const block = contractBlock()
    for (const v of SAFE_VARS) {
      const decl = new RegExp(`${v}:\\s*env\\(safe-area-inset-(top|bottom|left|right),\\s*0px\\)`)
      expect(block, `${v} 缺少「回退到 env() 且兜底 0px」的默认值`).toMatch(decl)
    }
  })

  it('★除了那个 :root 契约块,前端源码里不许再直接写 env(safe-area-inset-*)', () => {
    // 直接写 = 绕过原生注入 = 安卓上取 0 = 顶栏被状态栏盖住(见文件头)
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const path of walk(join(root, dir))) {
        const text = readFileSync(path, 'utf8')
        if (!text.includes('env(safe-area-inset-')) continue
        // 契约块自己当然要写 env() —— 它就是回退值的定义处;注释里提它也不算数
        const body = (path === join(root, 'src/styles.css') ? text.replace(contractBlock(), '') : text)
          .replace(/\/\*[\s\S]*?\*\//g, '')
        if (body.includes('env(safe-area-inset-')) offenders.push(relative(root, path))
      }
    }
    expect(offenders, '这些文件绕过了 --sb-safe-* 契约,安卓壳里会取到 0').toEqual([])
  })

  it('安卓壳注入的变量名与 CSS 消费的完全一致(拼错只会静默回退到默认值)', () => {
    const java = readFileSync(
      join(repoRoot, 'mobile-app/android/app/src/main/java/ai/sixamtech/aios/MainActivity.java'),
      'utf8',
    )
    for (const v of SAFE_VARS) {
      expect(java, `MainActivity 没有注入 ${v}`).toContain(`setProperty('${v}'`)
    }
    // ★edge-to-edge 是这套注入成立的前提:不开的话 inset 全是 0,注了也没用;
    //   反过来,开了却不注入 = 内容直接被系统栏盖住。两者必须成对存在。
    expect(java, 'MainActivity 没开 edge-to-edge,注入的 inset 会全是 0').toContain('setDecorFitsSystemWindows')
  })

  it('H5 不许再调 StatusBar.setOverlaysWebView —— 安卓 15 上是空操作,iOS 上会插一条黑带', () => {
    const nativeApp = readFileSync(join(root, 'src/native-app.ts'), 'utf8')
    const calls = nativeApp.match(/^\s*[^/\n]*\bsetOverlaysWebView\s*\(/gm) ?? []
    expect(calls, '发现真实调用(注释里提它没问题)').toEqual([])
  })
})
