// 「今天」不能用 UTC 算 —— 扫 .vue 源码,基线只降不升。
//
// ★病灶:`new Date().toISOString().slice(0, 10)` 取的是 **UTC** 日期,而同一个页面里用
//   `getFullYear/getMonth/getDate` 拼出来的日期是**本地**的。东八区 00:00–08:00 这一段,
//   本地已经是 16 号、UTC 还停在 15 号,两套时钟就会在同一个请求里打架。
//
// ★真实代价(2026-08-16 凌晨实测):CRM 驾驶舱把 `asOf`(UTC=15)和 `endDate`(本地=16)
//   一起发出去,后端那条「endDate 不能晚于今天」直接 400,**整页显示「暂无CRM数据」**。
//   而空态文案写的是「录入线索或商机后会显示驾驶舱」—— 看上去像没数据,其实是接口挂了,
//   这种「错得像正常」的形态最难被报上来。
//
// 其余站点的表现轻一些但同样是错的:凌晨建单据,日期默认成昨天。
// 它们还没改(改动会碰到别的会话正在动的模块),所以在这里列成基线:
//   - 不许新增(名单外出现即红)
//   - 名单里的改好了就从名单里删,只降不升
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
// 10 = 日、7 = 月(YYYY-MM,会计/报表/工资期间)、4 = 年。三种都是同一个病:UTC 切片当本地。
// 月和年更少被撞到所以更难查:只有**每月 1 号 / 元旦的 00:00–08:00**(东八区)才露馅。
const PATTERN = /new Date\([^)]*\)\.toISOString\(\)\.slice\(0,\s*(?:4|7|10)\)|\bd\.toISOString\(\)\.slice\(0,\s*(?:4|7|10)\)/

/**
 * 已知未修站点。**2026-08-23 起是空的** —— 原来那 17 处已按模块全部收完(见同日的 10 条提交)。
 *
 * 名单留着不删,是因为它的作用不是「记账」而是「留一条可控的退路」:
 * 将来真有一处改不动(比如某页正被别的会话大改、硬改会撞车),把文件名加进来
 * 比让护栏一直红着强 —— **红久了会被人删掉,连它记的那段来历一起消失**。
 * 加进来的同时必须写清为什么、以及打算什么时候收。★只准变短。
 */
const KNOWN = new Set<string>([
  // (空)
])

function walkVue(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkVue(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

describe('「今天」按本地时区算', () => {
  const offenders = walkVue(join(root, 'modules'))
    .concat(walkVue(join(root, 'src')))
    .filter((p) => {
      const src = readFileSync(p, 'utf8')
      // 注释行不算(讲这条坑的注释里会出现这个字符串)
      return src
        .split('\n')
        .some((line) => !/^\s*(\*|\/\/)/.test(line) && PATTERN.test(line))
    })
    .map((p) => p.slice(root.length + 1))

  it('★没有新增的 UTC 取「今天」', () => {
    const fresh = offenders.filter((f) => !KNOWN.has(f))
    expect(fresh, `这些文件用 UTC 取本地「今天」,凌晨会差一天:\n${fresh.join('\n')}\n改用本地拼日期(参考 CrmDashboard.vue 的 localDate)`).toEqual([])
  })

  it('★基线只降不升 —— 修好的要从 KNOWN 里删掉', () => {
    const stale = [...KNOWN].filter((f) => !offenders.includes(f))
    expect(stale, `这些已经修好了,请从本测试的 KNOWN 名单删除:\n${stale.join('\n')}`).toEqual([])
  })

  it('护栏本身有效:把 today 改回 UTC 写法能被认出来', () => {
    // 防止上面那条因为正则写歪变成永远通过的空断言(同 tab-pane-lazy-guard 的做法)
    const bad = "const today = new Date().toISOString().slice(0, 10)"
    const good = "const today = localDate()"
    expect((bad.match(/const today = (.+)/)?.[1] ?? '').includes('localDate()')).toBe(false)
    expect((good.match(/const today = (.+)/)?.[1] ?? '').includes('localDate()')).toBe(true)
  })
})
