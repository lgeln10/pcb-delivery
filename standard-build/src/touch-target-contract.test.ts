// 触控目标尺寸的护栏(扫 styles.css,同 safe-area-contract.test.ts 的做法)。
//
// ★为什么必须扫源码而不是「跑一下看看」:jsdom 没有布局,单测量不出高度;而真出问题时的现象是
//   「手机上按钮有点难点」——没人会为此开 bug,它就一直在那儿。2026-08-15 在 375×812 下逐元素量过,
//   全站的可交互控件普遍只有 24~32px(iOS HIG 要 44pt、安卓要 48dp)。
//
// ★这一条尤其要钉死的是**「变量抬了 ≠ 控件变高了」**:
//   styles.css 里那个触屏媒体块早就把 `--el-component-size` 抬到了 40px,注释还写着
//   「EP 的输入/选择/按钮一起跟随」—— **按钮那半句是错的**。element-plus 把 `.el-button`
//   的高度**写死成 `height: 32px`**(不是变量),`.el-select__wrapper` 则把 min-height
//   写死在自己身上。所以光抬变量,按钮和下拉一动不动,而且**看不出来**——
//   变量确实变了,DevTools 里查 :root 一切正常。
//   (2026-08-16 订正:这里原先写的「.el-button 压根没有 height 声明,32px 是 padding 撑出来的」
//    是错的 —— 结论对、理由错。同一句话当时被抄进了 styles.css 和 docs/UI_SPEC.md,已一并改。)
//   必须逐个控件显式覆盖 min-height,本护栏就是查这些覆盖还在不在。
//
// ★第二个坑(2026-08-16):**光写了覆盖也不够,还得赢得了层叠。**
//   EP 按需引入后它的 CSS 排在 styles.css 后面,同特指度平手时 EP 赢 ——
//   `.el-select--small .el-select__wrapper` 这种「把复合选择器一并写出来」的老办法失效了
//   (只是打平,不是打赢),实测手机上小号下拉被压回 **24px**。
//   所以下拉/输入的覆盖改成单类名 + `!important`。谁负责扫这类失效:`ep-cascade-guard.test.ts`。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesCss = readFileSync(join(import.meta.dirname, '..', 'src/styles.css'), 'utf8')

