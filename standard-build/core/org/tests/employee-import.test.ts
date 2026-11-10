// 组织员工 Excel 批量导入:模板、逐行校验、只新增不更新。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createDepartment } from '../logic/department-tree'
import { createEmployee, getEmployee, getDefaultEmployeePassword, setDefaultEmployeePassword, listEmployees, DEFAULT_RESET_PASSWORD } from '../logic/employee'
import { buildEmployeeImportTemplate, importEmployeesFromWorkbook } from '../logic/employee-import'
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

function workbook(rows: unknown[][]): Buffer {
  const wb = XLSX.read(buildEmployeeImportTemplate(), { type: 'buffer' })
  wb.Sheets[wb.SheetNames[0]!] = XLSX.utils.aoa_to_sheet(rows)
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function rawWorkbook(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '导入')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

describe('员工 Excel 批量导入', () => {
  it('生成模板用星号标注必填列,岗位为选填列;第 2 行带一条示例数据,填写说明页逐列标必填/选填', () => {
    const buf = buildEmployeeImportTemplate()
    const wb = XLSX.read(buf, { type: 'buffer' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: false })
    expect(rows[0]).toEqual(['工号', '姓名*', '手机号*', '一级部门*', '二级部门', '三级部门', '岗位', '邮箱'])
    expect(rows[1]).toEqual(['', '张三', '13800000000', '示例公司', '销售部', '', '工程主管', 'zhangsan@example.com'])
    expect(wb.SheetNames).toContain('填写说明')
    const guide = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['填写说明']!, { header: 1, defval: '', raw: false })
    expect(guide[1]).toEqual(['字段', '是否必填', '说明', '示例'])
    expect(guide.some((row) => row[0] === '姓名' && row[1] === '必填')).toBe(true)
    expect(guide.some((row) => row[0] === '工号' && row[1] === '选填')).toBe(true)
  })

  it('模板原样(只有示例行)提交 → 示例行被跳过,提示没有可导入的数据行', async () => {
    await expect(importEmployeesFromWorkbook(t.db, ownerCtx, buildEmployeeImportTemplate())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('导入只新增员工,为工号生成内部值,并保存岗位', async () => {
    const sales = await createDepartment(t.db, ownerCtx, { name: '销售部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '手机号', '部门', '岗位', '邮箱'],
      ['张三', '13800010001', '销售部', '客户经理', 'zhangsan@example.com'],
    ]))

    expect(result.success).toBe(1)
    expect(result.failed).toBe(0)
    const employee = await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!)
    expect(employee).toMatchObject({
      name: '张三',
      phone: '13800010001',
      departmentId: sales.id,
      position: '客户经理',
      email: 'zhangsan@example.com',
    })
    expect(employee!.empNo).toMatch(/^No\.\d{5,}$/) // 自动生成工号格式 No.00001(5位)
  })

  it('已有员工手机号跳过且不更新原员工', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '运营部', parentId: rootDeptId })
    const existing = await createEmployee(t.db, ownerCtx, {
      name: '李四',
      empNo: 'E-EXIST',
      phone: '13800000002',
      departmentId: dept.id,
      position: '运营专员',
      email: 'old@example.com',
    })

    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '手机号', '部门', '岗位', '邮箱'],
      ['李四新', '13800000002', '运营部', '运营主管', 'new@example.com'],
    ]))

    expect(result.success).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.rows[0]!.reason).toContain('员工已存在')
    expect(await getEmployee(t.db, ownerCtx.tenantId, existing.id)).toMatchObject({
      name: '李四',
      position: '运营专员',
      email: 'old@example.com',
    })
  })

  it('逐行返回缺字段/部门不存在/邮箱错误/文件内手机号重复原因', async () => {
    await createDepartment(t.db, ownerCtx, { name: '财务部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '手机号', '部门', '岗位', '邮箱'],
      ['', '13800000003', '财务部', '会计', 'a@example.com'],
      ['王五', '13800000004', '不存在部门', '会计', 'b@example.com'],
      ['赵六', '13800000005', '财务部', '出纳', 'bad-email'],
      ['孙七', '13800000006', '财务部', '出纳', 'c@example.com'],
      ['孙七重复', '13800000006', '财务部', '出纳', 'd@example.com'],
    ]))

    expect(result.total).toBe(5)
    expect(result.success).toBe(1)
    expect(result.failed).toBe(4)
    expect(result.rows.map((row) => row.reason)).toEqual([
      '姓名不能为空',
      '部门不存在',
      '邮箱格式不正确',
      null,
      '手机号在导入文件中重复',
    ])
  })

  it('岗位为空也可导入,系统仍生成内部工号', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '无岗位导入部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名*', '手机号*', '一级部门*', '二级部门', '三级部门', '岗位', '邮箱*'],
      ['无岗位员工', '13800000007', '无岗位导入部', '', '', '', 'nopos@example.com'],
    ]))

    expect(result.success).toBe(1)
    const employee = await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!)
    expect(employee).toMatchObject({
      name: '无岗位员工',
      phone: '13800000007',
      departmentId: dept.id,
      position: '',
      email: 'nopos@example.com',
    })
    expect(employee!.empNo).toMatch(/^No\.\d{5,}$/) // 自动生成工号格式 No.00001(5位)
  })

  it('工号为选填:填写时按文件工号导入,留空时自动生成', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '工号导入部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['工号', '姓名*', '手机号*', '一级部门*', '二级部门', '三级部门', '岗位', '邮箱*'],
      ['E9001', '自定义工号员工', '13800000008', '工号导入部', '', '', '', 'empno@example.com'],
      ['', '自动工号员工', '13800000009', '工号导入部', '', '', '', 'autoempno@example.com'],
    ]))

    expect(result.success).toBe(2)
    const custom = await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!)
    const generated = await getEmployee(t.db, ownerCtx.tenantId, result.rows[1]!.employeeId!)
    expect(custom).toMatchObject({ departmentId: dept.id, empNo: 'E9001' })
    expect(generated).toMatchObject({ departmentId: dept.id })
    expect(generated!.empNo).toMatch(/^No\.\d{5,}$/) // 留空 → 自动生成工号 No.00001(5位)
  })

  it('导入文件内工号重复或与系统已有工号重复时逐行失败', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '工号重复校验部', parentId: rootDeptId })
    await createEmployee(t.db, ownerCtx, {
      name: '已有工号员工',
      empNo: 'E-EXIST-EMP-NO',
      phone: '13800000010',
      departmentId: dept.id,
    })

    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['工号', '姓名*', '手机号*', '一级部门*', '二级部门', '三级部门', '岗位', '邮箱*'],
      ['DUP-1', '工号员工一', '13800000011', '工号重复校验部', '', '', '', 'dup1@example.com'],
      ['DUP-1', '工号员工二', '13800000012', '工号重复校验部', '', '', '', 'dup2@example.com'],
      ['E-EXIST-EMP-NO', '已有工号冲突', '13800000013', '工号重复校验部', '', '', '', 'existempno@example.com'],
    ]))

    expect(result.success).toBe(1)
    expect(result.failed).toBe(2)
    expect(result.rows.map((row) => row.reason)).toEqual([null, '工号在导入文件中重复', '工号已存在'])
  })

  it('缺少必填模板列会拒绝整个文件', async () => {
    // 手机号为必填列,缺列整份文件拒绝(邮箱已改选填,缺邮箱列不拒绝)
    await expect(importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '部门', '岗位'],
      ['张三', '财务部', '会计'],
    ]))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('邮箱为选填:缺邮箱列或留空都能导入', async () => {
    await createDepartment(t.db, ownerCtx, { name: '行政部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '手机号', '部门', '岗位'], // 无邮箱列
      ['周八', '13800008888', '行政部', '专员'],
    ]))
    expect(result.success).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('不是通过模板下载生成的文件会被拒绝导入', async () => {
    await expect(importEmployeesFromWorkbook(t.db, ownerCtx, rawWorkbook([
      ['姓名', '手机号', '部门', '岗位', '邮箱'],
      ['张三', '13800009999', '财务部', '会计', 'a@example.com'],
    ]))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: '请先下载“员工导入模板”并基于模板填写后再导入',
    })
  })

  it('导入后列表能返回岗位字段', async () => {
    const list = await listEmployees(t.db, ownerCtx, { limit: 50 })
    expect(list.items.some((employee) => employee.position === '客户经理')).toBe(true)
  })
})

