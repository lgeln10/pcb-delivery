// SixAM 智能云账户代理(core/llm/billing.ts):
// - 未配 sixam key → LLM_NOT_CONFIGURED(不发任何上游请求)
// - 配了 key(env 兜底)→ 带 Bearer 打中转 /account,JSON 原样返回
// - 中转回 401 → 归为 LLM_NOT_CONFIGURED(key 无效),不是笼统的「上游错误」
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { billingAccount } from '../billing'
import { LLM_PROVIDERS } from '../providers'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ctx: Ctx
const savedKey = process.env.SIXAM_API_KEY

beforeEach(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db)).ownerCtx
})
afterEach(async () => {
  if (savedKey === undefined) delete process.env.SIXAM_API_KEY
  else process.env.SIXAM_API_KEY = savedKey
  vi.restoreAllMocks()
  await t.close()
})

describe('SixAM 账户代理', () => {
  it('未配 key → LLM_NOT_CONFIGURED,且不发上游请求', async () => {
    delete process.env.SIXAM_API_KEY
    const spy = vi.spyOn(globalThis, 'fetch')
    await expect(billingAccount(t.db, ctx)).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('env key 兜底生效 → 带 Bearer 打中转 /account,JSON 原样返回', async () => {
    process.env.SIXAM_API_KEY = 'sk-sixam-test'
    const payload = { customer_id: 'c1', balance_yuan: '12.3456' }
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    await expect(billingAccount(t.db, ctx)).resolves.toEqual(payload)
    const [url, init] = spy.mock.calls[0]!
    expect(String(url)).toBe(LLM_PROVIDERS.sixam.baseURL + '/account')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-sixam-test')
  })

  it('中转回 401(key 无效/停用)→ 归为 LLM_NOT_CONFIGURED', async () => {
    process.env.SIXAM_API_KEY = 'sk-sixam-revoked'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(billingAccount(t.db, ctx)).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' })
  })
})
