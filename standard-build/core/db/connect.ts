// core/db/connect.ts
// 数据库连接工厂(服务入口用;测试直接用 test-helpers 的 PGlite)。
// - DATABASE_URL 已设 → node-postgres 连真库(生产)
// - 未设 → 进程内 PGlite + 跑迁移 + 灌 seed 演示数据(★fork 下来 npm run dev 即起可演示)
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { Db } from './client'

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), './migrations')

export async function createDatabase(): Promise<{ db: Db; mode: 'postgres' | 'demo' }> {
  const url = process.env.DATABASE_URL
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    const db = drizzle(url) as unknown as Db
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS })
    return { db, mode: 'postgres' }
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  const raw = new PGlite()
  const db = drizzle(raw) as unknown as Db
  await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: MIGRATIONS })
  return { db, mode: 'demo' }
}