const MULTI_HEADER = ['姓名', '手机号', '一级部门', '二级部门', '三级部门', '岗位', '邮箱']

describe('员工导入 —— 二级/三级部门(一级/二级/三级部门多列)', () => {
  it('多级部门按层级列命中:一级只填一级列,三级三列都填', async () => {
    const rd = await createDepartment(t.db, ownerCtx, { name: '研发中心', parentId: rootDeptId })
    const group = await createDepartment(t.db, ownerCtx, { name: '后端组', parentId: rd.id })
    const team = await createDepartment(t.db, ownerCtx, { name: '支付小队', parentId: group.id })

    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      MULTI_HEADER,
      ['一级员工', '13820000001', '研发中心', '', '', '总监', 'l1@example.com'],
      ['二级员工', '13820000002', '研发中心', '后端组', '', '组长', 'l2@example.com'],
      ['三级员工', '13820000003', '研发中心', '后端组', '支付小队', '工程师', 'l3@example.com'],
    ]))

    expect(result.success).toBe(3)
    expect((await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!))!.departmentId).toBe(rd.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, result.rows[1]!.employeeId!))!.departmentId).toBe(group.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, result.rows[2]!.employeeId!))!.departmentId).toBe(team.id)
  })

  it('同名子部门:只填本级名称报「不唯一」,补上级部门列即可各自唯一', async () => {
    // 研发中心A/前端组 与 市场中心A/前端组 同名,分属不同上级。
    const dev = await createDepartment(t.db, ownerCtx, { name: '研发中心A', parentId: rootDeptId })
    const mkt = await createDepartment(t.db, ownerCtx, { name: '市场中心A', parentId: rootDeptId })
    const devFe = await createDepartment(t.db, ownerCtx, { name: '前端组', parentId: dev.id })
    const mktFe = await createDepartment(t.db, ownerCtx, { name: '前端组', parentId: mkt.id })

    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      MULTI_HEADER,
      ['歧义员工', '13830000001', '', '前端组', '', '工程师', 'amb@example.com'],
      ['研发前端', '13830000002', '研发中心A', '前端组', '', '工程师', 'df@example.com'],
      ['市场前端', '13830000003', '市场中心A', '前端组', '', '工程师', 'mf@example.com'],
    ]))

    expect(result.rows[0]!.status).toBe('failed')
    expect(result.rows[0]!.reason).toContain('部门名称不唯一')
    expect(result.rows[1]!.status).toBe('success')
    expect(result.rows[2]!.status).toBe('success')
    expect((await getEmployee(t.db, ownerCtx.tenantId, result.rows[1]!.employeeId!))!.departmentId).toBe(devFe.id)
    expect((await getEmployee(t.db, ownerCtx.tenantId, result.rows[2]!.employeeId!))!.departmentId).toBe(mktFe.id)
  })

  it('上级列只需填到能区分为止(顶层可留空,按名称后缀匹配)', async () => {
    // root/华东大区/销售一部/华东小组,只填「销售一部 + 华东小组」两列即可命中(华东大区留空)。
    const region = await createDepartment(t.db, ownerCtx, { name: '华东大区', parentId: rootDeptId })
    const sales1 = await createDepartment(t.db, ownerCtx, { name: '销售一部', parentId: region.id })
    const team = await createDepartment(t.db, ownerCtx, { name: '华东小组', parentId: sales1.id })

    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      MULTI_HEADER,
      ['小组员工', '13840000001', '', '销售一部', '华东小组', '专员', 'team@example.com'],
    ]))

    expect(result.success).toBe(1)
    expect((await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!))!.departmentId).toBe(team.id)
  })

  it('缺“岗位”列仍可导入(岗位为选填)', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '缺岗位列导入部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '手机号', '一级部门', '二级部门', '三级部门', '邮箱'],
      ['张三', '13850000001', '缺岗位列导入部', '', '', 'a@example.com'],
    ]))

    expect(result.success).toBe(1)
    const employee = await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!)
    expect(employee).toMatchObject({ departmentId: dept.id, position: '' })
  })
})

