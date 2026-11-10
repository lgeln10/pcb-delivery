// core/http/client-ip.ts — 客户端 IP 的唯一取法。
//
// ★为什么取 x-forwarded-for 的**最后一跳**,不是第一跳:
//   这个头是调用方可写的。nginx 常见配置 `proxy_add_x_forwarded_for` 是**追加**——
//   攻击者送来「假A, 假B」,经过我们的反代后变成「假A, 假B, 真IP」:只有最后一跳
//   是我们自己的反代写的,前面全部是对方自称的。Caddy(≥2.5 默认)会把不可信来源的
//   XFF 整个丢掉、只写真实连接地址,此时整串就一跳,取最后一跳同样正确。
//   取第一跳 = 把「限流键 / 审计 IP / 归属地」交给攻击者随意填:
//   每个请求换一个假前缀,就是无限个新限流桶,按 IP 限流整个失效。
//
// ★没有反代直接裸奔时,这个头本身就是对方发的,最后一跳照样不可信 ——
//   所以调用方要把「拿不到可信 IP」当成一种正常状态(返回 null),
//   并在那种状态下**只做减速、不做锁定**(否则伪造一个头就能把别人锁在门外)。
export function lastHopIp(raw: string | null | undefined): string | null {
  if (!raw) return null
  const parts = raw.split(',')
  const last = parts[parts.length - 1]?.trim()
  return last || null
}

/** 请求 → 客户端 IP;取不到返回 null(直连且无反代头)。 */
export function clientIpOf(c: { req: { header: (k: string) => string | undefined } }): string | null {
  return lastHopIp(c.req.header('x-forwarded-for')) ?? c.req.header('x-real-ip')?.trim() ?? null
}
