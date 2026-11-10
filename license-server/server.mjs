// license-server/server.mjs
// 零依赖 License 服务(纯 Node http + crypto)。托管在厂商服务器,给各客户 AIOS 心跳校验 + 远程吊销/续期。
// 私钥只在这里(签发/续期);AIOS 只内嵌公钥验签。
//
// 环境变量:
//   LICENSE_PRIVATE_KEY_FILE  Ed25519 私钥 PEM 路径(license-keygen.mjs 生成的 license-private.pem)
//   LICENSE_ADMIN_TOKEN       管理接口(签发/吊销/续期/列表)的令牌,请求头 x-admin-token
//   LICENSE_STORE_FILE        授权登记 JSON 存储(默认 ./licenses.json)
//   PORT                      默认 8787
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sign as edSign, createPrivateKey, randomUUID, createHmac, timingSafeEqual } from 'node:crypto'

const ADMIN_HTML = (() => {
  try {
    return readFileSync(fileURLToPath(new URL('./admin.html', import.meta.url)), 'utf8')
  } catch {
    return '<!doctype html><h1>AIOS License Server</h1><p>admin.html 缺失</p>'
  }
})()

const PORT = Number(process.env.PORT ?? 8787)
const STORE = process.env.LICENSE_STORE_FILE || './licenses.json'
const ADMIN = process.env.LICENSE_ADMIN_TOKEN || ''
const KEY_FILE = process.env.LICENSE_PRIVATE_KEY_FILE || './license-private.pem'
if (!ADMIN) console.warn('[license] ⚠ 未设 LICENSE_ADMIN_TOKEN,管理接口将拒绝所有请求')
const privateKey = existsSync(KEY_FILE) ? createPrivateKey(readFileSync(KEY_FILE)) : null
if (!privateKey) console.warn(`[license] ⚠ 未找到私钥 ${KEY_FILE},签发/续期不可用(心跳仍可用)`)

/** @returns {Record<string, any>} licenseId → record */
function load() {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch {
    return {}
  }
}
function save(db) {
  writeFileSync(STORE, JSON.stringify(db, null, 2))
}
function signLicense(payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8')
  const sig = edSign(null, buf, privateKey)
  return `${buf.toString('base64url')}.${sig.toString('base64url')}`
}
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(body)
}
function readJson(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        resolve({})
      }
    })
  })
}
// ── 会话登录(应用级,带 UI)──
const UI_USER = process.env.LICENSE_UI_USER || 'admin'
const UI_PASS = process.env.LICENSE_UI_PASS || ''
const SESSION_SECRET = process.env.LICENSE_SESSION_SECRET || ADMIN || 'change-me'
const hmac = (s) => createHmac('sha256', SESSION_SECRET).update(s).digest('base64url')
function signSession(user) {
  const p = Buffer.from(JSON.stringify({ user, exp: Date.now() + 7 * 86_400_000 })).toString('base64url')
  return `${p}.${hmac(p)}`
}
function verifySession(cookie) {
  if (!cookie) return false
  const [p, sig] = cookie.split('.')
  if (!p || !sig || sig !== hmac(p)) return false
  try {
    return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now()
  } catch {
    return false
  }
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'))
  return m ? decodeURIComponent(m[1]) : null
}
const isAuthed = (req) => verifySession(getCookie(req, 'lic_session'))

