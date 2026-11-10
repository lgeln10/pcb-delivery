// core/auth 测试:登录全分支 + token 防篡改/过期 + Ctx 复查(离职/停租户立即失效)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../org/tests/helpers'
import { createEmployee, markEmployeeLeft } from '../org/logic/employee'
import { login, ctxFromToken } from './login'
import { signToken, verifyToken } from './token'
import { AuthError } from './errors'
import type { Ctx } from '../db/client'

const SECRET = 'test-secret-not-for-prod'
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
async function newLoginEmployee(password?: string) {
  seq += 1
  return createEmployee(t.db, ownerCtx, {
    name: `登录员工${seq}`,
    empNo: `AUTH-${seq}`,
    phone: `133${String(seq).padStart(8, '0')}`,
    departmentId: rootDeptId,
    ...(password !== undefined ? { password } : {}),
  })
}

describe('login', () => {
  it('正确手机号+密码 → 返回可验 token', async () => {
    const emp = await newLoginEmployee('correct-horse-9')
    const { token } = await login(t.db, { phone: emp.phone, password: 'correct-horse-9' }, { secret: SECRET })
    const ctx = await ctxFromToken(t.db, token, SECRET)
    expect(ctx).toEqual({ tenantId: ownerCtx.tenantId, employeeId: emp.id })
  })

  it('密码错 / 手机号不存在 → 同一个 INVALID_CREDENTIALS(防枚举)', async () => {
    const emp = await newLoginEmployee('right-pass-123')
    await expect(login(t.db, { phone: emp.phone, password: 'wrong' }, { secret: SECRET })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
    await expect(login(t.db, { phone: '13000000000', password: 'x' }, { secret: SECRET })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
  })

  it('未开通登录(password_hash 为空)→ INVALID_CREDENTIALS', async () => {
    const emp = await newLoginEmployee() // 不传密码
    await expect(login(t.db, { phone: emp.phone, password: 'any' }, { secret: SECRET })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
  })

  it('离职员工 → EMPLOYEE_NOT_ACTIVE', async () => {
    const emp = await newLoginEmployee('leaver-pass-1')
    await markEmployeeLeft(t.db, ownerCtx, emp.id)
    await expect(login(t.db, { phone: emp.phone, password: 'leaver-pass-1' }, { secret: SECRET })).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_ACTIVE',
    })
  })

  it('同手机号存在于两个租户 → AMBIGUOUS_TENANT;显式 tenantId 可登录', async () => {
    const emp = await newLoginEmployee('dup-phone-pass')
    const other = await seedTenant(t.db, '撞号租户')
    await createEmployee(t.db, other.ownerCtx, {
      name: '同号',
      empNo: 'AUTH-DUP',
      phone: emp.phone, // 同手机号,另一租户(租户内唯一,跨租户允许)
      departmentId: other.rootDept.id,
      password: 'other-pass-999',
    })
    await expect(login(t.db, { phone: emp.phone, password: 'dup-phone-pass' }, { secret: SECRET })).rejects.toMatchObject(
      { code: 'AMBIGUOUS_TENANT' },
    )
    const { token } = await login(
      t.db,
      { phone: emp.phone, password: 'dup-phone-pass', tenantId: ownerCtx.tenantId },
      { secret: SECRET },
    )
    expect((await ctxFromToken(t.db, token, SECRET)).tenantId).toBe(ownerCtx.tenantId)
  })

  it('租户停用 → 登录与已发 token 都失效', async () => {
    const other = await seedTenant(t.db, '将停用租户')
    const emp = await createEmployee(t.db, other.ownerCtx, {
      name: '员工',
      empNo: 'SUSP-1',
      phone: '13211112222',
      departmentId: other.rootDept.id,
      password: 'susp-pass-123',
    })
    const { token } = await login(t.db, { phone: emp.phone, password: 'susp-pass-123' }, { secret: SECRET })
    await t.db.execute(sql`update tenants set status = 'suspended' where id = ${other.tenant.id}`)
    await expect(login(t.db, { phone: emp.phone, password: 'susp-pass-123' }, { secret: SECRET })).rejects.toMatchObject(
      { code: 'TENANT_SUSPENDED' },
    )
    await expect(ctxFromToken(t.db, token, SECRET)).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' }) // 复查生效
  })
})

describe('token', () => {
  it('篡改 payload 或签名 → TOKEN_INVALID', () => {
    const token = signToken({ employeeId: 'e', tenantId: 't' }, SECRET)
    const [body, sig] = token.split('.') as [string, string]
    const evil = Buffer.from(JSON.stringify({ employeeId: 'hacker', tenantId: 't', exp: 9999999999 })).toString(
      'base64url',
    )
    expect(() => verifyToken(evil + '.' + sig, SECRET)).toThrowError(AuthError)
    expect(() => verifyToken(body + '.' + 'x'.repeat(43), SECRET)).toThrowError(AuthError)
    expect(() => verifyToken(token, 'wrong-secret')).toThrowError(AuthError)
  })

  it('过期 token → TOKEN_EXPIRED', () => {
    const token = signToken({ employeeId: 'e', tenantId: 't' }, SECRET, -1) // 已过期
    expect(() => verifyToken(token, SECRET)).toThrowError(
      expect.objectContaining({ code: 'TOKEN_EXPIRED' }),
    )
  })

  it('员工不存在的合法签名 token → EMPLOYEE_NOT_ACTIVE', async () => {
    const token = signToken({ employeeId: randomUUID(), tenantId: ownerCtx.tenantId }, SECRET)
    await expect(ctxFromToken(t.db, token, SECRET)).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_ACTIVE' })
  })

  it('离职后已发 token 失效(ctxFromToken 复查)', async () => {
    const emp = await newLoginEmployee('leave-after-login')
    const { token } = await login(t.db, { phone: emp.phone, password: 'leave-after-login' }, { secret: SECRET })
    await markEmployeeLeft(t.db, ownerCtx, emp.id)
    await expect(ctxFromToken(t.db, token, SECRET)).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_ACTIVE' })
  })
})
