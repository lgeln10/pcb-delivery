// core/auth/token.ts
// 无状态登录凭证:HMAC-SHA256 签名 token(node:crypto,无第三方 JWT 库)。
// 格式:base64url(payload JSON) + '.' + base64url(hmac)。payload 含 exp(epoch 秒)。
// secret 由调用方显式传入(HTTP 层从环境变量取,★密钥禁进代码库)。
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { AuthError } from './errors'

export type TokenPayload = {
  employeeId: string
  tenantId: string
  exp: number // epoch 秒
  /**
   * 签发时刻,**epoch 毫秒**。用来和 employees.sessions_revoked_at 比 ——
   * 早于水位的令牌一律拒绝(见 core/auth/token-revocation.ts)。
   *
   * ★为什么是毫秒而不是 JWT 惯例的秒:水位取的是 `new Date()`(毫秒)。
   *   如果 iat 只到秒,「点了退出所有设备,马上重新登录」拿到的新令牌 iat 会被
   *   floor 到该秒的 0 毫秒,反而早于水位 → 新令牌当场失效,用户被弹回登录页再登再弹。
   *   **实测撞到过**:revoke-all 之后立刻 demo-login,/api/me 回 401。
   *   两边统一到毫秒,这个窗口就不存在了。字段名带 Ms 是为了让下一个人不会当成秒来用。
   *
   * ★可选:0198 之前签发的令牌没有这一项。解析时当 0 处理 ——
   *   从没吊销过的员工照常用,吊销过一次则所有老令牌立即失效。这个方向是对的,
   *   不会把人误挡在外面,而一旦真出事,老令牌也一起被收走。
   */
  iatMs?: number
  /**
   * 令牌唯一标识。用来单枚吊销(「退出登录」只该让当前设备失效,不该踢掉手机)。
   * ★可选:老令牌没有,因而无法被单枚吊销 —— 7 天内自然过期,之后全网都是新格式。
   */
  jti?: string
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

export function signToken(
  payload: { employeeId: string; tenantId: string },
  secret: string,
  ttlSeconds = 7 * 24 * 3600,
): string {
  const nowMs = Date.now()
  const full: TokenPayload = {
    ...payload,
    exp: Math.floor(nowMs / 1000) + ttlSeconds, // exp 保持秒(原有格式,别动)
    iatMs: nowMs, // ★毫秒,与吊销水位同精度 —— 理由见 TokenPayload.iatMs
    jti: randomUUID(),
  }
  const body = Buffer.from(JSON.stringify(full)).toString('base64url')
  return body + '.' + hmac(body, secret).toString('base64url')
}

export function verifyToken(token: string, secret: string): TokenPayload {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) throw new AuthError('TOKEN_INVALID', 'malformed token')
  const body = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1), 'base64url')
  const expected = hmac(body, secret)
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new AuthError('TOKEN_INVALID', 'bad signature')
  }
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    throw new AuthError('TOKEN_INVALID', 'bad payload')
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AuthError('TOKEN_EXPIRED', 'token expired')
  }
  if (!payload.employeeId || !payload.tenantId) throw new AuthError('TOKEN_INVALID', 'bad payload')
  return payload
}
