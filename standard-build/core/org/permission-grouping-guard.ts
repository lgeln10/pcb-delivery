// core/org/permission-grouping-guard.ts
// 护栏:「角色与权限」页里每个模块都要**有中文名、有菜单组**。
//
// ★为什么需要:漏了不会报错,只会在权限抽屉里冒出一个写着 `lead-intake-email` 的英文面板,
//   落在兜底分组「其他」里。配权限的人看到的是一堆英文码,既不知道那是什么功能,也不知道
//   它在左边哪个菜单下 —— 而权限配错的代价是越权或挡住正常工作。
//   2026-08-08 巡检时有 10 个模块处于这个状态(aiagent / askai / digitalemployee /
//   im-connect / knowledge / website / visit-stats / seal-ledger / payment-voucher /
//   company-lookup),因为 MENU_GROUPS 是手抄的、从 07-30 导航改版起就没跟上。
//
// 与 nav-permission-guard 同一路数:纯文本扫 SFC,不编译 Vue。两条护栏一头一尾 ——
// 那条管「菜单有没有权限码」,这条管「权限码在配置页里说不说得清是什么」。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ALL_PERMISSION_DEFS } from '../http/app'
import { NAV_CATALOG, flattenNavItems } from '../../src/nav-catalog'

const ROOT = process.cwd() // 运行/测试均在 standard-build/ 下
const SFC = 'core/org/ui/RolePermissions.vue'

/** 抠出某个对象字面量里的**顶层键**(键在行首、后跟冒号)。只取声明行到第一个单独 `}` 行之间。 */
function objectKeys(source: string, declPrefix: string): string[] {
  const at = source.indexOf(declPrefix)
  if (at < 0) return []
  const body = source.slice(at + declPrefix.length)
  const end = body.indexOf('\n}')
  const block = end < 0 ? body : body.slice(0, end)
  return [...block.matchAll(/^\s{2}'?([\w-]+)'?\s*:/gm)].map((m) => m[1]!)
}

export type PermissionGroupingIssue = { module: string; reason: string }

/**
 * 返回「有权限点、但在角色与权限页里说不清楚」的模块。命中两类:
 * ① 没有中文名(MODULE_LABEL 里没有)→ 面板标题会显示原始模块码;
 * ② 既不在导航目录里、也不在 EXTRA_MODULE_GROUP 里 → 会掉进兜底的「其他」分组。
 */
export async function listPermissionGroupingIssues(): Promise<PermissionGroupingIssue[]> {
  const source = await readFile(resolve(ROOT, SFC), 'utf8')
  const labeled = new Set(objectKeys(source, 'const MODULE_LABEL: Record<string, string> = {'))
  const extra = new Set(objectKeys(source, 'const EXTRA_MODULE_GROUP: Record<string, string> = {'))
  const navModules = new Set(
    NAV_CATALOG.flatMap((g) => flattenNavItems(g.items))
      .map((i) => i.module)
      .filter((m): m is string => Boolean(m)),
  )

  // 自身正确性:扫不到键说明常量改名/改写法了,这条护栏就成了永远绿的摆设 —— 直接判红。
  if (labeled.size === 0) {
    return [{ module: '(guard)', reason: `没能从 ${SFC} 抠出 MODULE_LABEL 的键,护栏已失效:常量被改名或改成了非字面量写法` }]
  }

  const issues: PermissionGroupingIssue[] = []
  for (const module of [...new Set(ALL_PERMISSION_DEFS.map((p) => p.module))].sort()) {
    if (!labeled.has(module)) {
      issues.push({ module, reason: `MODULE_LABEL 缺中文名 → 权限抽屉里会显示英文模块码「${module}」` })
    }
    if (!navModules.has(module) && !extra.has(module)) {
      issues.push({
        module,
        reason: '既没有导航页(nav-catalog 里没有 module 指向它),也不在 EXTRA_MODULE_GROUP 里 → 会掉进兜底分组「其他」;给它指一个菜单组',
      })
    }
  }
  return issues
}
