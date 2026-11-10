// 输出上限必须**能在单次超时内写完**,否则那个上限就是个不可能达成的数。
//
// ★真事(2026-08-25/26/27):商机晨检 `opp_review` 上限 6000,而线上实测生成速度
//   最低到 61 token/s —— 6000 token 要 98 秒,比单次超时还长。也就是说:
//   模型只要真的想写满,这条链路**必然**超时,而且是每天定时触发、连挂三天。
//   上限与超时是一对数,单独看哪个都正常,乘起来才看得出不相容 —— 所以钉在这里。
import { describe, expect, it } from 'vitest'
import { LLM_SCENES } from '../scenes'
import { ATTEMPT_TIMEOUT_MS } from '../caller'

/**
 * 线上实测的**最慢**生成速度(token/秒)。取最慢而不是平均:
 * 上限要在最坏情况下也写得完,按平均算等于赌不会碰上慢的那次。
 * 样本(base_prod 的 llm_usage_logs,2026-08 商机晨检成功记录):
 *   1214 tok / 19.9s = 61 · 2463 / 38.1 = 65 · 2936 / 34.9 = 84 · 3861 / 43.3 = 89
 */
const SLOWEST_TOKENS_PER_SEC = 61
/** 除生成之外的固定开销(排队、首 token、网关一跳)。实测拟合约 2.3s,留到 8s。 */
const FIXED_OVERHEAD_MS = 8_000

describe('输出上限与单次超时必须相容', () => {
  it('★每个场景:按最慢速度写满上限,也要留有余量地跑完', () => {
    const offenders = LLM_SCENES.filter((s) => s.maxOutputTokens).map((s) => {
      const needMs = (s.maxOutputTokens! / SLOWEST_TOKENS_PER_SEC) * 1000 + FIXED_OVERHEAD_MS
      return { scene: s.key, cap: s.maxOutputTokens!, needMs: Math.round(needMs) }
    }).filter((x) => x.needMs > ATTEMPT_TIMEOUT_MS)
    expect(
      offenders,
      `这些场景的 maxOutputTokens 在最慢速度(${SLOWEST_TOKENS_PER_SEC} token/s)下写不完,` +
        `一定会撞单次超时(${ATTEMPT_TIMEOUT_MS}ms)—— 要么把上限调小,要么这条链路根本不该配这么大的上限`,
    ).toEqual([])
  })

  it('★别把上限设成 0 或负数:0 会被当成「不下发」,等于没有上限', () => {
    for (const s of LLM_SCENES) {
      if (s.maxOutputTokens !== undefined) expect(s.maxOutputTokens, s.key).toBeGreaterThan(0)
    }
  })
})
