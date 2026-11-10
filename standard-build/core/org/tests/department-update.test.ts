// 编辑部门详情:改名 + 排序;名称非空校验;不存在的部门报 NOT_FOUND。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createDepartment, getDepartment, updateDepartment } from '../logic/department-tree'
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

describe('编辑部门详情', () => {
  it('改名称 + 排序', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '研发部', parentId: rootDeptId, sort: 1 })
    const updated = await updateDepartment(t.db, ownerCtx, dept.id, { name: '产品研发部', sort: 5 })
    expect(updated.name).toBe('产品研发部')
    expect(updated.sort).toBe(5)
    // 持久化校验
    const reread = await getDepartment(t.db, ownerCtx.tenantId, dept.id)
    expect(reread?.name).toBe('产品研发部')
    expect(reread?.sort).toBe(5)
    // 父子关系不变
    expect(reread?.parentId).toBe(rootDeptId)
  })

  it('不传排序则沿用原值', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '市场部', parentId: rootDeptId, sort: 3 })
    const updated = await updateDepartment(t.db, ownerCtx, dept.id, { name: '品牌市场部' })
    expect(updated.sort).toBe(3)
  })

  it('名称为空 → INVALID_INPUT', async () => {
    const dept = await createDepartment(t.db, ownerCtx, { name: '财务部', parentId: rootDeptId })
    await expect(updateDepartment(t.db, ownerCtx, dept.id, { name: '  ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    } satisfies Partial<OrgError>)
  })

  it('部门不存在 → NOT_FOUND', async () => {
    await expect(
      updateDepartment(t.db, ownerCtx, '00000000-0000-0000-0000-000000000000', { name: 'X' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<OrgError>)
  })
})
