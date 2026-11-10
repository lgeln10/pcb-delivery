// 数据权限测试(DATA_MODEL_org §1 RolePermission 节的两条★规则 + 解析行为)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createDepartment } from '../logic/department-tree'
import { createEmployee } from '../logic/employee'
import { assignRoles, createRole, grantPermission } from '../logic/role'
import { getDataScope, hasPermission, listEmployeeIdsWithPermission } from '../api'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ownerCtx: Ctx
let tenantId: string
let rootDeptId: string
let salesDeptId: string // 销售部(root 之下)
let eastDeptId: string //  └ 华东组

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ownerCtx = seeded.ownerCtx
  tenantId = seeded.tenant.id
  rootDeptId = seeded.rootDept.id
  const sales = await createDepartment(t.db, ownerCtx, { name: '销售部', parentId: rootDeptId })
  salesDeptId = sales.id
  const east = await createDepartment(t.db, ownerCtx, { name: '华东组', parentId: salesDeptId })
  eastDeptId = east.id
})
afterAll(async () => t.close())

let seq = 100
async function newEmployeeInDept(deptId: string) {
  seq += 1
  return createEmployee(t.db, ownerCtx, {
    name: `测试员${seq}`,
    empNo: `DS${seq}`,
    phone: `137${String(seq).padStart(8, '0')}`,
    departmentId: deptId,
  })
}

describe('getDataScope / hasPermission', () => {
  it('★多角色取最宽:SELF + DEPT → DEPT', async () => {
    const emp = await newEmployeeInDept(salesDeptId)
    const roleSales = await createRole(t.db, ownerCtx, { name: '销售', code: `sales-${seq}` })
    const roleLead = await createRole(t.db, ownerCtx, { name: '主管', code: `lead-${seq}` })
    await grantPermission(t.db, ownerCtx, roleSales.id, 'partner:view', 'SELF')
    await grantPermission(t.db, ownerCtx, roleLead.id, 'partner:view', 'DEPT')
    await assignRoles(t.db, ownerCtx, emp.id, [roleSales.id, roleLead.id])

    const scope = await getDataScope(t.db, tenantId, emp.id, 'partner:view')
    expect(scope).toEqual({ kind: 'DEPT', departmentIds: [salesDeptId] })
  })

  it('★超管短路:owner 对任意权限恒 ALL(即使无任何授权)', async () => {
    const scope = await getDataScope(t.db, tenantId, ownerCtx.employeeId, 'finance:view')
    expect(scope).toEqual({ kind: 'ALL' })
    expect(await hasPermission(t.db, tenantId, ownerCtx.employeeId, 'finance:view')).toBe(true)
  })

  it('DEPT_AND_SUB 解析为本部门+子部门 id 列表(用 path 展开)', async () => {
    const emp = await newEmployeeInDept(salesDeptId)
    const role = await createRole(t.db, ownerCtx, { name: '区域经理', code: `rm-${seq}` })
    await grantPermission(t.db, ownerCtx, role.id, 'partner:view', 'DEPT_AND_SUB')
    await assignRoles(t.db, ownerCtx, emp.id, [role.id])

    const scope = await getDataScope(t.db, tenantId, emp.id, 'partner:view')
    expect(scope.kind).toBe('DEPT_AND_SUB')
    if (scope.kind === 'DEPT_AND_SUB') {
      expect(new Set(scope.departmentIds)).toEqual(new Set([salesDeptId, eastDeptId]))
    }
  })

  it('SELF 返回员工 id,调用方按 created_by 过滤', async () => {
    const emp = await newEmployeeInDept(eastDeptId)
    const role = await createRole(t.db, ownerCtx, { name: '专员', code: `staff-${seq}` })
    await grantPermission(t.db, ownerCtx, role.id, 'partner:view', 'SELF')
    await assignRoles(t.db, ownerCtx, emp.id, [role.id])

    expect(await getDataScope(t.db, tenantId, emp.id, 'partner:view')).toEqual({
      kind: 'SELF',
      employeeId: emp.id,
    })
  })

  it('无授权 → NONE / hasPermission false(默认拒绝)', async () => {
    const emp = await newEmployeeInDept(eastDeptId)
    expect(await getDataScope(t.db, tenantId, emp.id, 'partner:view')).toEqual({ kind: 'NONE' })
    expect(await hasPermission(t.db, tenantId, emp.id, 'partner:view')).toBe(false)
  })

  it('对未授权的另一权限码互不串扰(功能权限与数据权限正交)', async () => {
    const emp = await newEmployeeInDept(salesDeptId)
    const role = await createRole(t.db, ownerCtx, { name: '只看伙伴', code: `pv-${seq}` })
    await grantPermission(t.db, ownerCtx, role.id, 'partner:view', 'ALL')
    await assignRoles(t.db, ownerCtx, emp.id, [role.id])
    expect((await getDataScope(t.db, tenantId, emp.id, 'partner:view')).kind).toBe('ALL')
    expect((await getDataScope(t.db, tenantId, emp.id, 'finance:view')).kind).toBe('NONE')
  })
})