describe('新建/导入员工默认密码(可配置、持久)', () => {
  it('默认密码初始为内置值,可修改并持久,少于 8 位报错', async () => {
    expect(await getDefaultEmployeePassword(t.db, ownerCtx)).toBe(DEFAULT_RESET_PASSWORD)
    const saved = await setDefaultEmployeePassword(t.db, ownerCtx, '  newPass@2026  ')
    expect(saved).toBe('newPass@2026') // 去空白
    expect(await getDefaultEmployeePassword(t.db, ownerCtx)).toBe('newPass@2026')
    await expect(setDefaultEmployeePassword(t.db, ownerCtx, 'short')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    // 复位,避免影响后面用例
    await setDefaultEmployeePassword(t.db, ownerCtx, DEFAULT_RESET_PASSWORD)
  })

  it('createEmployee 传 passwordHash 直接开通登录(不再哈希)', async () => {
    const hash = await bcrypt.hash('preHashed@1', 10)
    const emp = await createEmployee(t.db, ownerCtx, {
      name: '预哈希员工', empNo: 'PH-1', phone: '13860000001', departmentId: rootDeptId, passwordHash: hash,
    })
    const got = await getEmployee(t.db, ownerCtx.tenantId, emp.id)
    expect(got!.passwordHash).toBe(hash)
  })

  it('导入的员工一律开通登录,且用当前默认密码', async () => {
    await setDefaultEmployeePassword(t.db, ownerCtx, 'imp0rtPass@9')
    const dept = await createDepartment(t.db, ownerCtx, { name: '导入默认密码部', parentId: rootDeptId })
    const result = await importEmployeesFromWorkbook(t.db, ownerCtx, workbook([
      ['姓名', '手机号', '一级部门', '二级部门', '三级部门', '岗位', '邮箱'],
      ['默认密码员工', '13870000001', '导入默认密码部', '', '', '专员', 'defpass@example.com'],
    ]))
    expect(result.success).toBe(1)
    const emp = await getEmployee(t.db, ownerCtx.tenantId, result.rows[0]!.employeeId!)
    expect(emp!.passwordHash).not.toBeNull() // 开通了登录
    expect(await bcrypt.compare('imp0rtPass@9', emp!.passwordHash!)).toBe(true) // 就是当前默认密码
    await setDefaultEmployeePassword(t.db, ownerCtx, DEFAULT_RESET_PASSWORD)
  })
})
