// scripts/mint-svc-token.ts
// 签发一个受限服务令牌(svc_…)，给 getdeployed agent 反向回调本 AIOS 用。
// 原文只打印一次，请立刻保存到 getdeployed agent 的配置(勿入库/勿提交)。
//
// 用法：
//   npm run mint:svc-token -- --tenant <tenantId> --employee <serviceEmployeeId> \
//        --name "getdeployed AR agent" --scopes finance:view,partner:view,partner:edit
//
// 说明：
//   --tenant    必填。令牌所属租户。
//   --employee  必填。令牌背靠的真实员工，必须是「最小权限的服务账号」：
//               不能是租户 owner 或超管(签发会被拒)。它决定令牌的数据可见范围，
//               所以请先在该租户建一个专用服务账号，只授予 agent 所需的最小角色。
//   --name      必填。便于在列表里识别/吊销。
//   --scopes    逗号分隔的权限码白名单(或 '*')。令牌能做什么由它封顶。
//               AR/通知类 agent 的常见组合：finance:view,partner:view,partner:edit
//   DATABASE_URL 由 shell 注入或写在 .env/.env.local。
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { mintServiceToken } from '../core/auth/service-token'

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
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
loadEnvFile(resolve(ROOT, '.env'))
loadEnvFile(resolve(ROOT, '.env.local'))

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const tenantId = arg('tenant')
const name = arg('name')
const scopesRaw = arg('scopes')
const employeeId = arg('employee')

if (!tenantId || !name || !scopesRaw || !employeeId) {
  console.error('✗ 缺少参数。用法：npm run mint:svc-token -- --tenant <id> --employee <serviceEmployeeId> --name "<label>" --scopes a,b,c')
  console.error('  --employee 必须是最小权限的服务账号(非 owner/超管)。')
  process.exit(1)
}
const scopes = scopesRaw.split(',').map((s) => s.trim()).filter(Boolean)
if (!scopes.length) {
  console.error('✗ --scopes 不能为空(逗号分隔的权限码，或 "*")')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('✗ DATABASE_URL 未设置。')
  process.exit(1)
}

const db = drizzle(url)

// mintServiceToken 会校验 employeeId 在职且非 owner/超管，否则抛错。
const { id, rawKey } = await mintServiceToken(db, { tenantId, employeeId }, { name, scopes, employeeId })

console.log('✓ 服务令牌已签发（原文仅此一次，请立即保存）：')
console.log('  id     :', id)
console.log('  name   :', name)
console.log('  scopes :', scopes.join(', '))
console.log('  token  :', rawKey)
console.log('\n把 token 填进 getdeployed agent 的回调配置(作为 Authorization: Bearer)。')
process.exit(0)
