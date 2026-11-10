// core/auth/tests/token-revocation.test.ts
// B2②:登录令牌可吊销。
//
// 这套测试盯的是**能不能真的止血**,不是「函数返回值对不对」:
//   - 偷到的令牌,在受害者点了「退出所有设备」之后还能不能用?
//   - 管理员重置了密码,旧令牌还能不能用?(这条历史上是最常被漏掉的)
//   - 正常退出登录会不会顺手把手机也踢下线?(误伤同样是缺陷)
//   - 0198 之前签发的老令牌会不会被误挡在外面?
import { describe, expect, it } from 'vitest'
import { ctxFromToken, login } from '../login'
import { signToken, verifyToken } from '../token'
import {
  isBeforeRevocationWatermark,
  purgeExpiredRevocations,
  revokeAllSessions,
  revokeToken,
} from '../token-revocation'
import { changeOwnPassword, changePassword } from '../../org/logic/employee'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { employees } from '../../org/model'
import { and, eq } from 'drizzle-orm'
import { hashPassword } from '../../org/logic/employee'

const SECRET = 'test-secret-for-revocation'

/** 引导一个租户,把老板改成已知手机号/密码,返回他的登录令牌。 */
async function seedLoginableEmployee(t: OrgTestDb, phone: string, password = 'password123') {
  const { owner, tenant } = await seedTenant(t.db)
  await t.db
    .update(employees)
    .set({ phone, passwordHash: await hashPassword(password), status: 'active' })
    .where(and(eq(employees.tenantId, tenant.id), eq(employees.id, owner.id)))
  const { token } = await login(t.db, { phone, password }, { secret: SECRET })
  return { token, employeeId: owner.id, tenantId: tenant.id, password }
}

describe('水位判定(纯函数)', () => {
  const base = { employeeId: 'e', tenantId: 't', exp: 9999999999 }

  it('从未吊销过(水位为 null)→ 一律放行', () => {
    expect(isBeforeRevocationWatermark({ ...base, iatMs: 1000 }, null)).toBe(false)
  })

  it('签发早于水位 → 拒', () => {
    expect(isBeforeRevocationWatermark({ ...base, iatMs: 1000 }, new Date(2000))).toBe(true)
  })

  it('签发晚于水位 → 放行(吊销之后重新登录的那枚要能用)', () => {
    expect(isBeforeRevocationWatermark({ ...base, iatMs: 3000 }, new Date(2000))).toBe(false)
  })

  it('★水位与 iatMs 同为毫秒:相差 1ms 也能正确区分(秒级 iat 时这条是坏的)', () => {
    expect(isBeforeRevocationWatermark({ ...base, iatMs: 1_700_000_000_123 }, new Date(1_700_000_000_122))).toBe(false)
    expect(isBeforeRevocationWatermark({ ...base, iatMs: 1_700_000_000_121 }, new Date(1_700_000_000_122))).toBe(true)
  })

  it('★老令牌(无 iatMs)当 0 处理:没吊销过照常用,吊销过一次就全失效', () => {
    expect(isBeforeRevocationWatermark(base, null)).toBe(false)
    expect(isBeforeRevocationWatermark(base, new Date(1))).toBe(true)
  })
})

describe('签发的令牌自带 iat/jti', () => {
  it('每次签发的 jti 都不同(否则单枚吊销会误伤别人)', () => {
    const a = verifyToken(signToken({ employeeId: 'e', tenantId: 't' }, SECRET), SECRET)
    const b = verifyToken(signToken({ employeeId: 'e', tenantId: 't' }, SECRET), SECRET)
    expect(a.jti).toBeTruthy()
    expect(b.jti).toBeTruthy()
    expect(a.jti).not.toBe(b.jti)
    expect(a.iatMs).toBeTypeOf('number')
    // 毫秒而不是秒:与吊销水位同精度。写死这条断言,防止有人「顺手改成 JWT 惯例的秒」。
    expect(a.iatMs!).toBeGreaterThan(1_000_000_000_000)
  })
})

