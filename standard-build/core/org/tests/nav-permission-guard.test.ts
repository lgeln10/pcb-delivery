// 质量护栏固化:导航入口必须注册权限(CLAUDE.md 红线),防再次出现「新功能带独立入口
// 却没在权限配置里注册对应权限点」——曾出现过怀疑报销OCR配置/审批配置未受权限控制的排查,
// 逐层核实后两者本身是对的,但当时没有可断言的护栏,只能靠人工逐文件核对。这条测试把那次
// 核对过程固化下来,后续任何模块新增导航项都会被自动检查。
import { describe, expect, it } from 'vitest'
import { listNavPermissionIssues } from '../nav-permission-guard'

describe('导航项权限护栏', () => {
  it('每个导航项要么注册了权限码,要么在白名单里说明为何全员可见', async () => {
    const issues = await listNavPermissionIssues()
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([])
  })

  // ★上面那条是**正则扫源码**抠导航项的,而二级文件夹(多行对象)恰好被正则跳过 —— 这是对的
  //   (文件夹不是页面、没有权限),但它是「碰巧成立」而非「写明如此」。这条把它钉死:
  //   扫出来的叶子集合必须与 flattenNavItems 完全一致。
  //   少一个 = 有页面没被权限护栏检查到(漏网的正是最危险的那种);
  //   多一个 = 文件夹被当成页面扫进来了(它没有 permission,会误报)。
  it('★正则扫出的叶子集合 == flattenNavItems(文件夹不算页面,子菜单一个都不能漏检)', async () => {
    const { NAV_CATALOG, flattenNavItems, isNavFolder } = await import('../../../src/nav-catalog')
    const { extractNavItemsForTest } = await import('../nav-permission-guard')

    const scanned = new Set((await extractNavItemsForTest()).map((i) => i.key))
    const real = new Set(NAV_CATALOG.flatMap((g) => flattenNavItems(g.items)).map((i) => i.key))
    const folders = NAV_CATALOG.flatMap((g) => g.items.filter(isNavFolder)).map((f) => f.key)

    const missed = [...real].filter((k) => !scanned.has(k))
    expect(missed, `这些菜单没被权限护栏扫到(等于没受检查):${missed.join('、')}`).toEqual([])
    const extra = [...scanned].filter((k) => !real.has(k))
    expect(extra, `这些不是叶子菜单却被当成页面扫进来了(多半是文件夹写成了单行):${extra.join('、')}`).toEqual([])
    // 本仓裁掉 CRM/财务后不再有二级文件夹。叶子集合仍须与正则扫描一致。
    expect(folders, '本仓导航不再使用二级文件夹').toEqual([])
  })

  // ★真实发生过(2026-08-02 修):加了二级文件夹后,App.vue 里两处「遍历所有页面」仍写着
  //   `groups.flatMap(g => g.items)` —— 拿到的是**文件夹对象**,文件夹里那 10 个页面
  //   (银行对账/固定资产/客户查重…)一个都不在集合里。表现:进这些页标题栏显示「工作台」,
  //   而且通知深链、浏览器返回都跳不进去。两处都不抛错、类型也过(NavEntryView 是联合类型)。
  //   所以只能扫源码钉住:展开文件夹的活统一交给 flattenEntries / visibleLeaves。
  it('★App.vue 不得直接遍历 g.items(会漏掉二级文件夹里的页面)', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile('src/App.vue', 'utf8')
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      // 注释里要能原样引用这个反面写法(上面那段说明就引了),否则这条测试自己就把自己判红
      .filter(({ line }) => !(line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')))
      .filter(({ line }) => /\.flatMap\(\s*\(?\s*g\s*\)?\s*=>\s*g\.items/.test(line))
    expect(
      offenders,
      `这些行直接摊平了 g.items,文件夹里的页面会被漏掉;改用 flattenEntries(g.items) 或 visibleLeaves:\n` +
        offenders.map((o) => `  App.vue:${o.no}  ${o.line}`).join('\n'),
    ).toEqual([])
  })
})
