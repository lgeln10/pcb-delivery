// core/db/status-convention.ts
// 状态字段统一约定(DATA_MODEL.md §3):四模块状态枚举统一风格,降低 AI 跨模块改动的认知负担。
// 规则:
// - 命名一律小写下划线
// - 语义一致:所有"作废"都叫 void,不混用 cancel/invalid
// - 表里用 text + CHECK 约束(不用 pg 原生 enum:ALTER TYPE 摩擦大,CHECK 改一行迁移即可)
// 模块定义自己的状态列时,从这里取常量,保证库层 CHECK 与 TS 类型同源。

/** 实体启用态(组织、科目、角色等"是否启用") */
export const ENTITY_STATUS = ['active', 'disabled'] as const
export type EntityStatus = (typeof ENTITY_STATUS)[number]

/** 单据生命周期态 */
export const LIFECYCLE_STATUS = ['draft', 'submitted', 'approved', 'done', 'void'] as const
export type LifecycleStatus = (typeof LIFECYCLE_STATUS)[number]

/** 人员态 */
export const EMPLOYEE_STATUS = ['active', 'left'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[number]

/** 租户态 */
export const TENANT_STATUS = ['active', 'suspended'] as const
export type TenantStatus = (typeof TENANT_STATUS)[number]

/** 生成 CHECK 约束用的 SQL 字面量列表,如 `'active', 'disabled'` */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}
