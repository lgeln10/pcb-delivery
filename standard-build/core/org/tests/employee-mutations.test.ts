// 员工编辑 + 受限软删除。守住不变量3:有历史(开通过登录)的员工不可删,只能离职。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import { sql } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { changeOwnPassword, changePassword, createEmployee, DEFAULT_RESET_PASSWORD, deleteEmployee, getEmployee, listEmployees, markEmployeeLeft, reinstateEmployee, updateEmployee } from '../logic/employee'
import { createDepartment } from '../logic/department-tree'
import { assignRoles, createRole, getEmployeeRoleIds } from '../logic/role'
import { OrgError } from '../logic/errors'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ownerCtx: Ctx
let rootDeptId: string
let ownerId: string

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ownerCtx = seeded.ownerCtx
  rootDeptId = seeded.rootDept.id
  ownerId = seeded.owner.id
})
afterAll(async () => t.close())

let seq = 0
async function newEmployee(extra: { password?: string; leaderId?: string; departmentId?: string } = {}) {
  seq += 1
  return createEmployee(t.db, ownerCtx, {
    name: `员工${seq}`,
    empNo: `E${String(seq).padStart(4, '0')}`,
    phone: `139${String(seq).padStart(8, '0')}`,
    departmentId: extra.departmentId ?? rootDeptId,
    leaderId: extra.leaderId,
    password: extra.password,
  })
}

describe('员工编辑', () => {
  it('改姓名/手机/邮箱/部门', async () => {
    const dept2 = await createDepartment(t.db, ownerCtx, { name: '研发部', parentId: rootDeptId })
    const emp = await newEmployee()
    await updateEmployee(t.db, ownerCtx, emp.id, {
      name: '改名了',
      phone: '13700001111',
      email: 'x@y.com',
      departmentId: dept2.id,
    })
    const after = await getEmployee(t.db, ownerCtx.tenantId, emp.id)
    expect(after!.name).toBe('改名了')
    expect(after!.phone).toBe('13700001111')
    expect(after!.email).toBe('x@y.com')
    expect(after!.departmentId).toBe(dept2.id)
  })

  it('换到不存在的部门 → NOT_FOUND', async () => {
    const emp = await newEmployee()
    await expect(
      updateEmployee(t.db, ownerCtx, emp.id, { departmentId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrowError(OrgError)
  })
})

describe('离职 / 复职', () => {
  it('复职:离职后恢复为在职', async () => {
    const emp = await newEmployee({ password: 'pw-12345678' })
    await markEmployeeLeft(t.db, ownerCtx, emp.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, emp.id))!.status).toBe('left')
    await reinstateEmployee(t.db, ownerCtx, emp.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, emp.id))!.status).toBe('active')
  })

  it('对在职员工复职 → INVALID_INPUT', async () => {
    const emp = await newEmployee({ password: 'pw-12345678' })
    await expect(reinstateEmployee(t.db, ownerCtx, emp.id)).rejects.toThrowError(OrgError)
  })

  it('组织页离职即回收全部角色;复职后角色为空,不静默带回旧权限', async () => {
    const role = await createRole(t.db, ownerCtx, { name: '离职回收用', code: 'leave-revoke-1' })
    const emp = await newEmployee({ password: 'pw-12345678' })
    await assignRoles(t.db, ownerCtx, emp.id, [role.id])
    expect(await getEmployeeRoleIds(t.db, ownerCtx, emp.id)).toEqual([role.id])
    await markEmployeeLeft(t.db, ownerCtx, emp.id)
    expect(await getEmployeeRoleIds(t.db, ownerCtx, emp.id)).toEqual([])
    await reinstateEmployee(t.db, ownerCtx, emp.id)
    expect(await getEmployeeRoleIds(t.db, ownerCtx, emp.id)).toEqual([]) // 复职不自动恢复,需重新分配
  })
})

