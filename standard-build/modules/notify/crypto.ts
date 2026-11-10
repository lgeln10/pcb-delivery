// modules/notify/crypto.ts
// 通知渠道敏感配置的对称加密(AES-256-GCM)。★密钥红线:可逆密钥(发信时要拿明文,不能 hash)。
// 加密后才入库,明文绝不进库;加密主密钥走 env(CONFIG_ENC_KEY 或 AUTH_SECRET),不进库不进代码。
// 与 feedback 模块同款实现,但模块自包含、不跨模块 import(per-client fork 范式:适度重复 > DRY)。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { NotifyError } from './errors'

const FORMAT = 'v1' // 密文串格式版本:v1:saltHex:ivHex:tagHex:cipherHex

function masterSecret(): string {
  const secret = process.env.CONFIG_ENC_KEY ?? process.env.AUTH_SECRET
  if (!secret) {
    throw new NotifyError('KEY_STORE_UNAVAILABLE', '未配置 CONFIG_ENC_KEY 或 AUTH_SECRET,无法安全加密存储通知配置')
  }
  return secret
}

/** 主密钥是否就绪(能否往库里存配置)。dev 内存库未设 env 时为 false。 */
export function isKeyStoreAvailable(): boolean {
  return !!(process.env.CONFIG_ENC_KEY ?? process.env.AUTH_SECRET)
}

export function encryptSecret(plain: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(masterSecret(), salt, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [FORMAT, salt.toString('hex'), iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':')
}

export function decryptSecret(blob: string): string {
  const [ver, saltHex, ivHex, tagHex, dataHex] = blob.split(':')
  if (ver !== FORMAT || !saltHex || !ivHex || !tagHex || !dataHex) {
    throw new NotifyError('KEY_STORE_UNAVAILABLE', '密文格式不正确')
  }
  const key = scryptSync(masterSecret(), Buffer.from(saltHex, 'hex'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}
