// server.ts — 服务入口。
// 生产:DATABASE_URL + AUTH_SECRET 环境变量(密钥不进代码库)。
// 演示:两者都不设 → PGlite 内存库 + seed 演示数据并启用自动登录。
import { serve } from '@hono/node-server'
import { createApp, syncAllPermissions } from './core/http/app'
import { createDatabase } from './core/db/connect'
import { DEMO_BOSS_PASSWORD, DEMO_BOSS_PHONE, seedDemo } from './seed/demo'
import { employees, tenants } from './core/org/model'
import { and, eq } from 'drizzle-orm'
import { reattachDemoAutopilot, seedPcbCamDemo } from './modules/pcb-cam/seed'
import { registerPcbCamJobs } from './modules/pcb-cam/automation'
import { startHeartbeat } from './core/license/heartbeat'
import { registerBackupJobs } from './core/backup/api'
import { startScheduler } from './core/scheduler'
import { registerTokenRevocationJobs } from './core/auth/token-revocation'
import { registerQrLoginJobs } from './core/auth/qr-login'
import type { Ctx } from './core/db/client'

const { db, mode } = await createDatabase()
await syncAllPermissions(db)

let demoCredentials: { phone: string; password: string } | undefined

let secret = process.env.AUTH_SECRET
if (!secret) {
  if (mode === 'postgres') throw new Error('AUTH_SECRET is required in production')
  secret = 'demo-only-secret-do-not-use-in-prod'
}

if (mode === 'demo') {
  const seeded = await seedDemo(db)
  demoCredentials = { phone: seeded.bossPhone, password: seeded.bossPassword }
  const ctx: Ctx = { tenantId: seeded.tenantId, employeeId: '', entityId: seeded.rootEntityId }
  const [boss] = await db.select({ id: employees.id }).from(employees)
    .where(and(eq(employees.tenantId, seeded.tenantId), eq(employees.phone, seeded.bossPhone), eq(employees.isDeleted, false))).limit(1)
  if (boss) {
    ctx.employeeId = boss.id
    await seedPcbCamDemo(db, ctx)
  }
  console.log('[demo] 内存库与自动登录已就绪')
} else if (process.env.SEED_DEMO === 'true') {
  const existing = await db.select({ id: tenants.id }).from(tenants).limit(1)
  if (existing.length === 0) {
    const seeded = await seedDemo(db)
    const [boss] = await db.select({ id: employees.id }).from(employees)
      .where(and(eq(employees.tenantId, seeded.tenantId), eq(employees.phone, seeded.bossPhone), eq(employees.isDeleted, false))).limit(1)
    if (boss) await seedPcbCamDemo(db, { tenantId: seeded.tenantId, employeeId: boss.id, entityId: seeded.rootEntityId })
    console.log('[seed-demo] 示例数据与管理员已创建')
  } else {
    console.log('[seed-demo] SEED_DEMO=true 但库中已有租户,跳过示例数据播种(避免重复/污染)')
  }
}

if (mode === 'postgres' && process.env.DEMO_LOGIN === 'true') {
  demoCredentials = { phone: DEMO_BOSS_PHONE, password: DEMO_BOSS_PASSWORD }
  const [boss] = await db.select({ id: employees.id, tenantId: employees.tenantId }).from(employees)
    .where(and(eq(employees.phone, DEMO_BOSS_PHONE), eq(employees.isDeleted, false))).limit(1)
  if (boss) {
    const n = await reattachDemoAutopilot(db, { tenantId: boss.tenantId, employeeId: boss.id })
    console.log(`[demo-login] 已启用 /api/auth/demo-login(本机持久库);演示自动驾驶重新登记 ${n} 个任务`)
  } else {
    console.warn('[demo-login] DEMO_LOGIN=true 但库里没有演示老板(先用空库 + SEED_DEMO=true 起一次)')
  }
}

const app = createApp(db, { secret, ...(demoCredentials ? { demoCredentials } : {}) })
startHeartbeat()
registerTokenRevocationJobs()
registerQrLoginJobs()
registerPcbCamJobs()
registerBackupJobs()
startScheduler(db)

const port = Number(process.env.PORT ?? 3005)
serve({ fetch: app.fetch, port })
console.log(`[server] listening on http://localhost:${port} (${mode})`)
