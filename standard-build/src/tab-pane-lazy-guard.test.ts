// `<el-tab-pane>` 必须带 `lazy` —— 扫源码的护栏(同 safe-area-contract.test.ts 的做法)。
//
// ★为什么值得一条护栏:element-plus 的 tab-pane **默认把全部页签的内容一次性渲染出来**
//   (`shouldBeRender = !lazy || loaded || active`,不写 lazy 就恒真),只是用 display:none 藏起来。
//   代价不在藏起来的那几个字上,而在**首次挂载要把它们全建一遍**:
//   实测财务工作台(6 个页签)一进页面就建 4240 个 DOM 节点、主线程一个 214ms 的 long task,
//   而用户一眼只看得见其中一个页签。这台 Mac 上是 214ms,中端安卓机按 4~6 倍算就是**接近一秒的卡死**。
//   更糟的是没有页面级保活,**每次切回来都重付一次**。
//
//   加上 lazy:只渲染当前页签,访问过的会留下(loaded 一旦为真就不再销毁),
//   所以「来回切页签」照样快,省掉的是「你从没点开过的那几个」。
//
// 反过来什么时候不该加:某个页签里的东西**必须在没被打开时也存在**(比如父组件拿它的
// template ref、或者靠它挂载时的副作用去拉数据)。真遇到了,把数据获取提到父组件 script 里,
// 不要靠「反正它被渲染了」这种隐式依赖 —— 那种依赖出问题时的现象是「某个数没了」,极难反查。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const SCAN_DIRS = ['src', 'core', 'modules']

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

describe('el-tab-pane 懒渲染护栏', () => {
  it('★每个 <el-tab-pane> 都要带 lazy —— 不带就是「一进页面把所有页签都建出来」', () => {
    const offenders: string[] = []
    for (const file of SCAN_DIRS.flatMap((d) => walk(join(root, d)))) {
      const src = readFileSync(file, 'utf8')
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        // 只看开标签本身;属性不跨行(全仓现状如此,跨行了这条会漏报而不是误报)
        const m = line.match(/<el-tab-pane\b[^>]*>/)
        if (m && !/\blazy\b/.test(m[0])) offenders.push(`${relative(root, file)}:${i + 1}`)
      })
    }
    expect(offenders, `这些 <el-tab-pane> 没带 lazy:\n${offenders.join('\n')}`).toEqual([])
  })

  it('护栏本身是有效的(能认出漏写的那一行)', () => {
    // 防止上面那条因为正则写错而变成「永远通过」的空断言
    const bad = '<el-tab-pane label="x" name="x">'
    const good = '<el-tab-pane label="x" name="x" lazy>'
    expect(/<el-tab-pane\b[^>]*>/.test(bad) && !/\blazy\b/.test(bad)).toBe(true)
    expect(/\blazy\b/.test(good.match(/<el-tab-pane\b[^>]*>/)![0])).toBe(true)
  })
})
