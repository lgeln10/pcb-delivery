// scripts/license-issue.mjs — 用私钥签发一张 license(厂商侧)。
// 用法:
//   node scripts/license-issue.mjs --customer "客户名" --seats 50 --days 365 [--grace 7] [--key license-private.pem] [--out license.key]
import { sign as cryptoSign, createPrivateKey, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const customer = arg('customer')
const seats = Number(arg('seats'))
const days = Number(arg('days'))
if (!customer || !Number.isFinite(seats) || !Number.isFinite(days)) {
  console.error('用法: node scripts/license-issue.mjs --customer "客户名" --seats 50 --days 365 [--grace 7] [--key license-private.pem] [--out license.key]')
  process.exit(1)
}
const graceDays = Number(arg('grace', '7'))
const keyPath = arg('key', 'license-private.pem')
const outPath = arg('out', 'license.key')

const now = new Date()
const expires = new Date(now.getTime() + days * 86_400_000)
const payload = {
  v: 1,
  licenseId: randomUUID(),
  customer,
  seats,
  issuedAt: now.toISOString(),
  expiresAt: expires.toISOString(),
  graceDays,
}

const privateKey = createPrivateKey(readFileSync(keyPath))
const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8')
const sig = cryptoSign(null, payloadBuf, privateKey)
const license = `${payloadBuf.toString('base64url')}.${sig.toString('base64url')}`

writeFileSync(outPath, license)
console.log(`已签发 → ${outPath}`)
console.log(`  客户: ${customer} | 席位: ${seats} | 到期: ${expires.toISOString().slice(0, 10)} | 宽限: ${graceDays}天`)
console.log('  交付方式:把该文件内容放进客户 .env 的 LICENSE_KEY,或挂载到容器。')
