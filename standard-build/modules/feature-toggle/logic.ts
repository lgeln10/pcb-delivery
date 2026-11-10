// modules/feature-toggle/logic.ts
// 功能开关读写。缺省启用;关闭 = upsert 一行 enabled=false。
// ★防自锁:核心入口(功能开关页所在的系统设置、账号管理、角色权限、系统管理整组)永不可关闭——
//   服务端 setToggle 硬拒,前端 checkbox 也置灰(双保险)。
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../../core/db/client'
import { auditedUpdate, scope } from '../../core/db/soft-delete'
import { FeatureToggleError } from './errors'
import { featureToggles, type FeatureToggle } from './model'

const KEY_RE = /^(group|menu|perm):[\w:.-]+$/

/** 防自锁清单:这些 key 永不可关闭,否则再也进不去功能开关页 / 权限页 / 账号管理。 */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  'group:sys', // 系统管理整组
  'group:manufacturing', // 制造工程整组(本仓只剩 PCB CAM)
  'menu:app-settings', // 系统设置(功能开关页所在)
  'menu:org', // 组织及账号管理
  'menu:roles', // 角色与权限
  'menu:pcb-cam', // 本仓唯一业务入口
  'perm:app-settings:manage',
  'perm:org:view',
  'perm:org:manage',
  'perm:feature-toggle:manage',
  'perm:pcb-cam:menu',
])

export function isProtectedKey(key: string): boolean {
  return PROTECTED_KEYS.has(key)
}

/** 本租户所有被关闭的 feature_key。导航/权限页/按钮据此隐藏(任意登录用户可读)。 */
export async function listDisabledKeys(db: Db, ctx: Ctx): Promise<string[]> {
  const rows = await db
    .select({ featureKey: featureToggles.featureKey })
    .from(featureToggles)
    .where(and(scope(featureToggles, ctx.tenantId), eq(featureToggles.enabled, false)))
  return rows.map((r) => r.featureKey)
}

/** 开/关一个功能(幂等 upsert)。关闭核心入口直接拒。 */
export async function setToggle(db: Db, ctx: Ctx, input: { key: string; enabled: boolean }): Promise<void> {
  if (!KEY_RE.test(input.key)) throw new FeatureToggleError('INVALID_INPUT', `功能标识非法:${input.key}`)
  if (!input.enabled && isProtectedKey(input.key)) {
    throw new FeatureToggleError('PROTECTED_KEY', `「${input.key}」是核心入口,不能关闭(否则会无法再进入设置)`)
  }
  const existing = (
    await db
      .select()
      .from(featureToggles)
      .where(and(scope(featureToggles, ctx.tenantId), eq(featureToggles.featureKey, input.key)))
      .limit(1)
  )[0] as FeatureToggle | undefined
  if (existing) {
    if (existing.enabled === input.enabled) return // 幂等:状态未变
    await auditedUpdate(db, featureToggles, ctx.tenantId, existing.id, ctx.employeeId, { enabled: input.enabled })
    return
  }
  await db.insert(featureToggles).values({
    id: randomUUID(),
    tenantId: ctx.tenantId,
    createdBy: ctx.employeeId,
    updatedBy: ctx.employeeId,
    featureKey: input.key,
    enabled: input.enabled,
  })
}