describe('员工列表模糊搜索(姓名/手机号)', () => {
  it('按姓名子串命中', async () => {
    const emp = await createEmployee(t.db, ownerCtx, {
      name: '欧阳娜娜', empNo: 'SRCH1', phone: '13912340001', departmentId: rootDeptId,
    })
    const { items } = await listEmployees(t.db, ownerCtx, { q: '阳娜' })
    expect(items.map((e) => e.id)).toContain(emp.id)
    expect(items.every((e) => e.name.includes('阳娜') || e.phone.includes('阳娜'))).toBe(true)
  })

  it('按手机号子串命中', async () => {
    const emp = await createEmployee(t.db, ownerCtx, {
      name: '搜索测试乙', empNo: 'SRCH2', phone: '13988887777', departmentId: rootDeptId,
    })
    const { items } = await listEmployees(t.db, ownerCtx, { q: '8888' })
    expect(items.map((e) => e.id)).toContain(emp.id)
  })

  it('无匹配返回空', async () => {
    const { items } = await listEmployees(t.db, ownerCtx, { q: '绝不存在的关键词zzz' })
    expect(items).toHaveLength(0)
  })
})

describe('员工受限软删除', () => {
  it('从未登录的误建员工 → 可删(软删:is_deleted=true),角色关联一并清掉', async () => {
    const role = await createRole(t.db, ownerCtx, { name: '临时', code: `tmp-${seq}` })
    const emp = await newEmployee() // 无 password = 未开通登录
    await assignRoles(t.db, ownerCtx, emp.id, [role.id])
    await deleteEmployee(t.db, ownerCtx, emp.id)
    const row = (await t.db.execute(sql`select is_deleted from employees where id = ${emp.id}`)) as {
      rows: { is_deleted: boolean }[]
    }
    expect(row.rows[0]!.is_deleted).toBe(true)
    const er = (await t.db.execute(sql`select count(*)::int as n from employee_roles where employee_id = ${emp.id}`)) as {
      rows: { n: number }[]
    }
    expect(er.rows[0]!.n).toBe(0)
    // 软删后默认查询查不到
    expect(await getEmployee(t.db, ownerCtx.tenantId, emp.id)).toBeNull()
  })

  it('已开通登录(可能有历史单据)→ 拒绝删除(改用离职),不变量3', async () => {
    const emp = await newEmployee({ password: 'has-login-123' })
    await expect(deleteEmployee(t.db, ownerCtx, emp.id)).rejects.toMatchObject({ code: 'EMPLOYEE_HAS_LOGIN' })
    expect((await getEmployee(t.db, ownerCtx.tenantId, emp.id))!.isDeleted).toBe(false)
  })

  it('是他人上级 → 拒绝删除', async () => {
    const leader = await newEmployee() // 未开通登录,过 has-login 关
    await newEmployee({ leaderId: leader.id })
    await expect(deleteEmployee(t.db, ownerCtx, leader.id)).rejects.toMatchObject({ code: 'EMPLOYEE_HAS_SUBORDINATES' })
  })

  it('租户负责人 → 不可删', async () => {
    await expect(deleteEmployee(t.db, ownerCtx, ownerId)).rejects.toThrowError(OrgError)
  })
})