/** 触屏 + 窄布局那个媒体块的块体(整块取出来,里面的规则才算数) */
function touchBlock(): string {
  const marker = '@media (any-pointer: coarse) and (max-width:'
  const start = stylesCss.indexOf(marker)
  expect(start, '找不到「触屏 + 窄布局」的媒体块,选择器形状变了就更新本测试').toBeGreaterThan(-1)
  const open = stylesCss.indexOf('{', start)
  let depth = 1
  let i = open + 1
  while (i < stylesCss.length && depth > 0) {
    if (stylesCss[i] === '{') depth++
    else if (stylesCss[i] === '}') depth--
    i++
  }
  // ★必须去掉注释再匹配:注释里会**引用 EP 的原值**(例如说明
  //   `.el-tabs{--el-tabs-header-height:40px}` 为什么要覆盖),
  //   不去注释的话正则会先撞上那个 40px,把「已经改成 44」的代码判成不达标。
  return stylesCss.slice(open + 1, i - 1).replace(/\/\*[\s\S]*?\*\//g, '')
}

/** iOS HIG 44pt = 本仓的下限档(安卓 48dp 更严,这里取两者中较宽松的那个当硬门槛) */
const MIN_TOUCH_PX = 44

describe('触控目标尺寸', () => {
  const block = touchBlock()

  it('★三档组件尺寸变量都 ≥44px —— 手机上不存在「小控件」这一档', () => {
    // --el-tabs-header-height 也在这里:el-tabs 的标签高度就是它(header 与 item 共用),
    // 走变量而不是抢选择器 —— 变量不参与层叠优先级,天然不会被 EP 的顺序问题咬到。
    for (const name of [
      '--el-component-size',
      '--el-component-size-small',
      '--el-component-size-large',
      '--el-tabs-header-height',
    ]) {
      const m = block.match(new RegExp(`${name}\\s*:\\s*(\\d+)px`))
      expect(m, `触屏块里没有设 ${name}`).not.toBeNull()
      expect(Number(m![1]), `${name} 低于触控下限`).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
    }
  })

  it('★逐个控件显式覆盖 min-height —— 只抬变量对按钮/下拉无效(见文件头)', () => {
    // 每一项:[人话, 必须在触屏块里出现的选择器]
    const required: Array<[string, string]> = [
      ['普通按钮', '.el-button'],
      ['文字按钮(EP 写死 height:auto + padding:2px)', '.el-button.is-link'],
      ['下拉(含 --small/--large:靠 !important 一条盖三档)', '.el-select__wrapper'],
      ['输入框', '.el-input__wrapper'],
      ['单选按钮组(列表/看板、今日/本周…)', '.el-radio-button__inner'],
      ['勾选框(扩命中区,不是把方框撑大)', '.el-checkbox'],
      ['分页', '.el-pagination'],
      ['筛选折叠开关', '.filter-bar__toggle'],
    ]
    const missing = required.filter(([, sel]) => !block.includes(sel)).map(([why, sel]) => `${sel}(${why})`)
    expect(missing, `触屏块里少了这些控件的尺寸覆盖:\n${missing.join('\n')}`).toEqual([])
  })

  it('★覆盖用的是变量不是魔数 —— 否则下次调下限只改了变量、控件还是旧值', () => {
    // 取块内所有 min-height 声明,允许 0/auto,其余必须引用 --el-component-size*
    const decls = [...block.matchAll(/min-height\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim())
    const bad = decls.filter((v) => !/var\(--el-component-size/.test(v) && !/^(0|auto)$/.test(v))
    expect(bad, `这些 min-height 写了定值,应该走 var(--el-component-size*):\n${bad.join('\n')}`).toEqual([])
  })

  // ════════ 唯一的例外形态:缩墨迹、不缩命中区 ════════
  // 2026-08-27 加。起因:窄屏列表卡片里一个「删除」按钮撑到 44px,把一张 82px 的卡片顶成 138px。
  // 44px 是**手指够得着**的下限,不是**必须画这么大**的下限 —— .el-checkbox 那条早就是这么做的
  // (方框仍是 14px,扩的是命中区)。所以允许压视觉高度,但必须同时把命中区补回来。
  //
  // ★这几条存在的意义是**堵住抄错**:下一个人看到「原来可以写 height: 32px」,
  //   很可能只抄前半句(压高度)不抄后半句(补 ::after),而少了后半句在真机上的表现是
  //   「按钮变好看了、也还能点中」—— 因为手指比 32px 宽容,只有点得快、点边缘时才偶尔失手。
  //   没人会为此报 bug,和文件头说的那个病一模一样。
  describe('例外:压视觉高度必须配命中区', () => {
    /** 把块体切成 [选择器, 声明体] 对(足够应付本文件这种扁平规则,块里没有嵌套 @) */
    function rules(css: string): Array<[string, string]> {
      const out: Array<[string, string]> = []
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        out.push([m[1]!.replace(/\s+/g, ' ').trim(), m[2]!])
      }
      return out
    }

    it('★补回来的量是算出来的,不是拍的 —— 改 44 这个下限时命中区跟着走', () => {
      // grow 必须由 (下限 - 墨迹) / 2 推出:写死 6px 的话,以后把下限调到 48,命中区还是 44。
      expect(block).toMatch(/--sb-tap-grow:\s*calc\(\(var\(--el-component-size\)\s*-\s*var\(--sb-tap-ink\)\)\s*\/\s*2\)/)
    })

    it('★换行后两行命中区不重叠 —— 否则「点下面那个,触发上面那个」', () => {
      // row-gap 必须 = 下限 - 墨迹(= 2×grow)。小于它,上下两行各自外扩的命中区就叠在一起。
      const actions = rules(block).find(([sel]) => sel === '.crm-card__actions')
      expect(actions, '触屏块里没有 .crm-card__actions 规则').toBeTruthy()
      expect(actions![1]).toMatch(/row-gap:\s*calc\(var\(--el-component-size\)\s*-\s*var\(--sb-tap-ink\)\)/)
    })

    it('★凡是压了墨迹高度的选择器,都得有配套的 ::after 把命中区撑回去', () => {
      const all = rules(block)
      const shrunk = all.filter(([, d]) => /height:\s*var\(--sb-tap-ink\)/.test(d))
      expect(shrunk.length, '没找到任何压墨迹的规则 —— 选择器形状变了就更新本测试').toBeGreaterThan(0)
      const missing: string[] = []
      for (const [sel] of shrunk) {
        for (const one of sel.split(',').map((s) => s.trim())) {
          const after = all.find(([s, d]) => s.split(',').some((x) => x.trim() === `${one}::after`) && /inset:\s*calc\(-1\s*\*\s*var\(--sb-tap-grow\)\)/.test(d))
          if (!after) missing.push(one)
        }
      }
      expect(missing, `这些选择器压了高度却没补命中区:\n${missing.join('\n')}`).toEqual([])
    })

    it('★除了这个走变量的口子,块里不许再出现写死的小尺寸', () => {
      // 负向前查排除 --xxx-height 这类自定义属性名(它们是**定义**下限,不是把控件压小)
      const lits = [...block.matchAll(/(?<![-\w])(height|width)\s*:\s*(\d+)px/g)]
      const bad = lits.filter((m) => Number(m[2]) < MIN_TOUCH_PX).map((m) => m[0])
      expect(bad, `这些写死的尺寸低于触控下限,要么走 --sb-tap-ink + ::after 那套,要么别写:\n${bad.join('\n')}`).toEqual([])
    })
  })

  it('护栏本身有效(改坏了能报出来)', () => {
    // 防止上面几条因为取块/正则写错而变成永远通过的空断言
    expect(block.length).toBeGreaterThan(200)
    expect(block).toContain('--el-component-size')
    const fake = '--el-component-size: 32px;'
    expect(Number(fake.match(/--el-component-size\s*:\s*(\d+)px/)![1])).toBeLessThan(MIN_TOUCH_PX)

    // 「不许写死小尺寸」那条在当前代码里找不到任何命中(块里的高度全走变量),
    // 空断言恒绿 —— 所以在这里拿假样本验一遍:该抓的抓得住、该放的不误伤。
    const litRe = /(?<![-\w])(height|width)\s*:\s*(\d+)px/g
    expect([...'  height: 32px;'.matchAll(litRe)]).toHaveLength(1)
    expect([...'  --el-tabs-header-height: 40px;'.matchAll(litRe)]).toHaveLength(0)
  })
})
