// 不变量:内置「超级管理员」角色只能由超管本人授出。
//
// 起因(2026-08-27 权限梳理):PUT /api/org/employees/:id/roles 的闸是 org:manage,
// 而超管角色**短路**数据范围与权限判定(core/org/logic/data-scope.ts:46/105 —— 持有它
// listMyPermissionCodes 直接返回 null,等于全部业务权限)。于是一个只被授了「管理组织/员工/角色」
// 的人事管理员可以把超管发给自己,一步拿到财务、薪酬和审计;而这一步是合法调用,
// 事后翻审计日志只看到一次正常的角色分配,看不出这是提权。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createEmployee } from '../logic/employee'
import { assignRoles, createRole, SUPERADMIN_ROLE_CODE } from '../logic/role'
import { OrgError } from '../logic/errors'
import { roles } from '../model'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ownerCtx: Ctx
let rootDeptId: string
let superRoleId: string

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ownerCtx = seeded.ownerCtx
  rootDeptId = seeded.rootDept.id
  const rows = await t.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.tenantId, ownerCtx.tenantId), eq(roles.code, SUPERADMIN_ROLE_CODE)))
  superRoleId = rows[0]!.id
})
afterAll(async () => t.close())

describe('超管角色的授出边界', () => {
  it('非超管(哪怕有 org:manage)不能把超管角色发给任何人 —— 包括自己', async () => {
    const hr = await createEmployee(t.db, ownerCtx, {
      name: '人事管理员',
      empNo: 'SA-HR-1',
      phone: '13611110001',
      departmentId: rootDeptId,
    })
    // 这个 ctx 代表「持 org:manage 的普通管理员」:能调这个口,但自己不是超管
    const hrCtx: Ctx = { ...ownerCtx, employeeId: hr.id }
    await expect(assignRoles(t.db, hrCtx, hr.id, [superRoleId])).rejects.toMatchObject({
      code: 'SUPERADMIN_GRANT_FORBIDDEN',
    })
    await expect(assignRoles(t.db, hrCtx, hr.id, [superRoleId])).rejects.toBeInstanceOf(OrgError)
  })

  it('超管本人可以再立一个超管 —— 这条路不该被堵死', async () => {
    const deputy = await createEmployee(t.db, ownerCtx, {
      name: '副总',
      empNo: 'SA-DEP-1',
      phone: '13611110002',
      departmentId: rootDeptId,
    })
    await assignRoles(t.db, ownerCtx, deputy.id, [superRoleId])
    // 拿到超管之后,他自己也能继续授
    const third = await createEmployee(t.db, ownerCtx, {
      name: '第三人',
      empNo: 'SA-3RD-1',
      phone: '13611110003',
      departmentId: rootDeptId,
    })
    await assignRoles(t.db, { ...ownerCtx, employeeId: deputy.id }, third.id, [superRoleId])
  })

  it('普通角色不受影响:非超管照旧可以分配', async () => {
    const emp = await createEmployee(t.db, ownerCtx, {
      name: '普通员工',
      empNo: 'SA-EMP-1',
      phone: '13611110004',
      departmentId: rootDeptId,
    })
    const role = await createRole(t.db, ownerCtx, { name: '销售', code: 'sa-sales' })
    await assignRoles(t.db, { ...ownerCtx, employeeId: emp.id }, emp.id, [role.id])
  })
})
