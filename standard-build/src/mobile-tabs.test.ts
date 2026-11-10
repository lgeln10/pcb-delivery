import { describe, expect, it } from 'vitest'
import { MIN_TABS_TO_SHOW, MOBILE_TABS, visibleMobileTabs } from './mobile-tabs'
import { NAV_CATALOG, flattenNavItems } from './nav-catalog'

const ALL = new Set(MOBILE_TABS.map((t) => t.key))

describe('底部 tab 栏', () => {
  it('每个 tab 都指向真实存在的菜单 key', () => {
    const known = new Set(NAV_CATALOG.flatMap((g) => flattenNavItems(g.items)).map((i) => i.key))
    for (const tab of MOBILE_TABS) expect(known, `tab「${tab.label}」→ ${tab.key}`).toContain(tab.key)
  })

  it('两个入口都可见时按 PCB、收件箱的顺序保留', () => {
    expect(visibleMobileTabs(ALL).map((t) => t.label)).toEqual(['PCB', '收件箱'])
  })

  it('少一个就整条不显示', () => {
    expect(visibleMobileTabs(new Set(['notifications']))).toEqual([])
    expect(visibleMobileTabs(ALL)).toHaveLength(MIN_TABS_TO_SHOW)
  })

  it('一个都不可见时不炸', () => {
    expect(visibleMobileTabs(new Set())).toEqual([])
  })
})
