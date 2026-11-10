// core/org/model.ts
// org 模块 7 张表(DATA_MODEL_org §1)。其他模块禁止直接 import 本文件查表——走 core/org/api.ts。
// 状态枚举全部 text + CHECK(见 core/db/status-convention.ts 的理由)。
// 唯一约束用"部分唯一索引(where is_deleted = false)":软删除后工号/手机号/角色码可复用。
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { commonFields } from '../db/common-fields'

// ── tenant 租户(隔离根,只继承 id/created_at/is_deleted/deleted_at)─────────────
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    // 新建/导入员工时的默认登录密码(明文,需在建员工页展示给管理员)。管理员可在建员工页修改,
    // 修改后后续新建/导入的员工都用这个。仅 org:manage 可读写。
    defaultEmployeePassword: text('default_employee_password').notNull().default('changeMe@6am'),
    // ★租户主(老板),其权限短路所有 data_scope 检查。
    // 与 employee 互为鸡蛋(employee.tenant_id ↔ tenant.owner_employee_id),有意不建库层 FK,靠不变量测试兜底。
    ownerEmployeeId: uuid('owner_employee_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [check('tenants_status_check', sql`${t.status} in ('active', 'suspended')`)],
)

// ── department 部门(组织树:parent_id + path 双字段,拷贝自 core/db tree-template)──
export const departments = pgTable(
  'departments',
  {
    ...commonFields,
    parentId: uuid('parent_id').references((): AnyPgColumn => departments.id), // 根部门 null
    path: text('path').notNull(), // /rootId/.../selfId/ 子树查询用
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    status: text('status').notNull().default('active'),
    // ★财务独立核算:勾选的部门 = 一套独立的账(accounting entity),供 finance 按 entity 隔离 + 标题栏切换。
    // 根部门恒为 true;嵌套约束(非根独立核算节点的子树内不得再有独立核算节点)在 logic 层兜底。
    isAccountingEntity: boolean('is_accounting_entity').notNull().default(false),
    // ★部门负责人(可空):该部门的在职员工之一。设定后本部门其余成员的汇报线(leader)默认指向 ta。
    // 不建库层 FK(避免删员工/跨表锁),负责人在职性/归属由 logic 兜底;成员汇报线仍存 employees.leader_id。
    headEmployeeId: uuid('head_employee_id'),
  },
  (t) => [
    index('departments_tenant_parent_idx').on(t.tenantId, t.parentId),
    // ★LIKE 前缀查询必须 pattern_ops,否则非 C collation 下全表扫
    index('departments_tenant_path_idx').using('btree', t.tenantId, t.path.op('text_pattern_ops')),
    check('departments_status_check', sql`${t.status} in ('active', 'disabled')`),
  ],
)

// ── employee 员工(单层身份:登录字段内联,不拆 User/Person —— 决策2)────────────
export const employees = pgTable(
  'employees',
  {
    ...commonFields,
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    leaderId: uuid('leader_id').references((): AnyPgColumn => employees.id), // 汇报线 ≠ 部门链
    name: text('name').notNull(),
    empNo: text('emp_no').notNull(),
    phone: text('phone').notNull(), // = 登录名,租户内唯一
    position: text('position').notNull().default(''), // 岗位名称;不等同 hr-core 的职位等级/任职历史
    passwordHash: text('password_hash'), // bcrypt;null = 未开通登录 ★禁明文
    email: text('email'),
    status: text('status').notNull().default('active'), // active / left(离职不删除)
    // ★头像:员工**自己**上传(个人设置页),NULL = 没设过。
    //   NULL 就老老实实显示姓名首字 —— 别再按 id 从数字人图库里挑一张顶上,那批 3D 头像是
    //   「数字员工」的资产(见 src/avatars.ts),套在真人身上等于系统替每个人认领了一张脸。
    //   值是 core/storage 的私有标记 `storage:private/<key>`(员工照片是 PII,不走公开直链);
    //   出站由 core/http/private-files.ts 统一换成带票据的 /api/files 地址。
    avatarUrl: text('avatar_url'),
    // ★会话吊销水位:签发时刻早于它的登录令牌一律拒绝(见 core/auth/token-revocation.ts)。
    //   改密码 / 疑似被盗 / 「退出所有设备」都写这里 —— 一次作废该员工全部令牌。
    //   放在本表是有意的:ctxFromToken 本来就要查这一行复核在职状态,多带一列 = 零额外查询。
    //   NULL = 从未吊销过(存量行语义不变)。
    sessionsRevokedAt: timestamp('sessions_revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('employees_tenant_emp_no_uq').on(t.tenantId, t.empNo).where(sql`is_deleted = false`),
    uniqueIndex('employees_tenant_phone_uq').on(t.tenantId, t.phone).where(sql`is_deleted = false`),
    index('employees_tenant_dept_idx').on(t.tenantId, t.departmentId),
    index('employees_tenant_leader_idx').on(t.tenantId, t.leaderId),
    check('employees_status_check', sql`${t.status} in ('active', 'left')`),
  ],
)

// ── role 角色(功能权限集合,租户内自定义)───────────────────────────────────
export const roles = pgTable(
  'roles',
  {
    ...commonFields,
    name: text('name').notNull(),
    code: text('code').notNull(), // 'superadmin' 为内置超管,短路数据权限
    isBuiltin: boolean('is_builtin').notNull().default(false), // 内置角色不可删
  },
  (t) => [uniqueIndex('roles_tenant_code_uq').on(t.tenantId, t.code).where(sql`is_deleted = false`)],
)

// ── permission 权限点(系统预定义,代码即清单,不随租户变,无公共字段)──────────
export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(), // '模块:操作',如 partner:view
    name: text('name').notNull(),
    module: text('module').notNull(),
    type: text('type').notNull(), // menu 控前端菜单显隐 / action 控后端接口
  },
  (t) => [check('permissions_type_check', sql`${t.type} in ('menu', 'action')`)],
)

// ── employee_role 员工-角色(纯关联表;撤销授权 = 物理删行,留痕归 OperationLog)──
// 偏离文档说明:加 tenant_id 列,让"每查询强制带 tenant_id"红线能直接落在关联表上。
export const employeeRoles = pgTable(
  'employee_roles',
  {
    tenantId: uuid('tenant_id').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
  },
  (t) => [primaryKey({ columns: [t.employeeId, t.roleId] }), index('employee_roles_role_idx').on(t.roleId)],
)

// ── role_permission 角色-权限(★承载 data_scope,功能权限×数据权限的结合点)─────
export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id),
    dataScope: varchar('data_scope', { length: 16 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    check('role_permissions_scope_check', sql`${t.dataScope} in ('ALL', 'DEPT_AND_SUB', 'DEPT', 'SELF', 'CUSTOM')`),
  ],
)

export type Tenant = typeof tenants.$inferSelect
export type Department = typeof departments.$inferSelect
export type Employee = typeof employees.$inferSelect
export type Role = typeof roles.$inferSelect
export type Permission = typeof permissions.$inferSelect
