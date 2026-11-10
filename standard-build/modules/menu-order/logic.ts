// modules/menu-order/logic.ts
// 读 / upsert 菜单顺序。每租户一行,整份覆盖保存。
//
// ★后端只兜「结构 / 格式 / 规模」底线,**不校验 key 是否真实存在于当前菜单目录**:
//   目录随功能开关、权限、license 动态增删,校验会让「目录改了、旧顺序里残留已删 key」
//   整份保存失败 —— 用户什么都没做错,却被一条他看不懂的错误挡住。
//   未知 key 由前端渲染时忽略(见 App.vue 的 orderBy),那才是该处理它的地方。
import { randomUUID } from 'node:crypto'
import type { Ctx, Db } from '../../core/db/client'
import { auditedUpdate, scope } from '../../core/db/soft-delete'
import { MenuOrderError } from './errors'
import { menuOrders, type MenuOrderRow } from './model'

/** 菜单 key 的形状。与 nav-catalog 的 key 一致(`[\w-]+`),放宽到含 `:` 以便将来复用。 */
const KEY_RE = /^[\w:-]+$/
/** 规模底线:一级菜单与任一分组下的二级菜单都不该有几百条。防的是滥用不是正常用法。 */
const MAX_KEYS = 200
/** 分组数上限(item_order 的键)。 */
const MAX_GROUPS = 100

export type MenuOrder = { groups: string[]; items: Record<string, string[]> }

/** 同层去重**保序**:重复 key 取首次出现的位置。 */
function dedupe(keys: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of keys) {
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

function assertKeyList(list: unknown, where: string): string[] {
  if (!Array.isArray(list)) throw new MenuOrderError('INVALID_INPUT', `${where} 必须是数组`)
  if (list.length > MAX_KEYS) throw new MenuOrderError('INVALID_INPUT', `${where} 条数超过上限 ${MAX_KEYS}`)
  for (const k of list) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) {
      throw new MenuOrderError('INVALID_INPUT', `${where} 含非法菜单标识:${String(k)}`)
    }
  }
  return dedupe(list as string[])
}

/** 规范化 + 校验。返回真正会落库的那份(已去重),供保存后直接回给前端。 */
export function normalizeMenuOrder(input: MenuOrder): MenuOrder {
  const groups = assertKeyList(input?.groups, 'groups')
  const rawItems = input?.items
  if (rawItems === null || typeof rawItems !== 'object' || Array.isArray(rawItems)) {
    throw new MenuOrderError('INVALID_INPUT', 'items 必须是「分组 key → 菜单 key 数组」的对象')
  }
  const entries = Object.entries(rawItems)
  if (entries.length > MAX_GROUPS) throw new MenuOrderError('INVALID_INPUT', `items 的分组数超过上限 ${MAX_GROUPS}`)
  const items: Record<string, string[]> = {}
  for (const [groupKey, list] of entries) {
    if (!KEY_RE.test(groupKey)) throw new MenuOrderError('INVALID_INPUT', `items 含非法分组标识:${groupKey}`)
    items[groupKey] = assertKeyList(list, `items.${groupKey}`)
  }
  return { groups, items }
}

/** 本租户的菜单顺序。**没有行 = 从没配过 → 返回空顺序**,前端按 nav-catalog 原序渲染。 */
export async function getMenuOrder(db: Db, ctx: Ctx): Promise<MenuOrder> {
  const row = (
    await db.select().from(menuOrders).where(scope(menuOrders, ctx.tenantId)).limit(1)
  )[0] as MenuOrderRow | undefined
  if (!row) return { groups: [], items: {} }
  return { groups: row.groupOrder ?? [], items: row.itemOrder ?? {} }
}

/** 整份覆盖保存(upsert,每租户一行)。返回落库后的那份(已去重)。 */
export async function saveMenuOrder(db: Db, ctx: Ctx, input: MenuOrder): Promise<MenuOrder> {
  const next = normalizeMenuOrder(input)
  const existing = (
    await db.select().from(menuOrders).where(scope(menuOrders, ctx.tenantId)).limit(1)
  )[0] as MenuOrderRow | undefined
  if (existing) {
    await auditedUpdate(db, menuOrders, ctx.tenantId, existing.id, ctx.employeeId, {
      groupOrder: next.groups,
      itemOrder: next.items,
    })
    return next
  }
  await db.insert(menuOrders).values({
    id: randomUUID(),
    tenantId: ctx.tenantId,
    createdBy: ctx.employeeId,
    updatedBy: ctx.employeeId,
    groupOrder: next.groups,
    itemOrder: next.items,
  })
  return next
}

/** 仅供不变量测试:确认每租户最多一行(upsert 没退化成每次插一条)。 */
export async function _countRowsForTest(db: Db, ctx: Ctx): Promise<number> {
  const rows = await db.select({ id: menuOrders.id }).from(menuOrders).where(scope(menuOrders, ctx.tenantId))
  return rows.length
}
