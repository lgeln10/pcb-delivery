// ★org 的 9 条不变量测试(DATA_MODEL_org §2)。AI 改 org 时这些必须全绿。
// 测试名 = 不变量编号 + 内容,红了直接能看出破坏了哪条。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import {
  createDepartment,
  deleteDepartment,
  moveDepartment,
  recomputeDeptPaths,
  setDepartmentStatus,
} from '../logic/department-tree'
import { createEmployee, getLeaderChain, markEmployeeLeft, setLeader } from '../logic/employee'
import { getCurrentEmployee, getDeptSubtree } from '../api'
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

let empSeq = 0
async function newEmployee(ctx: Ctx, deptId: string, extra: { leaderId?: string; password?: string } = {}) {
  empSeq += 1
  return createEmployee(t.db, ctx, {
    name: `员工${empSeq}`,
    empNo: `E${String(empSeq).padStart(4, '0')}`,
    phone: `139${String(empSeq).padStart(8, '0')}`,
    departmentId: deptId,
    ...extra,
  })
}

describe('org 九条不变量', () => {
  it('1. path 与 parent_id 链一致(全量重算对账全等)', async () => {
    const a = await createDepartment(t.db, ownerCtx, { name: '销售部', parentId: rootDeptId })
    await createDepartment(t.db, ownerCtx, { name: '华东组', parentId: a.id })
    const expected = await recomputeDeptPaths(t.db, ownerCtx.tenantId)
    const stored = (await t.db.execute(
      sql`select id, path from departments where tenant_id = ${ownerCtx.tenantId} and is_deleted = false`,
    )) as { rows: { id: string; path: string }[] }
    expect(stored.rows.length).toBeGreaterThan(0)
    for (const row of stored.rows) expect(row.path, `department ${row.id}`).toBe(expected.get(row.id))
  })

  it('2. 租户隔离不可越界(跨租户查询必空/拒绝)', async () => {
    const other = await seedTenant(t.db, '另一家公司')
    // 用 B 租户的 ctx 查 A 租户的部门子树 → 拒绝(查不到)
    await expect(getDeptSubtree(t.db, other.tenant.id, rootDeptId)).rejects.toThrowError(OrgError)
    // 用 B 租户 ctx 查 A 租户员工 → 查不到
    const fakeCtx: Ctx = { tenantId: other.tenant.id, employeeId: ownerCtx.employeeId }
    await expect(getCurrentEmployee(t.db, fakeCtx)).rejects.toThrowError(OrgError)
  })

  it('3. 离职员工不被删除(置 left 后历史引用仍可解析;delete 仅对从未登录的误建员工放行,见 employee-mutations.test)', async () => {
    const emp = await newEmployee(ownerCtx, rootDeptId)
    await markEmployeeLeft(t.db, ownerCtx, emp.id)
    const row = (await t.db.execute(sql`select status, is_deleted from employees where id = ${emp.id}`)) as {
      rows: { status: string; is_deleted: boolean }[]
    }
    expect(row.rows[0]!.status).toBe('left')
    expect(row.rows[0]!.is_deleted).toBe(false) // 行还在,历史单据的 created_by 仍可解析
  })

  it('4. 密码永不明文(bcrypt 哈希格式,与原文不等)', async () => {
    const emp = await newEmployee(ownerCtx, rootDeptId, { password: 'plain-secret-9' })
    const row = (await t.db.execute(sql`select password_hash from employees where id = ${emp.id}`)) as {
      rows: { password_hash: string }[]
    }
    const hash = row.rows[0]!.password_hash
    expect(hash).not.toBe('plain-secret-9')
    expect(hash).toMatch(/^\$2[aby]\$/) // bcrypt 前缀
  })

  it('5. 工号租户内唯一(库层部分唯一索引兜底)', async () => {
    const emp = await newEmployee(ownerCtx, rootDeptId)
    await expect(
      createEmployee(t.db, ownerCtx, {
        name: '撞号者',
        empNo: emp.empNo, // 同租户同工号
        phone: '13999999999',
        departmentId: rootDeptId,
      }),
    ).rejects.toThrowError() // unique violation
    // 但另一个租户可以用同样的工号(租户内唯一,非全局)
    const other = await seedTenant(t.db, '工号撞租户')
    await expect(
      createEmployee(t.db, other.ownerCtx, {
        name: '同号不同租户',
        empNo: emp.empNo,
        phone: '13999999998',
        departmentId: other.rootDept.id,
      }),
    ).resolves.toBeDefined()
  })

  it('6. 部门树无环(移入自己子树被拒;parent 上溯有限步到 null)', async () => {
    const a = await createDepartment(t.db, ownerCtx, { name: 'A', parentId: rootDeptId })
    const b = await createDepartment(t.db, ownerCtx, { name: 'B', parentId: a.id })
    const c = await createDepartment(t.db, ownerCtx, { name: 'C', parentId: b.id })
    await expect(moveDepartment(t.db, ownerCtx, a.id, c.id)).rejects.toThrowError(OrgError)
    await expect(moveDepartment(t.db, ownerCtx, a.id, a.id)).rejects.toThrowError(OrgError)
    // 上溯:recomputeDeptPaths 内含环检测,正常返回即无环
    await expect(recomputeDeptPaths(t.db, ownerCtx.tenantId)).resolves.toBeDefined()
  })

  it('7. 汇报链无环(setLeader 成环被拒;上溯有限步终止)', async () => {
    const e1 = await newEmployee(ownerCtx, rootDeptId)
    const e2 = await newEmployee(ownerCtx, rootDeptId, { leaderId: e1.id })
    const e3 = await newEmployee(ownerCtx, rootDeptId, { leaderId: e2.id })
    // e1 的上级设为 e3:e3 → e2 → e1,成环,必须拒绝
    await expect(setLeader(t.db, ownerCtx, e1.id, e3.id)).rejects.toThrowError(OrgError)
    await expect(setLeader(t.db, ownerCtx, e1.id, e1.id)).rejects.toThrowError(OrgError)
    // 链上溯有限步终止
    const chain = await getLeaderChain(t.db, ownerCtx.tenantId, e3.id)
    expect(chain.map((e) => e.id)).toEqual([e2.id, e1.id])
  })

  it('8. 无孤儿员工(有在职员工的部门禁删/禁用)', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '有人部门', parentId: rootDeptId })
    await newEmployee(ownerCtx, dept.id)
    await expect(deleteDepartment(t.db, ownerCtx, dept.id)).rejects.toThrowError(OrgError)
    await expect(setDepartmentStatus(t.db, ownerCtx, dept.id, 'disabled')).rejects.toThrowError(OrgError)
    // 全库对账:不存在 active 员工部门为空或指向已删/不存在部门
    const orphans = (await t.db.execute(sql`
      select e.id from employees e
      left join departments d on d.id = e.department_id and d.is_deleted = false
      where e.status = 'active' and e.is_deleted = false and d.id is null
    `)) as { rows: unknown[] }
    expect(orphans.rows).toEqual([])
  })

  it('9. path 级联一致性(迁移有子孙的部门后全子树对账全等)', async () => {
    const src = await createDepartment(t.db, ownerCtx, { name: '迁移源', parentId: rootDeptId })
    const mid = await createDepartment(t.db, ownerCtx, { name: '中层', parentId: src.id })
    const leaf = await createDepartment(t.db, ownerCtx, { name: '叶子', parentId: mid.id })
    const dst = await createDepartment(t.db, ownerCtx, { name: '迁移目标', parentId: rootDeptId })

    await moveDepartment(t.db, ownerCtx, src.id, dst.id)

    const expected = await recomputeDeptPaths(t.db, ownerCtx.tenantId)
    const stored = (await t.db.execute(
      sql`select id, path from departments where tenant_id = ${ownerCtx.tenantId} and is_deleted = false`,
    )) as { rows: { id: string; path: string }[] }
    for (const row of stored.rows) expect(row.path, `department ${row.id}`).toBe(expected.get(row.id))
    expect(expected.get(leaf.id)).toBe(`/${rootDeptId}/${dst.id}/${src.id}/${mid.id}/${leaf.id}/`)
  })

  it('附:子部门未迁走的部门禁删(防孤儿子树)', async () => {
    const p = await createDepartment(t.db, ownerCtx, { name: '父', parentId: rootDeptId })
    await createDepartment(t.db, ownerCtx, { name: '子', parentId: p.id })
    await expect(deleteDepartment(t.db, ownerCtx, p.id)).rejects.toThrowError(OrgError)
  })

  it('附:空部门可物理删除,离职员工历史部门引用清空', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '待物理删除', parentId: rootDeptId })
    const emp = await newEmployee(ownerCtx, dept.id)
    await markEmployeeLeft(t.db, ownerCtx, emp.id)

    await deleteDepartment(t.db, ownerCtx, dept.id)

    const deptRows = (await t.db.execute(sql`select id from departments where id = ${dept.id}`)) as { rows: unknown[] }
    expect(deptRows.rows).toEqual([])
    const empRows = (await t.db.execute(sql`select department_id from employees where id = ${emp.id}`)) as {
      rows: { department_id: string | null }[]
    }
    expect(empRows.rows[0]?.department_id).toBeNull()
  })

  it('附:离职后下属汇报线重指(默认跳级到离职者上级,提拔场景防自环)', async () => {
    const lead = await newEmployee(ownerCtx, rootDeptId)
    const mid = await newEmployee(ownerCtx, rootDeptId, { leaderId: lead.id })
    const s1 = await newEmployee(ownerCtx, rootDeptId, { leaderId: mid.id })
    const s2 = await newEmployee(ownerCtx, rootDeptId, { leaderId: mid.id })
    // mid 离职,显式把下属指给 s1(s1 自己是下属之一 → s1 改指 lead,不自环)
    await markEmployeeLeft(t.db, ownerCtx, mid.id, { subordinatesNewLeaderId: s1.id })
    const chain2 = await getLeaderChain(t.db, ownerCtx.tenantId, s2.id)
    expect(chain2[0]!.id).toBe(s1.id)
    const chain1 = await getLeaderChain(t.db, ownerCtx.tenantId, s1.id)
    expect(chain1[0]!.id).toBe(lead.id)
  })
})
