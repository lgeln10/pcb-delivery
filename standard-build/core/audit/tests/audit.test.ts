// core/audit/tests/audit.test.ts
// 审计不变量:脱敏(绝不记密钥)、租户隔离、倒序游标分页、写入即可查。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import type { Ctx } from '../../db/client'
import { listAudit, recordAudit, sanitizeDetail } from '../logic'

let t: OrgTestDb
let ctxA: Ctx
let ctxB: Ctx

beforeAll(async () => {
  t = await createOrgTestDb()
  ctxA = (await seedTenant(t.db, 'A 公司')).ownerCtx
  ctxB = (await seedTenant(t.db, 'B 公司')).ownerCtx
})
afterAll(async () => t.close())

describe('系统审计', () => {
  it('脱敏:含 password/token/secret 的键不入库', () => {
    const cleaned = sanitizeDetail({ phone: '138', password: 'p', nested: { token: 't', ok: 1 }, list: [{ secret: 's', v: 2 }] }) as any
    expect(cleaned.phone).toBe('138')
    expect(cleaned.password).toBeUndefined()
    expect(cleaned.nested.token).toBeUndefined()
    expect(cleaned.nested.ok).toBe(1)
    expect(cleaned.list[0].secret).toBeUndefined()
    expect(cleaned.list[0].v).toBe(2)
  })

  it('写入即可查;detail 已脱敏', async () => {
    await recordAudit(t.db, {
      tenantId: ctxA.tenantId,
      actorEmployeeId: ctxA.employeeId,
      actorName: '王老板',
      action: 'POST /api/org/roles/:id/permissions',
      targetId: ctxA.employeeId,
      detail: { permCode: 'finance:view', password: 'should-not-store' },
      source: 'http',
      result: 'success',
    })
    const res = await listAudit(t.db, ctxA, { limit: 50 })
    expect(res.items.length).toBe(1)
    expect(res.items[0]!.actorName).toBe('王老板')
    expect(JSON.stringify(res.items[0]!.detail)).toContain('finance:view')
    expect(JSON.stringify(res.items[0]!.detail)).not.toContain('password')
  })

  it('租户隔离:A 看不到 B 的审计', async () => {
    await recordAudit(t.db, { tenantId: ctxB.tenantId, actorEmployeeId: ctxB.employeeId, action: 'DELETE /api/partners/:id', source: 'http', result: 'success' })
    const a = await listAudit(t.db, ctxA, { limit: 50 })
    const b = await listAudit(t.db, ctxB, { limit: 50 })
    expect(a.items.every((x) => x.tenantId === ctxA.tenantId)).toBe(true)
    expect(b.items.every((x) => x.tenantId === ctxB.tenantId)).toBe(true)
    expect(b.items.some((x) => x.action.includes('DELETE'))).toBe(true)
  })

  it('按动作过滤 + 失败结果可查', async () => {
    await recordAudit(t.db, { tenantId: ctxA.tenantId, actorEmployeeId: ctxA.employeeId, action: 'POST /api/finance/vouchers', source: 'http', result: 'failed' })
    const failed = await listAudit(t.db, ctxA, { result: 'failed', limit: 50 })
    expect(failed.items.length).toBeGreaterThan(0)
    expect(failed.items.every((x) => x.result === 'failed')).toBe(true)
    const byAction = await listAudit(t.db, ctxA, { action: 'finance', limit: 50 })
    expect(byAction.items.every((x) => x.action.includes('finance'))).toBe(true)
  })
})
