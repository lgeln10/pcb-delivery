// core/org/nav-permission-guard.ts
// 护栏:扫 src/nav-catalog.ts 的导航项,防「新入口没注册权限」(CLAUDE.md 红线:新功能带独立入口
// 必须在权限配置里注册对应权限点)。导航结构从 App.vue 抽到 nav-catalog.ts 后,扫这份纯数据即可。
// 纯文本扫描,不依赖编译 Vue,和 feedback/knowledge.ts 的 listModulesMissingNeedsLayer 是同一套路数。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ALL_PERMISSION_DEFS } from '../http/app'

const ROOT = process.cwd() // 运行/测试均在 standard-build/ 下

// 显式白名单:刻意不门控的全员自助/首页入口(App.vue 里各自有注释说明原因)。
// 新增无 permission 字段的导航项,要么给它配权限,要么把 key 加进这里并在 App.vue 写清楚为什么全员可见。
const UNGATED_ALLOWLIST = new Set([
  // 收件箱:后端按 recipient_id = 当前登录者取数,任何人只可能看到发给自己的那些。
  // 「能不能看自己的通知」立不成一个权限码。要藏这个入口用功能开关按 key 关。
  'notifications',
  // 个人设置(头像 / 修改密码):每个人管自己的那一份。挡住它等于让人改不了自己的密码。
  // 后端只认当前登录人,不接受别人的 employeeId。
  'my-settings',
])

export type NavItemIssue = { key: string; reason: string }

/** 从 nav-catalog.ts 源码里逐行抠出导航叶子项(key + 可选 permission),不依赖编译 Vue。
 *  ★正则要求整个 `{...}` 在同一行,所以**分组**(`{ key, label, items: [...] }`)与
 *  **二级文件夹**(`{ key, label, children: [...] }`)这类跨行对象都不会被当成叶子项 ——
 *  它们不是页面,本来就没有 permission,扫进来只会误报。文件夹里的子菜单仍是单行,照常受检。
 *  这条「碰巧成立」的性质由 tests/nav-permission-guard.test.ts 钉死(扫出的集合 == flattenNavItems)。 */
function extractNavItems(source: string): { key: string; permission?: string }[] {
  const items: { key: string; permission?: string }[] = []
  for (const line of source.split('\n')) {
    if (/items:\s*\[/.test(line)) continue // 分组对象自身那一行,跳过
    const m = /^\s*\{\s*key:\s*'([\w-]+)'.*\}\s*,?\s*$/.exec(line)
    if (!m) continue
    const permMatch = /permission:\s*'([\w:.-]+)'/.exec(line)
    items.push({ key: m[1]!, permission: permMatch?.[1] })
  }
  return items
}

/**
 * 护栏用:返回「导航入口权限注册有问题」的清单。命中两类:
 * ① 没有 permission 字段,且 key 不在白名单里 —— 新入口漏配权限;
 * ② permission 字段的码,没有任何模块的 permissions.ts 注册进 ALL_PERMISSION_DEFS —— 拼写错/漏挂载。
 * 一个模块漏做,这里就变红,杜绝「新功能带独立入口却没注册权限」再次发生。
 */
/** 仅供护栏测试:把正则扫出来的叶子集合暴露出来,与 flattenNavItems 对账(防漏检/防误扫文件夹)。 */
export async function extractNavItemsForTest(): Promise<{ key: string; permission?: string }[]> {
  return extractNavItems(await readFile(resolve(ROOT, 'src/nav-catalog.ts'), 'utf8'))
}

export async function listNavPermissionIssues(): Promise<NavItemIssue[]> {
  const source = await readFile(resolve(ROOT, 'src/nav-catalog.ts'), 'utf8')
  const items = extractNavItems(source)
  const knownCodes = new Set(ALL_PERMISSION_DEFS.map((p) => p.code))
  const issues: NavItemIssue[] = []
  for (const item of items) {
    if (!item.permission) {
      if (!UNGATED_ALLOWLIST.has(item.key)) {
        issues.push({
          key: item.key,
          reason: '导航项没有 permission 字段,且不在 UNGATED_ALLOWLIST 白名单里(新入口必须注册权限;若确实要全员可见,加入白名单并在 App.vue 写注释说明原因)',
        })
      }
      continue
    }
    if (!knownCodes.has(item.permission)) {
      issues.push({
        key: item.key,
        reason: `permission 码 "${item.permission}" 未在任何模块 permissions.ts 注册(检查拼写,或是否漏加进 core/http/app.ts 的 ALL_PERMISSION_DEFS)`,
      })
    }
  }
  return issues
}
