// core/auth/qr-login-routes.ts — 扫码登录的两半路由。
//
// ★两半**必须**分开挂,因为鉴权口径正好相反:
//   · 手机那半是公开的(它还没有会话,拿票来换) → 挂在 requireAuth 之前;
//   · PC 那半必须已登录(是它在把自己的身份授出去) → 挂在 requireAuth 之后。
//   写成一个 router 挂一次,不是漏鉴权就是手机根本进不来。公开面白名单里那一行
//   (core/http/tests/public-surface.test.ts)钉的就是前者。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { clientIpOf } from '../http/client-ip'
import {
  QR_CONFIRM_WINDOW_MS,
  checkQrRate,
  createQrTicket,
  decideQrTicket,
  listLoginDevices,
  readQrTicket,
  redeemQrTicket,
  revokeLoginDevice,
  scanQrTicket,
} from './qr-login'
import { verifyToken } from './token'

const TicketBody = z.object({ ticket: z.string().min(20).max(200) })
const ScanBody = TicketBody.extend({
  device: z
    .object({
      label: z.string().max(300).nullish(),
      platform: z.string().max(60).nullish(),
      appVersion: z.string().max(60).nullish(),
    })
    .optional(),
})

/** 手机侧:公开。**挂在 requireAuth 之前**。 */
export function qrLoginPublicRoutes(db: Db, secret: string) {
  return new Hono()
    /** 扫到码:登记机型,把死线顺延到「够回电脑点一次确认」。回身份姓名给手机显示。 */
    .post('/scan', async (c) => {
      const body = ScanBody.parse(await c.req.json())
      const ip = clientIpOf(c)
      checkQrRate(`scan|${ip ?? '-'}`, 20)
      const r = await scanQrTicket(db, body.ticket, body.device ?? {}, { ip })
      return c.json({ loginAs: r.loginAs, expiresAt: r.expiresAt.toISOString(), confirmWindowMs: QR_CONFIRM_WINDOW_MS })
    })
    /**
     * 轮询兑换。没批准就如实回状态;批准了当场签 90 天令牌并一次性作废这张票。
     * ★手机是靠轮询这个端点推进的,所以配额要能容下轮询(2 秒一次 = 30 次/分)。
     */
    .post('/redeem', async (c) => {
      const body = TicketBody.parse(await c.req.json())
      const ip = clientIpOf(c)
      checkQrRate(`redeem|${ip ?? '-'}`, 240)
      const r = await redeemQrTicket(db, body.ticket, secret, { ip })
      return c.json(r)
    })
}

/** 从请求头把本次用的令牌 jti 解回来 —— 设备列表要标出「当前这一台」。 */
function currentJti(c: { req: { header: (k: string) => string | undefined } }, secret: string): string | null {
  try {
    const header = c.req.header('Authorization') ?? ''
    return verifyToken(header.slice('Bearer '.length), secret).jti ?? null
  } catch {
    return null // 服务令牌(svc_…)等非 HMAC 令牌:标不出当前设备,不影响列表
  }
}

/** PC 侧 + 设备台账:**挂在 requireAuth 之后**(/api/session/qr、/api/session/devices)。 */
export function qrLoginSessionRoutes(db: Db, secret: string) {
  return new Hono<AppEnv>()
    /** 出一张新码。前端按 rotateAfterMs 自己换新的。 */
    .post('/qr/tickets', async (c) => {
      const ctx = c.get('ctx')
      const r = await createQrTicket(db, ctx, { ip: clientIpOf(c) })
      return c.json({ ticket: r.ticket, expiresAt: r.expiresAt.toISOString(), rotateAfterMs: r.rotateAfterMs })
    })
    /** 轮询这张码的状态(等人来扫 → 显示是哪台设备 → 等你确认)。 */
    .post('/qr/status', async (c) => {
      const ctx = c.get('ctx')
      const body = TicketBody.parse(await c.req.json())
      const v = await readQrTicket(db, body.ticket, ctx)
      if (!v) return c.json({ status: 'expired' as const, device: null })
      return c.json({
        status: v.status,
        expiresAt: v.expiresAt.toISOString(),
        device: v.device
          ? { label: v.device.label, platform: v.device.platform, ip: v.device.ip, scannedAt: v.device.scannedAt.toISOString() }
          : null,
      })
    })
    /** 确认 / 拒绝。★只有 scanned 才动得了(见 decideQrTicket) —— 不能先批准再等人来扫。 */
    .post('/qr/decide', async (c) => {
      const ctx = c.get('ctx')
      const body = TicketBody.extend({ approve: z.boolean() }).parse(await c.req.json())
      const ok = await decideQrTicket(db, body.ticket, ctx, body.approve)
      return c.json({ ok })
    })
    /** 我的登录设备。 */
    .get('/devices', async (c) => {
      const ctx = c.get('ctx')
      const devices = await listLoginDevices(db, ctx, currentJti(c, secret))
      return c.json({
        devices: devices.map((d) => ({
          jti: d.jti,
          label: d.label,
          platform: d.platform,
          appVersion: d.appVersion,
          issuedAt: d.issuedAt.toISOString(),
          expiresAt: d.expiresAt.toISOString(),
          current: d.current,
        })),
      })
    })
    /** 下线一台。只能下线自己名下的(WHERE 里带了 who)。 */
    .post('/devices/:jti/revoke', async (c) => {
      const ctx = c.get('ctx')
      const ok = await revokeLoginDevice(db, c.req.param('jti'), ctx)
      return c.json({ ok })
    })
}