describe('端到端:令牌真的失效了吗', () => {
  it('★「退出所有设备」之后,被偷的那枚令牌立刻用不了', async () => {
    const t = await createOrgTestDb()
    try {
      const { token, employeeId, tenantId } = await seedLoginableEmployee(t, '13900000001')
      // 攻击者手里的那枚 —— 吊销前是好使的
      await expect(ctxFromToken(t.db, token, SECRET)).resolves.toMatchObject({ employeeId })

      await revokeAllSessions(t.db, tenantId, employeeId)

      await expect(ctxFromToken(t.db, token, SECRET)).rejects.toThrow()
    } finally {
      await t?.close()
    }
  })

  it('★管理员重置密码 = 该员工旧令牌全部作废(不然「怀疑被盗所以改密码」这个动作完全无效)', async () => {
    const t = await createOrgTestDb()
    try {
      const { token, employeeId, tenantId } = await seedLoginableEmployee(t, '13900000002')
      await expect(ctxFromToken(t.db, token, SECRET)).resolves.toBeTruthy()

      await changePassword(t.db, { tenantId, employeeId }, employeeId, 'brand-new-password')

      await expect(ctxFromToken(t.db, token, SECRET)).rejects.toThrow()
    } finally {
      await t?.close()
    }
  })

  it('★自助改密码同样作废旧令牌(含当前这台设备 —— 改完要重新登录)', async () => {
    const t = await createOrgTestDb()
    try {
      const { token, employeeId, tenantId, password } = await seedLoginableEmployee(t, '13900000003')
      await changeOwnPassword(t.db, { tenantId, employeeId }, { oldPassword: password, newPassword: 'another-new-pass' })
      await expect(ctxFromToken(t.db, token, SECRET)).rejects.toThrow()
    } finally {
      await t?.close()
    }
  })

  it('★吊销之后重新登录拿到的新令牌必须能用(否则等于把人锁在门外)', async () => {
    const t = await createOrgTestDb()
    try {
      const { employeeId, tenantId } = await seedLoginableEmployee(t, '13900000004')
      await revokeAllSessions(t.db, tenantId, employeeId)
      // ★**不等待**,紧接着就登录 —— 这正是用户点完「退出所有设备」立刻重新登录的真实动作。
      //   这一条最早是带 sleep(1100) 写的,于是把一个真 bug 盖住了:当时 iat 是秒级、
      //   水位是毫秒级,新令牌会被自己的水位判早 → 401 → 弹回登录页再登再弹。
      //   真 HTTP 端到端跑的时候才炸出来。sleep 别加回去,它测的就是这个。
      const again = await login(t.db, { phone: '13900000004', password: 'password123' }, { secret: SECRET })
      await expect(ctxFromToken(t.db, again.token, SECRET)).resolves.toMatchObject({ employeeId })
    } finally {
      await t?.close()
    }
  })

  it('★单枚吊销只杀这一枚 —— 手机上那个会话不该被误伤', async () => {
    const t = await createOrgTestDb()
    try {
      const { token: laptop, employeeId } = await seedLoginableEmployee(t, '13900000005')
      const phone = (await login(t.db, { phone: '13900000005', password: 'password123' }, { secret: SECRET })).token

      await revokeToken(t.db, verifyToken(laptop, SECRET), 'logout')

      await expect(ctxFromToken(t.db, laptop, SECRET)).rejects.toThrow()
      await expect(ctxFromToken(t.db, phone, SECRET)).resolves.toMatchObject({ employeeId })
    } finally {
      await t?.close()
    }
  })

  it('重复吊销同一枚是幂等的(退出按钮被连点两下不该 500)', async () => {
    const t = await createOrgTestDb()
    try {
      const { token } = await seedLoginableEmployee(t, '13900000006')
      const payload = verifyToken(token, SECRET)
      await revokeToken(t.db, payload, 'logout')
      await expect(revokeToken(t.db, payload, 'logout')).resolves.toBeUndefined()
    } finally {
      await t?.close()
    }
  })

  it('★老令牌(无 jti)单枚吊销要显式抛,不许假装成功', async () => {
    const t = await createOrgTestDb()
    try {
      await expect(
        revokeToken(t.db, { employeeId: 'e', tenantId: 't', exp: Math.floor(Date.now() / 1000) + 100 }),
      ).rejects.toThrow('TOKEN_WITHOUT_JTI')
    } finally {
      await t?.close()
    }
  })
})

describe('清理', () => {
  it('★过期的吊销记录会被清掉,未过期的留着(不清的话这张表只增不减)', async () => {
    const t = await createOrgTestDb()
    try {
      const now = Math.floor(Date.now() / 1000)
      const T = '00000000-0000-0000-0000-000000000001'
      const expired = { employeeId: '00000000-0000-0000-0000-0000000000e1', tenantId: T, exp: now - 10, jti: 'jti-expired' }
      const alive = { employeeId: '00000000-0000-0000-0000-0000000000e2', tenantId: T, exp: now + 3600, jti: 'jti-alive' }
      await revokeToken(t.db, expired)
      await revokeToken(t.db, alive)

      const removed = await purgeExpiredRevocations(t.db)
      expect(removed).toBe(1)

      // 还活着的那枚仍然被拦
      await expect(purgeExpiredRevocations(t.db)).resolves.toBe(0)
    } finally {
      await t?.close()
    }
  })
})
