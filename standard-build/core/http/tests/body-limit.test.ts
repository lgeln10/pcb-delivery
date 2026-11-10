// 请求体大小闸:zod 限长在解析之后,没有这道闸就能收任意大的 JSON。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'

let t: OrgTestDb
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  t = await createOrgTestDb()
  await seedTenant(t.db)
  app = createApp(t.db, { secret: 'test-secret' })
})
afterAll(() => t.close())

describe('请求体大小闸', () => {
  it('正常大小的登录请求不被这层拦', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800000001', password: 'demo-pass-123' }),
    })
    expect(res.status).not.toBe(413)
  })
})
