// 质量护栏固化(QUALITY_GUARDRAILS):写操作幂等 + 列表分页上限契约。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { createEmployee, listEmployees } from '../logic/employee'
import { assignRoles, createRole, grantPermission } from '../logic/role'
import { getDataScope } from '../api'
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

describe('写操作幂等', () => {
  it('assignRoles 重复执行不产生重复关联', async () => {
    const emp = await createEmployee(t.db, ownerCtx, {
      name: '幂等员工',
      empNo: 'IDEM-1',
      phone: '13600000001',
      departmentId: rootDeptId,
    })
    const role = await createRole(t.db, ownerCtx, { name: 'R', code: 'idem-role' })
    await assignRoles(t.db, ownerCtx, emp.id, [role.id])
    await assignRoles(t.db, ownerCtx, emp.id, [role.id]) // 重复提交
    const rows = (await t.db.execute(
      sql`select count(*)::int as n from employee_roles where employee_id = ${emp.id} and role_id = ${role.id}`,
    )) as { rows: { n: number }[] }
    expect(rows.rows[0]!.n).toBe(1)
  })

  it('grantPermission 重复执行 = 更新 scope,不产生重复行', async () => {
    const role = await createRole(t.db, ownerCtx, { name: 'G', code: 'idem-grant' })
    await grantPermission(t.db, ownerCtx, role.id, 'partner:view', 'SELF')
    await grantPermission(t.db, ownerCtx, role.id, 'partner:view', 'DEPT') // 重复授权,scope 升级
    const rows = (await t.db.execute(
      sql`select count(*)::int as n, max(data_scope) as scope from role_permissions where role_id = ${role.id}`,
    )) as { rows: { n: number; scope: string }[] }
    expect(rows.rows[0]!.n).toBe(1)
    expect(rows.rows[0]!.scope).toBe('DEPT')
  })
})

describe('列表契约:分页 + 上限 + 游标', () => {
  it('limit 超过 50 被钳到 50;游标翻页可遍历全部且不重不漏', async () => {
    for (let i = 0; i < 55; i++) {
      await createEmployee(t.db, ownerCtx, {
        name: `批量${i}`,
        empNo: `BULK-${i}`,
        phone: `135${String(i).padStart(8, '0')}`,
        departmentId: rootDeptId,
      })
    }
    const page1 = await listEmployees(t.db, ownerCtx, { limit: 9999 }) // 恶意大 limit
    expect(page1.items.length).toBe(50) // ★上限契约
    expect(page1.nextCursor).not.toBeNull()

    const seen = new Set(page1.items.map((e) => e.id))
    let cursor = page1.nextCursor
    while (cursor) {
      const page = await listEmployees(t.db, ownerCtx, { cursor, limit: 50 })
      for (const e of page.items) {
        expect(seen.has(e.id)).toBe(false) // 不重
        seen.add(e.id)
      }
      cursor = page.nextCursor
    }
    expect(seen.size).toBeGreaterThanOrEqual(56) // 55 批量 + 老板,不漏
  })

  it('默认 limit = 20', async () => {
    const page = await listEmployees(t.db, ownerCtx, {})
    expect(page.items.length).toBe(20)
  })
})

describe('数据权限查询无 N+1(查询计数)', () => {
  it('getDataScope 一次调用 SQL 数为 O(1),与角色数无关', async () => {
    const emp = await createEmployee(t.db, ownerCtx, {
      name: '多角色',
      empNo: 'NPLUS-1',
      phone: '13600000099',
      departmentId: rootDeptId,
    })
    // 给 5 个角色,每个都授 partner:view
    const roleIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const r = await createRole(t.db, ownerCtx, { name: `N${i}`, code: `nplus-${i}` })
      await grantPermission(t.db, ownerCtx, r.id, 'partner:view', 'SELF')
      roleIds.push(r.id)
    }
    await assignRoles(t.db, ownerCtx, emp.id, roleIds)

    let queryCount = 0
    const original = t.raw.query.bind(t.raw)
    // PGlite 的所有 SQL 都走 query;计数代理
    ;(t.raw as { query: typeof original }).query = (async (...args: Parameters<typeof original>) => {
      queryCount += 1
      return original(...args)
    }) as typeof original

    await getDataScope(t.db, ownerCtx.tenantId, emp.id, 'partner:view')
    ;(t.raw as { query: typeof original }).query = original

    // 超管判定(2) + 授权 JOIN(1) ≤ 4,绝不随角色数增长
    expect(queryCount).toBeLessThanOrEqual(4)
  })
})