// ── 登录限流(防暴力):按 IP 记失败次数,超阈值锁定一段时间 ──
const MAX_FAILS = 6
const LOCK_MS = 15 * 60 * 1000
const loginFails = new Map() // ip -> { n, until }
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || req.socket.remoteAddress || '?'
}
function lockedSeconds(ip) {
  const r = loginFails.get(ip)
  return r && r.until > Date.now() ? Math.ceil((r.until - Date.now()) / 1000) : 0
}
function recordFail(ip) {
  const r = loginFails.get(ip) || { n: 0, until: 0 }
  r.n += 1
  if (r.n >= MAX_FAILS) { r.until = Date.now() + LOCK_MS; r.n = 0 }
  loginFails.set(ip, r)
}
// 常量时间比较(防时序侧信道);长度不同直接 false
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const method = req.method

  if (path === '/health') return send(res, 200, { ok: true })

  // 管理台页面(公开;所有数据操作仍需 x-admin-token)
  if (path === '/' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(ADMIN_HTML)
  }

  // 心跳(公开):AIOS 每天 check-in。返回是否吊销 + 权威到期日(可远程续期)。
  if (path === '/heartbeat' && method === 'POST') {
    const { licenseId } = await readJson(req)
    const db = load()
    const rec = licenseId && db[licenseId]
    if (!rec) return send(res, 200, { ok: true, found: false })
    rec.lastHeartbeatAt = new Date().toISOString()
    save(db)
    return send(res, 200, { ok: true, found: true, revoked: !!rec.revoked, expiresAt: rec.expiresAt, serverTime: new Date().toISOString() })
  }

  // 登录(公开):校验用户名/密码 → 下发会话 cookie
  if (path === '/login' && method === 'POST') {
    const ip = clientIp(req)
    const lock = lockedSeconds(ip)
    if (lock) return send(res, 429, { error: `尝试过多，请 ${lock} 秒后再试` })
    const { username, password } = await readJson(req)
    if (UI_PASS && safeEqual(username, UI_USER) && safeEqual(password, UI_PASS)) {
      loginFails.delete(ip)
      const cookie = `lic_session=${signSession(username)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': cookie })
      return res.end(JSON.stringify({ ok: true }))
    }
    recordFail(ip)
    await new Promise((r) => setTimeout(r, 400)) // 失败略微延时,进一步拖慢脚本猜解
    return send(res, 401, { error: '用户名或密码错误' })
  }
  if (path === '/logout' && method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'lic_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' })
    return res.end(JSON.stringify({ ok: true }))
  }
  if (path === '/me' && method === 'GET') return send(res, 200, { authed: isAuthed(req), user: isAuthed(req) ? UI_USER : null })

  // 以下为管理接口(需登录会话)
  if (!isAuthed(req)) return send(res, 401, { error: 'unauthorized' })

  if (path === '/issue' && method === 'POST') {
    if (!privateKey) return send(res, 500, { error: 'no private key' })
    const { customer, seats, days, graceDays, features } = await readJson(req)
    if (!customer || !Number.isFinite(seats) || !Number.isFinite(days)) return send(res, 400, { error: 'customer/seats/days required' })
    const licenseId = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString()
    const feats = Array.isArray(features) ? features.filter((x) => typeof x === 'string') : []
    const payload = { v: 1, licenseId, customer, seats, issuedAt: now.toISOString(), expiresAt, graceDays: graceDays ?? 7, features: feats }
    const license = signLicense(payload)
    const db = load()
    db[licenseId] = { ...payload, revoked: false, lastHeartbeatAt: null }
    save(db)
    return send(res, 200, { licenseId, license, ...payload })
  }

  if (path === '/revoke' && method === 'POST') {
    const { licenseId } = await readJson(req)
    const db = load()
    if (!db[licenseId]) return send(res, 404, { error: 'not found' })
    db[licenseId].revoked = true
    save(db)
    return send(res, 200, { ok: true })
  }

  if (path === '/renew' && method === 'POST') {
    const { licenseId, days } = await readJson(req)
    const db = load()
    const rec = db[licenseId]
    if (!rec) return send(res, 404, { error: 'not found' })
    // 从"现在"或"原到期日"(取较晚)顺延,避免续期反而缩短
    const base = Math.max(Date.now(), new Date(rec.expiresAt).getTime())
    rec.expiresAt = new Date(base + Number(days) * 86_400_000).toISOString()
    rec.revoked = false
    save(db)
    return send(res, 200, { ok: true, expiresAt: rec.expiresAt })
  }

  if (path === '/admin/licenses' && method === 'GET') {
    return send(res, 200, { items: Object.values(load()) })
  }

  return send(res, 404, { error: 'not found' })
})
server.listen(PORT, () => console.log(`[license] listening on :${PORT} (store=${STORE})`))
