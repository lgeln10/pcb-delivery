// 护栏固化:权限点在「角色与权限」页里必须**说得清是什么、在哪个菜单组**。
// 与 nav-permission-guard.test.ts 配对 —— 那条管「菜单有没有注册权限码」(从菜单看权限),
// 这条管「权限码在配置页里有没有中文名和归属」(从权限看菜单)。两头都堵住,
// 新模块无论从哪一侧加进来都会被检查到。
import { describe, expect, it } from 'vitest'
import { listPermissionGroupingIssues } from '../permission-grouping-guard'

describe('权限分组护栏', () => {
  it('每个有权限点的模块都有中文名,且归到某个菜单组(不落进「其他」)', async () => {
    const issues = await listPermissionGroupingIssues()
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([])
  })
})
