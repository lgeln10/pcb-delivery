// 员工登录爆破防护(core/auth/throttle.ts + routes.ts 接线)。
//
// ★设计判据(playbooks/security §3.7):任何「锁定」类防护,先问被误锁的人还有没有别的路进来。
//   所以账号维度**永不锁定**(只退避封顶 5 秒)—— 攻击者只凭用户名 + 持续猜错,
//   不能把真管理员从**另一台机器**挡在门外。这条性质在下面有专门断言。
// ★测试全部用注入时钟,不 sleep(§3.5:测试里每一处 sleep 都要能说出它绕开的是什么)。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Hono } from 'hono'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { createEmployee } from '../../org/logic/employee'
import { mapError } from '../../http/errors'
import { authRoutes } from '../routes'
import { AuthError } from '../errors'
import {
  createLoginThrottle,
  LOGIN_BACKOFF_CAP_MS,
  LOGIN_COMBO_MAX_FAILURES,
  LOGIN_IP_MAX_FAILURES,
  LOGIN_LOCK_MS,
} from '../throttle'

function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

/** 收集 gate 实际要求的退避时长,不真等。 */
function makeThrottle(clock = fakeClock()) {
  const delays: number[] = []
  const throttle = createLoginThrottle({ now: clock.now, sleep: async (ms) => void delays.push(ms) })
  return { throttle, delays, clock }
}

describe('登录失败退避与锁定(纯逻辑,注入时钟)', () => {
  it('(账号, IP) 组合:5 次失败锁定;窗口过后自动解锁', async () => {
    const { throttle, clock } = makeThrottle()
    for (let i = 0; i < LOGIN_COMBO_MAX_FAILURES; i++) throttle.recordFailure('13800000001', '1.1.1.1')
    await expect(throttle.gate('13800000001', '1.1.1.1')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })
    clock.advance(LOGIN_LOCK_MS + 1)
    await expect(throttle.gate('13800000001', '1.1.1.1')).resolves.toBeUndefined()
  })

  it('★被锁的是那台机器,不是账号:同账号换 IP 仍能进(管理员的活路)', async () => {
    const { throttle } = makeThrottle()
    for (let i = 0; i < 100; i++) throttle.recordFailure('13800000001', '6.6.6.6') // 攻击者从一台机器猛打
    await expect(throttle.gate('13800000001', '6.6.6.6')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })
    // 真管理员换台机器:不锁,只有账号维退避,且封顶
    const delays: number[] = []
    const t2 = createLoginThrottle({ now: () => 1_000_000, sleep: async (ms) => void delays.push(ms) })
    for (let i = 0; i < 100; i++) t2.recordFailure('13800000001', '6.6.6.6')
    await expect(t2.gate('13800000001', '7.7.7.7')).resolves.toBeUndefined()
    expect(delays.length).toBe(1)
    expect(delays[0]).toBeLessThanOrEqual(LOGIN_BACKOFF_CAP_MS)
  })

  it('IP 维度:换着账号猜同一台机器,到阈值一样锁', async () => {
    const { throttle } = makeThrottle()
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i++) throttle.recordFailure(`user-${i}`, '2.2.2.2')
    await expect(throttle.gate('从没试过的账号', '2.2.2.2')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })
  })

  it('账号维度退避:倍增、封顶、永不抛;成功后归零', async () => {
    const { throttle, delays } = makeThrottle()
    // 分布式猜解:每次换 IP,组合/IP 维永远到不了阈值
    for (let i = 0; i < 20; i++) throttle.recordFailure('13800000002', `9.9.9.${i}`)
    await expect(throttle.gate('13800000002', '8.8.8.8')).resolves.toBeUndefined()
    expect(delays[delays.length - 1]).toBe(LOGIN_BACKOFF_CAP_MS)
    throttle.clearFailures('13800000002', '8.8.8.8')
    delays.length = 0
    await throttle.gate('13800000002', '8.8.8.8')
    expect(delays).toEqual([]) // 清过就不再退避
  })

  it('拿不到可信 IP(null):只退避,永不锁定 —— 伪造头不能把别人锁在门外', async () => {
    const { throttle } = makeThrottle()
    for (let i = 0; i < 100; i++) throttle.recordFailure('13800000003', null)
    await expect(throttle.gate('13800000003', null)).resolves.toBeUndefined()
  })

  it('成功不清 IP 维:攻击者夹带一次成功,IP 的账本不归零', async () => {
    const { throttle } = makeThrottle()
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES - 1; i++) throttle.recordFailure(`u${i}`, '3.3.3.3')
    throttle.clearFailures('自己的号', '3.3.3.3') // 模拟登录成功
    throttle.recordFailure('u-last', '3.3.3.3')
    await expect(throttle.gate('任意', '3.3.3.3')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })
  })
})

describe('登录路由接线(真 HTTP 形状)', () => {
  let t: OrgTestDb
  let phone: string
  const PASSWORD = 'right-password-1'

  beforeAll(async () => {
    t = await createOrgTestDb()
    const seeded = await seedTenant(t.db)
    phone = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    await createEmployee(t.db, seeded.ownerCtx, {
      name: '退避测试员工',
      empNo: 'THROTTLE-1',
      phone,
      departmentId: seeded.rootDept.id,
      password: PASSWORD,
    })
  })
  afterAll(() => t.close())

  function app() {
    // 每个用例独立 throttle 实例(authRoutes 每次调用各建一份,天然隔离);sleep 打桩不真等。
    // onError 走真 mapError —— 断言的就是线上会回出去的状态码,不是框架默认 500。
    return new Hono()
      .onError((err, c) => {
        const { status, body } = mapError(err)
        return c.json(body, status)
      })
      .route(
        '/api/auth',
        authRoutes(t.db, 'test-secret', undefined, {
          throttle: createLoginThrottle({ sleep: async () => {} }),
        }),
      )
  }
  const attempt = (a: Hono, password: string, ip = '5.5.5.5') =>
    a.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ phone, password }),
    })

  it('猜错 5 次 → 第 6 次即使口令正确也 429;换 IP 用正确口令立刻能进', async () => {
    const a = app()
    for (let i = 0; i < LOGIN_COMBO_MAX_FAILURES; i++) {
      expect((await attempt(a, `wrong-${i}`)).status).toBe(401)
    }
    const locked = await attempt(a, PASSWORD)
    expect(locked.status).toBe(429)
    const other = await attempt(a, PASSWORD, '5.5.5.6')
    expect(other.status).toBe(200)
    expect(((await other.json()) as { token?: string }).token).toBeTruthy()
  })

  it('★反向测试:正常登录一次成功,不被任何维度误伤(限流最怕的是天天误报)', async () => {
    const a = app()
    const res = await attempt(a, PASSWORD, '5.5.5.7')
    expect(res.status).toBe(200)
  })

  it('伪造 XFF 前缀不能换桶:限流键取最后一跳', async () => {
    const a = app()
    for (let i = 0; i < LOGIN_COMBO_MAX_FAILURES; i++) {
      // 每次换一个假前缀,末跳(反代写的那跳)不变 —— 必须仍算同一个桶
      expect((await attempt(a, 'wrong', `fake-${i}, 5.5.5.8`)).status).toBe(401)
    }
    expect((await attempt(a, PASSWORD, 'another-fake, 5.5.5.8')).status).toBe(429)
  })

  it('AuthError 形状:TOO_MANY_ATTEMPTS 在 AuthError 的码表里(mapError 才能给 429)', () => {
    expect(new AuthError('TOO_MANY_ATTEMPTS', 'x').code).toBe('TOO_MANY_ATTEMPTS')
  })
})
