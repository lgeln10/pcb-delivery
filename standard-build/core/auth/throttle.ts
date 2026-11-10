// core/auth/throttle.ts — 员工登录的失败退避与锁定。
//
// ★在此之前 /api/auth/login 没有任何爆破防护:守全部租户数据的那道门可以公网全速穷举,
//   唯一阻力是 bcrypt 本身。访客侧(modules/website/visitor-auth.ts)反而早就有锁定 —— 保护是反的。
//
// 三个维度**刻意不一样重**(与 playbooks/security §3.7 的 pm-server 教训同构:
// 「任何锁定类防护,先问被误锁的人还有没有别的路进来」):
//
// | 维度            | 后果               | 为什么 |
// |-----------------|--------------------|---|
// | (账号, IP) 组合 | 锁定 15 分钟       | 爆破者那台机器该被关在外面;真管理员换个网络仍进得来 |
// | IP(任意账号)  | 锁定 15 分钟       | 换着账号名猜同一台机器,按账号算永远到不了阈值 |
// | 账号(任意 IP) | **只退避,封顶 5 秒,永不锁定** | 压制分布式猜口令,但绝不把唯一能修生产的人挡死 |
//
// ★IP 取不到(直连无反代头,见 core/http/client-ip.ts)时**跳过两个锁定维度**,只留账号退避:
//   没有可信 IP 的锁定会退化成「账号维度锁定」—— 攻击者知道用户名就能把本人锁在门外。宁可少防,不误锁。
//
// 状态是**进程内存级**(与官网公开面限流同款约束):单实例部署成立;横向扩容后各实例各算各的,
// 阈值等效放大 N 倍 —— 到那天要挪到共享存储,先把这行注释当闸。
import { AuthError } from './errors'

export const LOGIN_LOCK_MS = 15 * 60_000
export const LOGIN_FAIL_WINDOW_MS = 15 * 60_000
/** (账号, IP) 组合:5 次失败锁定(与访客侧 MAX_FAILURES 同标尺)。 */
export const LOGIN_COMBO_MAX_FAILURES = 5
/** IP 维度(跨账号):阈值放宽 —— 办公室出口 NAT 后面是一群人,别把整层楼锁掉。 */
export const LOGIN_IP_MAX_FAILURES = 30
/** 账号维度退避:500ms 起步倍增,封顶 5 秒。封顶值就是「永不锁定」的代价上限。 */
export const LOGIN_BACKOFF_BASE_MS = 500
export const LOGIN_BACKOFF_CAP_MS = 5_000

type FailState = { count: number; last: number }

export type LoginThrottle = {
  /** 登录尝试前调用:锁定中抛 TOO_MANY_ATTEMPTS;否则按账号维度退避(内部 sleep)后放行。 */
  gate(phone: string, ip: string | null): Promise<void>
  /** 只在 INVALID_CREDENTIALS 时调用 —— 口令对了但员工离职/租户停用,不是猜口令。 */
  recordFailure(phone: string, ip: string | null): void
  /** 登录成功:清 (账号,IP) 组合与账号维度;IP 维度**不清** —— 攻击者夹带一次成功不该归零它的账本。 */
  clearFailures(phone: string, ip: string | null): void
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createLoginThrottle(
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): LoginThrottle {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? realSleep
  const combo = new Map<string, FailState>() // `${phone}|${ip}`
  const byIp = new Map<string, FailState>()
  const byPhone = new Map<string, FailState>()

  function liveCount(map: Map<string, FailState>, key: string): number {
    const s = map.get(key)
    if (!s) return 0
    if (now() - s.last > LOGIN_FAIL_WINDOW_MS) {
      map.delete(key)
      return 0
    }
    return s.count
  }

  function bump(map: Map<string, FailState>, key: string): void {
    const count = liveCount(map, key) + 1
    map.set(key, { count, last: now() })
    // 防泄漏:桶过多时清窗口外的旧桶(同 visitor-auth.checkRateLimit 的做法)
    if (map.size > 50_000) {
      const t = now()
      for (const [k, v] of map) if (t - v.last > LOGIN_FAIL_WINDOW_MS) map.delete(k)
    }
  }

  return {
    async gate(phone, ip) {
      if (ip) {
        if (liveCount(combo, `${phone}|${ip}`) >= LOGIN_COMBO_MAX_FAILURES || liveCount(byIp, ip) >= LOGIN_IP_MAX_FAILURES) {
          // 同一句话,不区分是哪个维度锁的 —— 不给攻击者「我换个号试试」的探测面
          throw new AuthError('TOO_MANY_ATTEMPTS', 'too many failed attempts, try again later')
        }
      }
      const fails = liveCount(byPhone, phone)
      if (fails > 0) {
        await sleep(Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (fails - 1), LOGIN_BACKOFF_CAP_MS))
      }
    },
    recordFailure(phone, ip) {
      bump(byPhone, phone)
      if (ip) {
        bump(combo, `${phone}|${ip}`)
        bump(byIp, ip)
      }
    },
    clearFailures(phone, ip) {
      byPhone.delete(phone)
      if (ip) combo.delete(`${phone}|${ip}`)
    },
  }
}
