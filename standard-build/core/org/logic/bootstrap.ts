// core/org/logic/bootstrap.ts
// 租户引导:一个事务建 租户 + 根部门 + 老板员工 + 内置超管角色,回填 owner_employee_id。
// 解"created_by 鸡蛋问题":引导期所有行的 created_by = 老板自己的 id(事务内先生成 id 再插入),
// 不给 null 开特例,SELF 数据范围语义完整。
import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/client'
import { buildPath } from './department-tree'
import { hashPassword } from './employee'
import { SUPERADMIN_ROLE_CODE } from './role'
import { departments, employeeRoles, employees, roles, tenants, type Department, type Employee, type Tenant } from '../model'

export async function bootstrapTenant(
  db: Db,
  input: {
    tenantName: string
    rootDeptName?: string
    owner: { name: string; empNo: string; phone: string; password?: string; email?: string }
  },
): Promise<{ tenant: Tenant; rootDept: Department; owner: Employee }> {
  const tenantId = randomUUID()
  const rootDeptId = randomUUID()
  const ownerId = randomUUID()
  const roleId = randomUUID()
  const passwordHash = input.owner.password ? await hashPassword(input.owner.password) : null

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({ id: tenantId, name: input.tenantName, ownerEmployeeId: ownerId })
      .returning()
    const [rootDept] = await tx
      .insert(departments)
      .values({
        id: rootDeptId,
        tenantId,
        createdBy: ownerId,
        updatedBy: ownerId,
        parentId: null,
        path: buildPath(null, rootDeptId),
        name: input.rootDeptName ?? input.tenantName,
        isAccountingEntity: true, // 根部门恒为默认账套(财务独立核算)
      })
      .returning()
    const [owner] = await tx
      .insert(employees)
      .values({
        id: ownerId,
        tenantId,
        createdBy: ownerId, // 自指:引导期没有"别人"
        updatedBy: ownerId,
        departmentId: rootDeptId,
        name: input.owner.name,
        empNo: input.owner.empNo,
        phone: input.owner.phone,
        passwordHash,
        email: input.owner.email ?? null,
      })
      .returning()
    await tx.insert(roles).values({
      id: roleId,
      tenantId,
      createdBy: ownerId,
      updatedBy: ownerId,
      name: '超级管理员',
      code: SUPERADMIN_ROLE_CODE,
      isBuiltin: true,
    })
    await tx.insert(employeeRoles).values({ tenantId, employeeId: ownerId, roleId })
    return { tenant: tenant!, rootDept: rootDept!, owner: owner! }
  })
}
