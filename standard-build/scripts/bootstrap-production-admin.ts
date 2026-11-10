// scripts/bootstrap-production-admin.ts
// Production-only first-run bootstrap. It creates the first tenant/admin only
// when the production database is empty; existing tenants are never modified.
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { bootstrapTenant } from '../core/org/logic/bootstrap'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = resolve(ROOT, '.env')

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

function ensureEnvValue(key: string, value: string) {
  process.env[key] = value
  if (!existsSync(ENV_FILE)) return
  const current = readFileSync(ENV_FILE, 'utf8')
  if (new RegExp(`^${key}=`, 'm').test(current)) return
  appendFileSync(ENV_FILE, `\n${key}=${value}\n`)
}

function generatedPassword() {
  return `Admin-${randomBytes(12).toString('base64url')}`
}

loadEnvFile(ENV_FILE)
loadEnvFile(resolve(ROOT, '.env.local'))

const url = process.env.DATABASE_URL
if (!url) {
  console.error('✗ DATABASE_URL 未设置,无法初始化生产管理员。')
  process.exit(1)
}

const tenantName = process.env.BOOTSTRAP_TENANT_NAME || '默认企业'
const adminName = process.env.BOOTSTRAP_ADMIN_NAME || '管理员'
const adminEmpNo = process.env.BOOTSTRAP_ADMIN_EMP_NO || 'ADMIN'
const adminPhone = process.env.BOOTSTRAP_ADMIN_PHONE || '13800000001'

const pool = new Pool({ connectionString: url })
const db = drizzle(pool)

try {
  const countResult = (await db.execute(sql`select count(*)::int as count from tenants where is_deleted = false`)) as {
    rows: { count: number }[]
  }
  const tenantCount = Number(countResult.rows[0]?.count ?? 0)
  if (tenantCount > 0) {
    console.log(`✓ 已存在 ${tenantCount} 个租户,跳过生产管理员初始化`)
  } else {
    const configuredPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD
    const adminPassword = configuredPassword || generatedPassword()

    if (!configuredPassword) {
      ensureEnvValue('BOOTSTRAP_ADMIN_PASSWORD', adminPassword)
    }

    await bootstrapTenant(db as Parameters<typeof bootstrapTenant>[0], {
      tenantName,
      rootDeptName: tenantName,
      owner: {
        name: adminName,
        empNo: adminEmpNo,
        phone: adminPhone,
        password: adminPassword,
      },
    })

    console.log('✓ 生产管理员已初始化')
    console.log(`  租户: ${tenantName}`)
    console.log(`  账号: ${adminPhone}`)
    if (!configuredPassword) {
      console.log(`  初始密码: ${adminPassword}（已写入 .env 的 BOOTSTRAP_ADMIN_PASSWORD）`)
    } else {
      console.log('  初始密码: 使用 .env 中的 BOOTSTRAP_ADMIN_PASSWORD')
    }
  }
} finally {
  await pool.end()
}
