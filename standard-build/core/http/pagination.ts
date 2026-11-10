// core/http/pagination.ts
// ★列表分页的唯一约定点。此前 LIST_DEFAULT_LIMIT / LIST_MAX_LIMIT 在 10 个模块里各写一份
// (取值已经出现 20/50、50/200、20/50 三组),没有任何机制保证它们继续一致。
//
// 【为什么只夹不报错】现有行为是「传超了就夹到上限」,前端有多处按各自上限传值
// (如 inventory 传 200、finance 收入确认传 100)。改成 zod `.max()` 会把夹取变成 400,
// 属于破坏性变更,已交付客户的前端会挂 —— 所以这里保持夹取语义。
//
// 【上限不是全局统一的】默认 50 是通用约定;确有理由要更大的模块显式传 max
// (inventory=200 与其前端一致),不要为了"统一"把它们压回 50。

import { z } from 'zod'

/** 未传 limit 时的默认条数 */
export const LIST_DEFAULT_LIMIT = 20
/** 通用上限。传更大的值会被夹到这里,不报错。 */
export const LIST_MAX_LIMIT = 50

/**
 * 夹取列表 limit:未传取 `def`,超过 `max` 夹到 `max`,非正数取 `def`。
 * @param max 该接口的上限,默认 {@link LIST_MAX_LIMIT}
 * @param def 该接口的默认值,默认 {@link LIST_DEFAULT_LIMIT}
 */
export function clampLimit(
  limit: number | undefined,
  max: number = LIST_MAX_LIMIT,
  def: number = LIST_DEFAULT_LIMIT,
): number {
  const n = Number.isFinite(limit) && (limit as number) > 0 ? (limit as number) : def
  return Math.min(n, max)
}

/** 夹取 offset:未传或为负都取 0。 */
export function clampOffset(offset: number | undefined): number {
  return Number.isFinite(offset) && (offset as number) > 0 ? Math.floor(offset as number) : 0
}

/**
 * 列表 `limit` 的 zod 字段:**把上限写进契约**,而不是让 schema 声称收任意正整数、
 * 再由逻辑层悄悄夹掉(那样读 routes.ts 的人根本看不出上限是多少)。
 *
 * 语义仍是**夹取**不是拒绝 —— 用 `.max()` 会把超限从「返回上限条」变成 400,
 * 属破坏性变更(前端有多处按各自上限传值)。
 *
 * @example limit: limitField()          // 默认 20,上限 50
 * @example limit: limitField(200, 50)   // inventory:默认 50,上限 200
 */
export const limitField = (max: number = LIST_MAX_LIMIT, def: number = LIST_DEFAULT_LIMIT) =>
  z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .transform((v) => clampLimit(v, max, def))

/** 列表 `offset` 的 zod 字段:非负整数,未传即 0。 */
export const offsetField = () =>
  z.coerce.number().int().nonnegative().optional().transform((v) => clampOffset(v))
