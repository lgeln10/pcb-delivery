// core/auth/routes.ts — 唯一的公开(免 token)路由:登录。
// 响应永不包含 password_hash。
// ★爆破防护(core/auth/throttle.ts):锁定查在 bcrypt 之前;只有 INVALID_CREDENTIALS 计失败
//   (口令对了但离职/租户停用,不是在猜口令);成功清 (账号,IP) 与账号维,IP 维不清。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client'
import { clientIpOf } from '../http/client-ip'
import { AuthError } from './errors'
import { login } from './login'
import { createLoginThrottle, type LoginThrottle } from './throttle'

const LoginBody = z.object({
  phone: z.string().min(1),
  password: z.string().min(1),
  tenantId: z.uuid().optional(),
})

export function authRoutes(
  db: Db,
  secret: string,
  demoCredentials?: { phone: string; password: string },
  opts: { throttle?: LoginThrottle } = {},
) {
  const throttle = opts.throttle ?? createLoginThrottle()
  const routes = new Hono().post('/login', async (c) => {
    const body = LoginBody.parse(await c.req.json())
    const ip = clientIpOf(c)
    await throttle.gate(body.phone, ip) // 锁定 → 429;退避 → 这里等
    try {
      const { token, employee } = await login(db, body, { secret })
      throttle.clearFailures(body.phone, ip)
      return c.json({
        token,
        employee: { id: employee.id, name: employee.name, tenantId: employee.tenantId, phone: employee.phone },
      })
    } catch (err) {
      if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') throttle.recordFailure(body.phone, ip)
      throw err
    }
  })

  if (demoCredentials) {
    routes.post('/demo-login', async (c) => {
      const { token, employee } = await login(db, demoCredentials, { secret })
      return c.json({
        token,
        employee: { id: employee.id, name: employee.name, tenantId: employee.tenantId, phone: employee.phone },
      })
    })
  }

  return routes
}
