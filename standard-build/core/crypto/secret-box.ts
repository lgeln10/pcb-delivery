// core/crypto/secret-box.ts
// 可逆密钥的对称加密(AES-256-GCM)。★密钥红线细化:可逆密钥(要拿去调 API,不能 hash)
// 加密后才入库,明文绝不进库;加密主密钥走 env(CONFIG_ENC_KEY 或 AUTH_SECRET),不进库不进代码。
// 库泄露后,没有 env 主密钥也解不出明文。
// 共享底座:feedback(LLM key) / ocr(厂商凭证) 等多模块复用,故置于 core。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const FORMAT = 'v1' // 密文串格式版本:v1:saltHex:ivHex:tagHex:cipherHex

/** 主密钥缺失:有 code 字段,经 core/http/errors.ts 的 CODE_STATUS 映射为 400。 */
export class SecretBoxError extends Error {
  constructor(public code: 'KEY_STORE_UNAVAILABLE', message: string) {
    super(message)
    this.name = 'SecretBoxError'
  }
}

function masterSecret(): string {
  const secret = process.env.CONFIG_ENC_KEY ?? process.env.AUTH_SECRET
  if (!secret) {
    throw new SecretBoxError('KEY_STORE_UNAVAILABLE', '未配置 CONFIG_ENC_KEY 或 AUTH_SECRET,无法安全加密存储密钥')
  }
  return secret
}

/** 主密钥是否就绪(能否往库里存 key)。dev 内存库未设 env 时为 false。 */
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
    throw new SecretBoxError('KEY_STORE_UNAVAILABLE', '密文格式不正确')
  }
  const key = scryptSync(masterSecret(), Buffer.from(saltHex, 'hex'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}
