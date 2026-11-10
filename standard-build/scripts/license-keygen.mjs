// scripts/license-keygen.mjs — 生成 Ed25519 密钥对(厂商侧,只跑一次)。
// 私钥(license-private.pem)绝对保密、离线保存;公钥填进 core/license/verify.ts 的 EMBEDDED_PUBLIC_KEY。
// 用法:node scripts/license-keygen.mjs
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

writeFileSync('license-private.pem', priv, { mode: 0o600 })
writeFileSync('license-public.pem', pub)

console.log('已生成:')
console.log('  license-private.pem  ← 私钥,绝对保密、离线保存(签发 license 用)')
console.log('  license-public.pem   ← 公钥,填进 core/license/verify.ts 的 EMBEDDED_PUBLIC_KEY')
console.log('\n公钥内容(粘进 EMBEDDED_PUBLIC_KEY):\n')
console.log(JSON.stringify(pub))
