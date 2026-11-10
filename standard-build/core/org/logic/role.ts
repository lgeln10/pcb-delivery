// core/org/logic/role.ts
// 角色与授权。写操作全部幂等(ON CONFLICT):assignRoles 重复执行不重复插入,
// grantPermission 重复执行更新 data_scope 不产生重复行。
// 关联表(employee_roles/role_permissions)是授权状态,撤销 = 物理删行;操作留痕归 document 模块 OperationLog。
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../../db/client'
import { scope, softDelete } from '../../db/soft-delete'
import { employeeRoles, permissions, rolePermissions, roles, type Role } from '../model'
import { OrgError } from './errors'
import { DATA_SCOPES, type DataScope } from './data-scope'

export const SUPERADMIN_ROLE_CODE = 'superadmin'

export async function createRole(
  db: Db,
  ctx: Ctx,
  input: { name: string; code: string; isBuiltin?: boolean },
): Promise<Role> {
  const rows = await db
    .insert(roles)
    .values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      name: input.name,
      code: input.code,
      isBuiltin: input.isBuiltin ?? false,
    })
    .returning()
  return rows[0]!
}

async function getRole(db: Db, tenantId: string, roleId: string): Promise<Role | null> {
  const rows = await db
    .select()
    .from(roles)
    .where(and(scope(roles, tenantId), eq(roles.id, roleId)))
    .limit(1)
  return rows[0] ?? null
}

export async function softDeleteRole(db: Db, ctx: Ctx, roleId: string): Promise<void> {
  const role = await getRole(db, ctx.tenantId, roleId)
  if (!role) throw new OrgError('NOT_FOUND', `role ${roleId} not found`)
  if (role.isBuiltin) throw new OrgError('BUILTIN_ROLE_PROTECTED', 'builtin role cannot be deleted')
  await softDelete(db, roles, ctx.tenantId, roleId, ctx.employeeId)
}

export type RoleSummary = {
  id: string
  name: string
  code: string
  isBuiltin: boolean
  permissionCount: number
  memberCount: number
}

/** 角色列表(含权限点数 + 成员数)。3 条聚合查询合并,不 N+1。 */
export async function listRoles(db: Db, ctx: Ctx): Promise<RoleSummary[]> {
  const rs = await db.select().from(roles).where(scope(roles, ctx.tenantId)).orderBy(asc(roles.code))
  const permCounts = await db
    .select({ roleId: rolePermissions.roleId, n: sql<number>`count(*)::int` })
    .from(rolePermissions)
    .where(eq(rolePermissions.tenantId, ctx.tenantId))
    .groupBy(rolePermissions.roleId)
  const memberCounts = await db
    .select({ roleId: employeeRoles.roleId, n: sql<number>`count(*)::int` })
    .from(employeeRoles)
    .where(eq(employeeRoles.tenantId, ctx.tenantId))
    .groupBy(employeeRoles.roleId)
  const pm = new Map(permCounts.map((r) => [r.roleId, r.n]))
  const mm = new Map(memberCounts.map((r) => [r.roleId, r.n]))
  return rs.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    isBuiltin: r.isBuiltin,
    permissionCount: pm.get(r.id) ?? 0,
    memberCount: mm.get(r.id) ?? 0,
  }))
}

/** 某角色当前已授的权限点 + 数据范围 */
export async function getRolePermissions(
  db: Db,
  ctx: Ctx,
  roleId: string,
): Promise<Array<{ permCode: string; dataScope: string }>> {
  return db
    .select({ permCode: permissions.code, dataScope: rolePermissions.dataScope })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(rolePermissions.tenantId, ctx.tenantId), eq(rolePermissions.roleId, roleId)))
}

/** 权限点目录(代码定义、启动时同步进表),按模块分组用 */
export async function listPermissionCatalog(db: Db): Promise<PermissionDef[]> {
  const rs = await db
    .select({ code: permissions.code, name: permissions.name, module: permissions.module, type: permissions.type })
    .from(permissions)
    .orderBy(asc(permissions.module), asc(permissions.code))
  return rs as PermissionDef[]
}

/** 某员工持有的角色 id 列表(给员工分配角色的回显用) */
export async function getEmployeeRoleIds(db: Db, ctx: Ctx, empId: string): Promise<string[]> {
  const rs = await db
    .select({ roleId: employeeRoles.roleId })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(and(eq(employeeRoles.tenantId, ctx.tenantId), eq(employeeRoles.employeeId, empId), scope(roles, ctx.tenantId)))
  return rs.map((r) => r.roleId)
}

/** 批量取员工角色名称(员工列表展示用,避免前端逐人请求)。 */
export async function listEmployeeRoleNames(
  db: Db,
  ctx: Ctx,
  employeeIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (employeeIds.length === 0) return result
  const rows = await db
    .select({ employeeId: employeeRoles.employeeId, roleName: roles.name })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(and(eq(employeeRoles.tenantId, ctx.tenantId), inArray(employeeRoles.employeeId, employeeIds), scope(roles, ctx.tenantId)))
    .orderBy(asc(roles.code))
  for (const row of rows) {
    const names = result.get(row.employeeId) ?? []
    names.push(row.roleName)
    result.set(row.employeeId, names)
  }
  return result
}

