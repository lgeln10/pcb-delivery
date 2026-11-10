// core/license/heartbeat.ts
// 心跳客户端:配了 LICENSE_SERVER_URL 时,启动 + 每天向厂商 license 服务 check-in。
// 拿回「是否吊销 / 权威到期日」持久化到文件(跨重启)→ 供 state.ts 折叠进授权判定:
//   - 远程吊销 → 立即只读
//   - 远程续期(serverExpiresAt 更晚)→ 无需重新部署即延长
//   - 配了心跳却长期 check-in 不上(断网/被挡)→ 超宽限视为过期(防离线绕过)
import { loadLicense, licenseServerUrl } from './state'
import { writeHeartbeatState } from './hbstore'

/** 单次心跳(best-effort)。成功则更新持久化状态。 */
export async function heartbeatOnce(): Promise<void> {
  const server = licenseServerUrl()
  const lic = loadLicense()
  if (!server || !lic) return
  try {
    const r = await fetch(`${server.replace(/\/+$/, '')}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseId: lic.licenseId, customer: lic.customer }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return
    const data = (await r.json()) as { found?: boolean; revoked?: boolean; expiresAt?: string }
    if (data.found === false) return // 服务端没这条记录(可能纯离线证)→ 不改本地
    writeHeartbeatState({
      revoked: !!data.revoked,
      serverExpiresAt: data.expiresAt ?? null,
      lastOkAt: new Date().toISOString(),
    })
  } catch {
    /* 网络失败:保留上次状态,靠 state.ts 的 HB 宽限期兜底 */
  }
}

/** 启动心跳:立即一次 + 每天一次。仅配了 LICENSE_SERVER_URL 时生效。 */
export function startHeartbeat(): void {
  if (!licenseServerUrl()) return
  void heartbeatOnce()
  setInterval(() => void heartbeatOnce(), 24 * 3_600_000).unref()
}
