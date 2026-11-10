// 单次尝试的超时必须受**剩余预算**约束,不能是写死的常量。
//
// ★这条来自一次生产事故(2026-08-25/26/27,商机晨检连挂三天):
//   `timeout` 原来写死 45s,`deadline` 只用来算退避、从不参与超时计算。
//   于是「主选超时 → 切备用再超时」是**相加**的 —— 三次失败的 latency 分别是
//   90287 / 90395 / 90366 ms,正好 45+45,而当时 TOTAL_BUDGET_MS 是 55s,一点没兜住。
//   文件头注释写的却是「主选与备用共享同一 deadline,不叠加」—— 注释是对的,代码没做到。
//   同日单次超时由 45s 抬到 90s 之后,同一形状会变成最多 180s,
//   而 nginx 的 proxy_read_timeout 是 120s:网关先返 504、进程还在等,
//   用户看到的错误与服务端记的原因从此对不上。
import { describe, expect, it } from 'vitest'
import { attemptTimeoutMs, ATTEMPT_TIMEOUT_MS } from '../caller'

const NOW = 1_700_000_000_000

describe('单次尝试超时 = min(单次上限, 剩余预算)', () => {
  it('预算充足 → 用单次上限', () => {
    expect(attemptTimeoutMs(NOW + 110_000, NOW)).toBe(ATTEMPT_TIMEOUT_MS)
  })

  it('★预算比单次上限小 → 收窄到剩余预算(这就是当年没做的那一步)', () => {
    expect(attemptTimeoutMs(NOW + 30_000, NOW)).toBe(30_000)
  })

  it('★主选耗掉大半预算后,备用只能用剩下的 —— 两次相加不超过总预算', () => {
    const deadline = NOW + 110_000
    const first = attemptTimeoutMs(deadline, NOW)
    const second = attemptTimeoutMs(deadline, NOW + first) // 备用在主选结束时才开始
    expect(first + second).toBeLessThanOrEqual(110_000)
  })

  it('预算见底 → 有下限,不发一个必然超时的请求(也不给负数)', () => {
    expect(attemptTimeoutMs(NOW + 100, NOW)).toBe(5_000)
    expect(attemptTimeoutMs(NOW - 50_000, NOW)).toBe(5_000)
  })

  it('★超时不许再写成常量:请求处必须按 deadline 现算', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'caller.ts'), 'utf8')
    const call = src.slice(src.indexOf('client.chat.completions.create('))
    expect(
      call.slice(0, call.indexOf('llmRequest') === -1 ? 900 : 900),
      '请求处没有按 deadline 现算超时 —— 主选与备用的超时又会相加',
    ).toContain('attemptTimeoutMs(deadline)')
  })
})