/** 给员工加角色(增量,幂等:已有的关联跳过) */
export async function assignRoles(db: Db, ctx: Ctx, empId: string, roleIds: string[]): Promise<void> {
  if (roleIds.length === 0) return
  const found = await db
    .select({ id: roles.id, code: roles.code, isBuiltin: roles.isBuiltin })
    .from(roles)
    .where(and(scope(roles, ctx.tenantId), inArray(roles.id, roleIds)))
  if (found.length !== new Set(roleIds).size) {
    throw new OrgError('NOT_FOUND', 'some roles not found in this tenant')
  }
  // ★超管角色只能由超管授出。这个口的闸是 org:manage,而内置超管**短路**数据范围与权限判定
  //   (data-scope.ts:46/105:持有它 listMyPermissionCodes 直接返回 null = 全部业务权限)。
  //   不拦的话,一个只被授了「管理组织/员工/角色」的人事管理员可以把超管发给自己,一步拿到
  //   财务、薪酬和审计 —— 而且这一步本身是合法调用,事后翻审计日志也只看到一次正常的角色分配。
  //   老板要再立一个超管照旧可以:他自己就是超管。
  if (found.some((r) => r.isBuiltin && r.code === SUPERADMIN_ROLE_CODE)) {
    if (!(await hasRole(db, ctx.tenantId, ctx.employeeId, SUPERADMIN_ROLE_CODE))) {
      throw new OrgError('SUPERADMIN_GRANT_FORBIDDEN', 'only a superadmin can grant the superadmin role')
    }
  }
  await db
    .insert(employeeRoles)
    .values(roleIds.map((roleId) => ({ tenantId: ctx.tenantId, employeeId: empId, roleId })))
    .onConflictDoNothing()
}

export async function revokeRole(db: Db, ctx: Ctx, empId: string, roleId: string): Promise<void> {
  await db
    .delete(employeeRoles)
    .where(
      and(
        eq(employeeRoles.tenantId, ctx.tenantId),
        eq(employeeRoles.employeeId, empId),
        eq(employeeRoles.roleId, roleId),
      ),
    )
}

// 「回收某员工全部角色」不再单独成函数:离职权限回收在 markEmployeeLeft 事务内完成
// (logic/employee.ts),组织页离职与人事离职单(api.separateEmployee)同口径。

/** 给角色授权限 + 数据范围(幂等 upsert:重复授权更新 scope) */
export async function grantPermission(
  db: Db,
  ctx: Ctx,
  roleId: string,
  permCode: string,
  dataScope: DataScope,
): Promise<void> {
  if (!DATA_SCOPES.includes(dataScope)) throw new OrgError('INVALID_INPUT', `invalid data_scope ${dataScope}`)
  const role = await getRole(db, ctx.tenantId, roleId)
  if (!role) throw new OrgError('NOT_FOUND', `role ${roleId} not found`)
  const perm = await db.select().from(permissions).where(eq(permissions.code, permCode)).limit(1)
  if (!perm[0]) throw new OrgError('PERMISSION_NOT_FOUND', `permission ${permCode} not defined`)
  await db
    .insert(rolePermissions)
    .values({ tenantId: ctx.tenantId, roleId, permissionId: perm[0].id, dataScope })
    .onConflictDoUpdate({
      target: [rolePermissions.roleId, rolePermissions.permissionId],
      set: { dataScope },
    })
}

export async function revokePermission(db: Db, ctx: Ctx, roleId: string, permCode: string): Promise<void> {
  const perm = await db.select().from(permissions).where(eq(permissions.code, permCode)).limit(1)
  if (!perm[0]) return
  await db
    .delete(rolePermissions)
    .where(
      and(
        eq(rolePermissions.tenantId, ctx.tenantId),
        eq(rolePermissions.roleId, roleId),
        eq(rolePermissions.permissionId, perm[0].id),
      ),
    )
}

/** 是否持有某角色(按角色 code;document 审批人资格校验等场景用) */
export async function hasRole(db: Db, tenantId: string, empId: string, roleCode: string): Promise<boolean> {
  const rows = await db
    .select({ roleId: roles.id })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(
      and(
        eq(employeeRoles.tenantId, tenantId),
        eq(employeeRoles.employeeId, empId),
        scope(roles, tenantId),
        eq(roles.code, roleCode),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * ★`type` 只影响角色配置页的**排序**与**默认数据范围**(menu 默认 ALL、action 默认 SELF,
 * 见 core/org/ui/RolePermissions.vue),它**不决定菜单可见性** —— 菜单能不能看,由
 * src/nav-catalog.ts 每个导航项自己的 `permission` 字段说了算。
 * 所以别再按「每个模块配一个 xxx:menu」的老习惯立码:导航实际用的是各自的 `xxx:view`,
 * 那种码从来没人消费,只会在角色页多出一个勾了没效果的选项(2026-08-27 一次清掉了 10 个,
 * 见迁移 0305)。新立 menu 型码的前提是**当场就有导航项或看板卡引用它**(如 news:menu)。
 */
export type PermissionDef = { code: string; name: string; module: string; type: 'menu' | 'action' }

/** 系统启动时幂等同步权限点清单(权限是代码定义的能力清单,新模块加权限 = 加几行 def) */
export async function syncPermissions(db: Db, defs: PermissionDef[]): Promise<void> {
  if (defs.length === 0) return
  await db
    .insert(permissions)
    .values(defs)
    .onConflictDoUpdate({
      target: permissions.code,
      set: {
        name: sql`excluded.name`,
        module: sql`excluded.module`,
        type: sql`excluded.type`,
      },
    })
}