describe('listEmployeeIdsWithPermission —— 群发/告警挑收件人', () => {
  // ★存在的理由:原先各处是「查全部员工 + 逐个 hasPermission」,那是 N+1;
  //   这几条钉住的是它与 hasPermission **口径一致**,不是顺手写的另一套判定。
  it('持有该权限的人在里面,没有的不在', async () => {
    const yes = await newEmployeeInDept(salesDeptId)
    const no = await newEmployeeInDept(salesDeptId)
    const role = await createRole(t.db, ownerCtx, { name: '财务', code: `fin-${seq}` })
    await grantPermission(t.db, ownerCtx, role.id, 'finance:view', 'ALL')
    await assignRoles(t.db, ownerCtx, yes.id, [role.id])

    const ids = await listEmployeeIdsWithPermission(t.db, tenantId, 'finance:view')
    expect(ids).toContain(yes.id)
    expect(ids).not.toContain(no.id)
  })

  it('★租户主恒在里面(即使一条授权都没有)—— 与 hasPermission 的超管短路同口径', async () => {
    const ids = await listEmployeeIdsWithPermission(t.db, tenantId, 'partner:edit')
    expect(ids).toContain(ownerCtx.employeeId)
    expect(await hasPermission(t.db, tenantId, ownerCtx.employeeId, 'partner:edit')).toBe(true)
  })

  it('★不重复:一个人靠两个角色都拿到同一权限,只出现一次', async () => {
    const emp = await newEmployeeInDept(eastDeptId)
    const r1 = await createRole(t.db, ownerCtx, { name: '甲', code: `dup-a-${seq}` })
    const r2 = await createRole(t.db, ownerCtx, { name: '乙', code: `dup-b-${seq}` })
    await grantPermission(t.db, ownerCtx, r1.id, 'partner:view', 'SELF')
    await grantPermission(t.db, ownerCtx, r2.id, 'partner:view', 'DEPT')
    await assignRoles(t.db, ownerCtx, emp.id, [r1.id, r2.id])

    const ids = await listEmployeeIdsWithPermission(t.db, tenantId, 'partner:view')
    expect(ids.filter((id) => id === emp.id)).toHaveLength(1)
  })

  it('★结果与逐人 hasPermission 一致 —— 这是它能替换掉那个 N+1 循环的唯一依据', async () => {
    const ids = new Set(await listEmployeeIdsWithPermission(t.db, tenantId, 'finance:view'))
    const emp = await newEmployeeInDept(salesDeptId)
    for (const id of [emp.id, ownerCtx.employeeId]) {
      expect(ids.has(id)).toBe(await hasPermission(t.db, tenantId, id, 'finance:view'))
    }
  })
})
