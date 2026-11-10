// 老内核兼容底线的护栏(扫源码,同 safe-area-contract.test.ts 的做法)。
//
// ★为什么值得写:H5 不只跑在最新的浏览器里,它是 App 壳的**全部界面**,
//   而壳装在什么内核上不由我们决定 ——
//   国行小米/OPPO/vivo 没有 Play 商店,系统 WebView 由厂商自己的市场推送,常年落后;
//   华为用自家内核;企业统一采购的旧平板更是装上就不再更新。
//   这类机器的表现不是崩溃,是**掉样式**:浏览器遇到不认识的值就丢弃整条声明,
//   页面照常渲染,只是颜色没了、高度塌了 —— 我们这边一点错误都收不到。
//
// 两条钉死的规则:
//   ① `color-mix()`(Chromium 111)与 `dvh/svh/lvh`(108)必须有**同属性的静态兜底**写在前面。
//      CSS 的层叠天然支持这个写法:老内核解析不了后一条就用前一条,新内核用后一条。
//   ② 兜底必须是**前一条**,不能隔着别的属性 —— 隔开就只是碰巧还在,改动时极易被拆散。
//
// 刻意**不管**的两个(它们的降级是可接受的,列在这里是为了让这份清单是一次清点而不是遗漏):
//   · `:has()`(105)—— 不支持时整条规则失效,退回未增强的布局,都是「填满/贴底」这类优化;
//   · `text-wrap: balance`(114)—— 不支持时就是普通换行。
//
// 内核底线的另一半在原生侧:mobile-app/.../MainActivity.java 的 WEBVIEW_WARN_MAJOR。
// 那个数字盯的是**运行时 API**(会直接抛异常、白屏),这里盯的是 CSS(只掉样式)。两者不是一回事。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
/**
 * 前三个是 H5;第四个是 **App 壳自己的登录页**(mobile-app/shell,打进 APK 的 assets)。
 * ★壳那份尤其不能漏:它是开机第一屏,而且跑在**还没跳到租户域名**的时候 ——
 *   那一屏坏掉的话,用户连「哪里出了问题」都无从得知,更不会有人来报。
 */
const SCAN_DIRS = ['src', 'core', 'modules', '../mobile-app/shell']

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(css|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 去掉 /* *\/ 注释 —— 注释里提到这些特性不算用到(本文件头就提了一堆)。 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 把一段 CSS 拆成 `{ prop, raw, blockId }` 的声明序列。
 *
 * 不做完整解析 —— 只需要「同一个 `{}` 块里,这条声明的前一条是什么属性」。
 * 花括号计数 + 一个自增的块号足够:`@media` 之类的嵌套只会让块号更细,
 * 而更细只会让判定更严,不会漏放。
 */
type Decl = { prop: string; raw: string; blockId: number; line: number }
function declarations(css: string): Decl[] {
  const out: Decl[] = []
  let blockId = 0
  const stack: number[] = []
  let buf = ''
  let line = 1
  let bufLine = 1
  const flush = () => {
    const raw = buf.trim()
    buf = ''
    if (!raw) return
    const i = raw.indexOf(':')
    if (i <= 0) return
    out.push({ prop: raw.slice(0, i).trim().toLowerCase(), raw, blockId: stack[stack.length - 1] ?? 0, line: bufLine })
  }
  for (const ch of css) {
    if (ch === '\n') line++
    if (ch === '{') {
      buf = ''
      stack.push(++blockId)
      bufLine = line
    } else if (ch === '}') {
      flush()
      stack.pop()
      bufLine = line
    } else if (ch === ';') {
      flush()
      bufLine = line
    } else {
      if (!buf.trim()) bufLine = line
      buf += ch
    }
  }
  return out
}

/** 需要静态兜底的现代取值,及其可用起点(注释用,出错时直接打给人看) */
const RISKY: { re: RegExp; since: string }[] = [
  { re: /\bcolor-mix\s*\(/i, since: 'Chromium 111' },
  { re: /\b\d*\.?\d+(dvh|svh|lvh|dvw|svw|lvw)\b/i, since: 'Chromium 108' },
]

describe('老内核兼容底线', () => {
  it('★color-mix() / dvh 这类新取值必须紧跟在一条同属性的静态兜底之后', () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const path of walk(join(root, dir))) {
        const text = stripComments(readFileSync(path, 'utf8'))
        if (!RISKY.some((r) => r.re.test(text))) continue
        const decls = declarations(text)
        decls.forEach((d, i) => {
          const hit = RISKY.find((r) => r.re.test(d.raw))
          if (!hit) return
          const prev = decls[i - 1]
          const ok =
            prev !== undefined &&
            prev.blockId === d.blockId &&
            prev.prop === d.prop &&
            !RISKY.some((r) => r.re.test(prev.raw)) // 兜底自己不能也是个新特性
          if (!ok) {
            offenders.push(`${relative(root, path)}:${d.line} ${d.prop}(需要 ${hit.since} 之前的同属性兜底)`)
          }
        })
      }
    }
    expect(
      offenders,
      '这些声明在老内核上会被整条丢弃,而页面照常渲染 —— 我们收不到任何错误。\n' +
        '修法:在同一条规则里,把一条**同属性**的静态取值写在它前面。',
    ).toEqual([])
  })

  it('原生侧的内核门槛还在,且注明了它盯的是运行时 API', () => {
    // ★这两侧必须一起活着:CSS 兜底管「掉样式」,原生门槛管「跑不起来」。
    //   任何一侧被人顺手删掉,老机器上的表现都会从「有提示/能用」退回「白屏」。
    const java = readFileSync(
      join(root, '..', 'mobile-app/android/app/src/main/java/ai/sixamtech/aios/MainActivity.java'),
      'utf8',
    )
    expect(java, '安卓壳的 WEBVIEW_WARN_MAJOR 门槛没了').toMatch(/WEBVIEW_WARN_MAJOR\s*=\s*\d+/)
    expect(java, '内核过旧时没有兜底页').toContain('showEngineNotice')
  })
})
