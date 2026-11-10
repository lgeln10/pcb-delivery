// core/org/logic/data-scope.ts
// ★数据权限核心:getDataScope / hasPermission。
// 灵魂规则(DATA_MODEL_org §1):
// - 功能权限(能不能做)与数据权限(能看到谁的)正交,scope 挂在 role_permission 上
// - 多角色冲突取最宽:ALL > DEPT_AND_SUB > DEPT > SELF(并集语义:拥有越多看得越多)
// - 超管短路:tenant.owner_employee_id 本人、或持内置 superadmin 角色 → 恒 ALL
// - 返回"已解析"的最终结果(DEPT 类已展开成部门 id 列表),业务模块拿到直接拼 WHERE
import { and, eq, or } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { scope } from '../../db/soft-delete'
import { employeeRoles, employees, permissions, rolePermissions, roles, tenants } from '../model'
import { getDeptSubtreeIds } from './department-tree'
import { OrgError } from './errors'

export const DATA_SCOPES = ['ALL', 'DEPT_AND_SUB', 'DEPT', 'SELF', 'CUSTOM'] as const
export type DataScope = (typeof DATA_SCOPES)[number]

// CUSTOM 预留未实现(决策3),不参与宽度比较
const SCOPE_WIDTH: Record<string, number> = { ALL: 4, DEPT_AND_SUB: 3, DEPT: 2, SELF: 1 }

export type DataScopeResult =
  | { kind: 'ALL' }
  | { kind: 'DEPT_AND_SUB'; departmentIds: string[] } // 已展开:本部门及子部门 id
  | { kind: 'DEPT'; departmentIds: string[] }
  | { kind: 'SELF'; employeeId: string } // 调用方按 created_by = employeeId 过滤
  | { kind: 'NONE' } // 无该权限,调用方应拒绝访问

/** 超管判定:租户主 or 持内置 superadmin 角色 */
async function isSuperAdmin(db: Db, tenantId: string, empId: string): Promise<boolean> {
  const t = await db
    .select({ owner: tenants.ownerEmployeeId })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.isDeleted, false)))
    .limit(1)
  if (t[0]?.owner === empId) return true
  const admin = await db
    .select({ roleId: roles.id })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(
      and(
        eq(employeeRoles.tenantId, tenantId),
        eq(employeeRoles.employeeId, empId),
        scope(roles, tenantId),
        eq(roles.isBuiltin, true),
        eq(roles.code, 'superadmin'),
      ),
    )
    .limit(1)
  return admin.length > 0
}

/** 员工对某权限码的全部授权 scope(一条 JOIN,无 N+1) */
async function grantedScopes(db: Db, tenantId: string, empId: string, permCode: string): Promise<string[]> {
  const rows = await db
    .select({ dataScope: rolePermissions.dataScope })
    .from(employeeRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(
      and(
        eq(employeeRoles.tenantId, tenantId),
        eq(employeeRoles.employeeId, empId),
        eq(permissions.code, permCode),
        scope(roles, tenantId), // 已删角色的授权不生效
      ),
    )
  return rows.map((r) => r.dataScope)
}

export async function hasPermission(db: Db, tenantId: string, empId: string, permCode: string): Promise<boolean> {
  if (await isSuperAdmin(db, tenantId, empId)) return true
  return (await grantedScopes(db, tenantId, empId, permCode)).length > 0
}

/**
 * 某租户里持有某功能权限的**全部**员工 id —— 含超管(租户主 + 持内置 superadmin 角色)。
 *
 * ★存在的理由:告警/群发这类「谁该收到」的场景,原先写法是把员工全查出来再逐个
 *   `hasPermission` —— 那是 N+1(员工上百就是上百次查询),而且每次失败都得在循环里
 *   自己吞掉,于是「系统性算错收件人」这件事一点痕迹都不会留下。
 * ★与 `hasPermission` 的两处**有意**的不同,别当成 bug 去「修」:
 *   - **排除软删员工**(hasPermission 不看这一列)—— 给已删的人发通知没有意义;
 *   - **不排 `status='left'`** —— 离职判定归各调用方,别在这层偷偷加语义。
 */
export async function listEmployeeIdsWithPermission(db: Db, tenantId: string, permCode: string): Promise<string[]> {
  const t = await db
    .select({ owner: tenants.ownerEmployeeId })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.isDeleted, false)))
    .limit(1)
  const rows = await db
    .select({ employeeId: employeeRoles.employeeId })
    .from(employeeRoles)
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .innerJoin(employees, eq(employees.id, employeeRoles.employeeId))
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(employeeRoles.tenantId, tenantId),
        scope(roles, tenantId), // 已删角色的授权不生效(与 grantedScopes 同口径)
        scope(employees, tenantId), // 软删的人不进收件人(与 hasPermission 的差异见上)
        or(and(eq(roles.isBuiltin, true), eq(roles.code, 'superadmin')), eq(permissions.code, permCode)),
      ),
    )
  const ids = new Set(rows.map((r) => r.employeeId))
  const owner = t[0]?.owner
  if (owner) ids.add(owner) // 租户主恒超管(与 isSuperAdmin 同口径)
  return [...ids]
}

/**
 * 返回当前员工实际拥有的全部权限码。
 * 超管返回 null(前端收到 null 视为拥有一切权限)。
 */
export async function listMyPermissionCodes(db: Db, tenantId: string, empId: string): Promise<string[] | null> {
  if (await isSuperAdmin(db, tenantId, empId)) return null
  const rows = await db
    .select({ code: permissions.code })
    .from(employeeRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .innerJoin(roles, eq(roles.id, employeeRoles.roleId))
    .where(and(eq(employeeRoles.tenantId, tenantId), eq(employeeRoles.employeeId, empId), scope(roles, tenantId)))
  return [...new Set(rows.map((r) => r.code))]
}

/**
 * ★所有业务模块数据过滤的唯一入口。内部已处理多角色取最宽 + 超管短路,
 * 调用方拿到的是最终结果,不需要自己懂权限。
 */
export async function getDataScope(
  db: Db,
  tenantId: string,
  empId: string,
  permCode: string,
): Promise<DataScopeResult> {
  if (await isSuperAdmin(db, tenantId, empId)) return { kind: 'ALL' }

  const scopes = await grantedScopes(db, tenantId, empId, permCode)
  // CUSTOM 预留未实现:跳过,不参与取最宽(只持 CUSTOM 等于未授权)
  const comparable = scopes.filter((s) => SCOPE_WIDTH[s] !== undefined)
  if (comparable.length === 0) return { kind: 'NONE' }

  const widest = comparable.reduce((a, b) => (SCOPE_WIDTH[a]! >= SCOPE_WIDTH[b]! ? a : b))
  if (widest === 'ALL') return { kind: 'ALL' }
  if (widest === 'SELF') return { kind: 'SELF', employeeId: empId }

  // DEPT / DEPT_AND_SUB:解析员工所在部门
  const emp = await db
    .select({ departmentId: employees.departmentId })
    .from(employees)
    .where(and(scope(employees, tenantId), eq(employees.id, empId)))
    .limit(1)
  if (!emp[0]) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)
  if (!emp[0].departmentId) return { kind: 'NONE' }
  if (widest === 'DEPT') return { kind: 'DEPT', departmentIds: [emp[0].departmentId] }
  return { kind: 'DEPT_AND_SUB', departmentIds: await getDeptSubtreeIds(db, tenantId, emp[0].departmentId) }
}
