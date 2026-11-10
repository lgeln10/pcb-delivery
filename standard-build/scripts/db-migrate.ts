// scripts/db-migrate.ts
// 对生产库应用所有未执行的 drizzle 迁移。部署时在重启后端之前执行,迁移失败即中止部署。
//
// 用法:npm run db:migrate
// DATABASE_URL 可由 shell 注入,也可写在项目根 .env / .env.local。
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadEnvFile(path: string) {
  if (!existsSync(path)) return
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
    process.env[key] = value
  }
}

loadEnvFile(resolve(ROOT, '.env'))
loadEnvFile(resolve(ROOT, '.env.local'))

const url = process.env.DATABASE_URL
if (!url) {
  console.error('✗ DATABASE_URL 未设置,无法迁移。请在 .env/.env.local 中配置或由 shell 注入。')
  process.exit(1)
}

const MIGRATIONS = resolve(ROOT, 'core/db/migrations')
const db = drizzle(url)
await migrate(db, { migrationsFolder: MIGRATIONS })

// 生产库偶发出现过 drizzle journal 已记录迁移、但真实表结构缺列的漂移。
// 这里放最小幂等兜底:不替代正式迁移,只确保已进入模型的关键列一定存在。
await db.execute(sql`ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "position" text`)
await db.execute(sql`UPDATE "employees" SET "position" = '' WHERE "position" IS NULL`)
await db.execute(sql`ALTER TABLE "employees" ALTER COLUMN "position" SET DEFAULT ''`)
await db.execute(sql`ALTER TABLE "employees" ALTER COLUMN "position" SET NOT NULL`)
await db.execute(sql`ALTER TABLE "hr_profiles" ADD COLUMN IF NOT EXISTS "residence_place" text`)
await db.execute(sql`ALTER TABLE "hr_profiles" ADD COLUMN IF NOT EXISTS "political_status" text`)
await db.execute(sql`ALTER TABLE "hr_profiles" ADD COLUMN IF NOT EXISTS "skill_certificates" text`)
await db.execute(sql`ALTER TABLE "hr_profiles" ADD COLUMN IF NOT EXISTS "strengths" text`)
await db.execute(sql`ALTER TABLE "approval_instances" ADD COLUMN IF NOT EXISTS "approver_id" uuid`)
await db.execute(sql`ALTER TABLE "approval_instances" ADD COLUMN IF NOT EXISTS "context" jsonb`)
// feedback 附件列:防 0026/00NN_feedback_attachments 的 journal when 低于后到的迁移被 drizzle 漏跑 → 幂等兜底。
await db.execute(sql`ALTER TABLE "feature_requests" ADD COLUMN IF NOT EXISTS "attachments" jsonb`)
await db.execute(sql`
  CREATE TABLE IF NOT EXISTS "bank_statement_import_mappings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "created_by" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_by" uuid,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "is_deleted" boolean NOT NULL DEFAULT false,
    "deleted_at" timestamptz,
    "entity_id" uuid NOT NULL,
    "name" text NOT NULL,
    "module" text NOT NULL DEFAULT 'bank_statement',
    "header_signature" text NOT NULL,
    "header_row_index" integer NOT NULL DEFAULT 0,
    "data_start_row_index" integer NOT NULL DEFAULT 1,
    "mapping" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "enabled" boolean NOT NULL DEFAULT true
  )
`)
await db.execute(sql`CREATE INDEX IF NOT EXISTS "bank_statement_import_mappings_tenant_idx" ON "bank_statement_import_mappings" ("tenant_id", "entity_id", "enabled")`)
await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "bank_statement_import_mappings_name_uq" ON "bank_statement_import_mappings" ("tenant_id", "entity_id", "name") WHERE "is_deleted" = false`)

console.log('✓ 数据库迁移已应用,结构兜底检查已完成')
process.exit(0)