describe('重置密码', () => {
  async function hashOf(empId: string) {
    const row = (await t.db.execute(sql`select password_hash from employees where id = ${empId}`)) as {
      rows: { password_hash: string | null }[]
    }
    return row.rows[0]!.password_hash
  }

  it('指定新密码 → 哈希入库且可校验,与原哈希不同', async () => {
    const emp = await newEmployee({ password: 'old-secret-1' })
    const before = await hashOf(emp.id)
    await changePassword(t.db, ownerCtx, emp.id, 'brand-new-9')
    const after = await hashOf(emp.id)
    expect(after).not.toBe(before)
    expect(await bcrypt.compare('brand-new-9', after!)).toBe(true)
  })

  it('默认密码 changeMe@6am 可重置并校验', async () => {
    const emp = await newEmployee({ password: 'old-secret-2' })
    await changePassword(t.db, ownerCtx, emp.id, DEFAULT_RESET_PASSWORD)
    expect(await bcrypt.compare(DEFAULT_RESET_PASSWORD, (await hashOf(emp.id))!)).toBe(true)
  })

  it('密码不足 8 位 → INVALID_INPUT', async () => {
    const emp = await newEmployee({ password: 'old-secret-3' })
    await expect(changePassword(t.db, ownerCtx, emp.id, 'short')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('自助修改密码 changeOwnPassword(验原密码,只改本人)', () => {
  it('原密码正确 → 改成功;新密码生效、原密码失效(bcrypt 校验)', async () => {
    const emp = await newEmployee({ password: 'old-pass-123' })
    const ctx = { tenantId: ownerCtx.tenantId, employeeId: emp.id } as Ctx
    await changeOwnPassword(t.db, ctx, { oldPassword: 'old-pass-123', newPassword: 'new-pass-456' })
    const after = await getEmployee(t.db, ownerCtx.tenantId, emp.id)
    expect(await bcrypt.compare('new-pass-456', after!.passwordHash!)).toBe(true)
    expect(await bcrypt.compare('old-pass-123', after!.passwordHash!)).toBe(false)
  })

  it('原密码错误 → WRONG_PASSWORD,密码保持不变', async () => {
    const emp = await newEmployee({ password: 'right-pass-1' })
    const ctx = { tenantId: ownerCtx.tenantId, employeeId: emp.id } as Ctx
    await expect(
      changeOwnPassword(t.db, ctx, { oldPassword: 'wrong-pass', newPassword: 'new-pass-789' }),
    ).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
    const after = await getEmployee(t.db, ownerCtx.tenantId, emp.id)
    expect(await bcrypt.compare('right-pass-1', after!.passwordHash!)).toBe(true) // 未变
  })

  it('新密码 <8 位 / 与原密码相同 → INVALID_INPUT', async () => {
    const emp = await newEmployee({ password: 'keep-pass-1' })
    const ctx = { tenantId: ownerCtx.tenantId, employeeId: emp.id } as Ctx
    await expect(
      changeOwnPassword(t.db, ctx, { oldPassword: 'keep-pass-1', newPassword: 'short' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      changeOwnPassword(t.db, ctx, { oldPassword: 'keep-pass-1', newPassword: 'keep-pass-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('工号选填:留空自动生成', () => {
  it('留空 → 生成 No.00001 格式工号,连续新建序号递增', async () => {
    seq += 1
    const a = await createEmployee(t.db, ownerCtx, {
      name: '自动工号甲', phone: `137${String(seq).padStart(8, '0')}`, departmentId: rootDeptId,
    })
    seq += 1
    const b = await createEmployee(t.db, ownerCtx, {
      name: '自动工号乙', phone: `137${String(seq).padStart(8, '0')}`, departmentId: rootDeptId,
    })
    expect(a.empNo).toMatch(/^No\.\d{5,}$/)
    expect(b.empNo).toMatch(/^No\.\d{5,}$/)
    expect(Number(b.empNo.slice(3))).toBe(Number(a.empNo.slice(3)) + 1)
  })

  it('空串等同留空;传了工号则原样保留,且自定义工号不参与序号计算', async () => {
    seq += 1
    const blank = await createEmployee(t.db, ownerCtx, {
      name: '空串工号', empNo: '   ', phone: `137${String(seq).padStart(8, '0')}`, departmentId: rootDeptId,
    })
    expect(blank.empNo).toMatch(/^No\.\d{5,}$/)
    seq += 1
    const custom = await createEmployee(t.db, ownerCtx, {
      name: '自定义工号', empNo: 'ZDY-9999', phone: `137${String(seq).padStart(8, '0')}`, departmentId: rootDeptId,
    })
    expect(custom.empNo).toBe('ZDY-9999')
    seq += 1
    const next = await createEmployee(t.db, ownerCtx, {
      name: '自动工号丙', phone: `137${String(seq).padStart(8, '0')}`, departmentId: rootDeptId,
    })
    expect(Number(next.empNo.slice(3))).toBe(Number(blank.empNo.slice(3)) + 1) // 自定义工号不打断递增
  })
})
