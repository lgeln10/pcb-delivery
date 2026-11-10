// 部门负责人:设/清 head + 成员汇报线默认改指负责人 + 防环 + 负责人离职/调离/删除清指针。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createEmployee, deleteEmployee, getEmployee, markEmployeeLeft, setDepartmentHead, setLeader, updateEmployee } from '../logic/employee'
import { createDepartment, getDepartment } from '../logic/department-tree'
import { OrgError } from '../logic/errors'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ownerCtx: Ctx
let rootDeptId: string

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ownerCtx = seeded.ownerCtx
  rootDeptId = seeded.rootDept.id
})
afterAll(async () => t.close())

let seq = 0
async function emp(departmentId: string, opts: { leaderId?: string | null; password?: string } = {}) {
  seq += 1
  return createEmployee(t.db, ownerCtx, {
    name: `员工${seq}`,
    empNo: `E${String(seq).padStart(4, '0')}`,
    phone: `139${String(seq).padStart(8, '0')}`,
    departmentId,
    leaderId: opts.leaderId,
    password: opts.password,
  })
}

describe('设/清部门负责人', () => {
  it('设负责人 → 该部门其余在职成员上级改指负责人;负责人自身上级不指向本部门成员', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '销售部', parentId: rootDeptId })
    const head = await emp(dept.id)
    const a = await emp(dept.id)
    const b = await emp(dept.id, { leaderId: a.id }) // 先随意挂在 a 名下

    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)

    expect((await getDepartment(t.db, ownerCtx.tenantId, dept.id))!.headEmployeeId).toBe(head.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, a.id))!.leaderId).toBe(head.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, b.id))!.leaderId).toBe(head.id) // 覆盖旧上级
    // 负责人自身:本部门无父部门负责人 → 上级置空(绝不自环/不指向本部门成员)
    expect((await getEmployee(t.db, ownerCtx.tenantId, head.id))!.leaderId).toBeNull()
  })

  it('负责人自身上级归到父部门负责人(跨级上溯)', async () => {
    const parent = await createDepartment(t.db, ownerCtx, { name: '华东大区', parentId: rootDeptId })
    const child = await createDepartment(t.db, ownerCtx, { name: '华东-苏州', parentId: parent.id })
    const parentHead = await emp(parent.id)
    await setDepartmentHead(t.db, ownerCtx, parent.id, parentHead.id)
    const childHead = await emp(child.id)
    await setDepartmentHead(t.db, ownerCtx, child.id, childHead.id)
    // 子部门负责人的上级 = 父部门负责人
    expect((await getEmployee(t.db, ownerCtx.tenantId, childHead.id))!.leaderId).toBe(parentHead.id)
  })

  it('防环:负责人旧上级恰是本部门成员(设后会反指负责人)→ 负责人上级被归置,链无环', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '研发部', parentId: rootDeptId })
    const m = await emp(dept.id)
    const head = await emp(dept.id, { leaderId: m.id }) // head 当前上级是本部门成员 m
    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)
    // m 现在指向 head;head 不能再指向 m(否则成环)→ head 上级置空(无父部门负责人)
    expect((await getEmployee(t.db, ownerCtx.tenantId, m.id))!.leaderId).toBe(head.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, head.id))!.leaderId).toBeNull()
  })

  it('新员工入职到有负责人的部门 → 默认上级=负责人;显式传 leaderId 时以显式为准', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '市场部', parentId: rootDeptId })
    const head = await emp(dept.id)
    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)
    const auto = await emp(dept.id) // 不传 leaderId
    expect(auto.leaderId).toBe(head.id)
    const explicit = await emp(dept.id, { leaderId: head.id === auto.id ? head.id : auto.id })
    expect(explicit.leaderId).toBe(auto.id)
  })

  it('负责人须是本部门在职员工;否则拒绝', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '客服部', parentId: rootDeptId })
    const other = await emp(rootDeptId) // 不在本部门
    await expect(setDepartmentHead(t.db, ownerCtx, dept.id, other.id)).rejects.toThrowError(OrgError)
  })

  it('清负责人:head 指针置空,成员既有上级不动', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '财务部', parentId: rootDeptId })
    const head = await emp(dept.id)
    const a = await emp(dept.id)
    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)
    await setDepartmentHead(t.db, ownerCtx, dept.id, null)
    expect((await getDepartment(t.db, ownerCtx.tenantId, dept.id))!.headEmployeeId).toBeNull()
    expect((await getEmployee(t.db, ownerCtx.tenantId, a.id))!.leaderId).toBe(head.id) // 保留
  })
})

describe('负责人离场清指针', () => {
  it('负责人离职 → 部门 head 指针清空', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '行政部', parentId: rootDeptId })
    const head = await emp(dept.id)
    await emp(dept.id) // 有下属,离职时下属改挂
    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)
    await markEmployeeLeft(t.db, ownerCtx, head.id)
    expect((await getDepartment(t.db, ownerCtx.tenantId, dept.id))!.headEmployeeId).toBeNull()
  })

  it('负责人调离本部门 → 原部门 head 指针清空', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '采购部', parentId: rootDeptId })
    const other = await createDepartment(t.db, ownerCtx, { name: '仓储部', parentId: rootDeptId })
    const head = await emp(dept.id)
    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)
    await updateEmployee(t.db, ownerCtx, head.id, { departmentId: other.id })
    expect((await getDepartment(t.db, ownerCtx.tenantId, dept.id))!.headEmployeeId).toBeNull()
  })

  it('负责人(独任、从未登录)被删除 → 部门 head 指针清空', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '法务部', parentId: rootDeptId })
    const head = await emp(dept.id) // 无 password = 从未登录,可删
    await setDepartmentHead(t.db, ownerCtx, dept.id, head.id)
    await deleteEmployee(t.db, ownerCtx, head.id)
    expect((await getDepartment(t.db, ownerCtx.tenantId, dept.id))!.headEmployeeId).toBeNull()
  })
})
