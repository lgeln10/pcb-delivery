// seed 烟测:空库跑 seedDemo 后,老板和工程员都能登录。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, type OrgTestDb } from '../core/org/tests/helpers'
import { seedDemo } from './demo'
import { login } from '../core/auth/login'

let t: OrgTestDb
let seeded: Awaited<ReturnType<typeof seedDemo>>

beforeAll(async () => {
  t = await createOrgTestDb()
  seeded = await seedDemo(t.db)
})
afterAll(async () => {
  await t.close()
})

describe('seed 演示数据', () => {
  it('老板可登录', async () => {
    const { token, employee } = await login(
      t.db,
      { phone: seeded.bossPhone, password: seeded.bossPassword },
      { secret: 'seed-test-secret' },
    )
    expect(token).toBeTruthy()
    expect(employee.name).toBe('王老板')
    expect(employee.tenantId).toBe(seeded.tenantId)
  })

  it('工程员可登录', async () => {
    const eng = await login(t.db, { phone: '13800000002', password: 'demo-pass-123' }, { secret: 'seed-test-secret' })
    expect(eng.employee.name).toBe('小张')
  })
})
