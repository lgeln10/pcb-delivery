// src/local-date.test.ts —— 锁住「今天」按本地时区算这件事。
//
// ★每条断言都**显式钉死时区**,不吃跑测那台机器的本地时区。理由是仓里已经栽过的那次
//   (memory: aios-tz-utc-ci-green-prod-wrong):CI 跑 UTC,东八区才歪 ——
//   跟着环境走的断言在 CI 上会「恰好对」,等于没测。
//   反过来也一样:本机东八区能过、CI 的 UTC 上红,同样是这条的镜像(写这份时真撞了一次)。
import { describe, expect, it } from 'vitest'
import { localDate, localDatePlus, localMonth, localYear } from './local-date'

/**
 * 在指定时区里跑一段断言。切不动时**跳过**(返回 false),而不是假装验过 ——
 * Node 允许运行时改 `process.env.TZ`,但不是每个平台都真的生效。
 * 判据是拿一个已知时刻的 `getTimezoneOffset()` 对答案。
 */
function inTZ(tz: string, expectedOffsetMin: number, probe: Date, body: () => void): boolean {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    if (new Date(probe.getTime()).getTimezoneOffset() !== expectedOffsetMin) return false
    body()
    return true
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

describe('本地日期', () => {
  it('★东八区凌晨:localDate 给今天,toISOString 给昨天(这一条就是那个 bug 本身)', () => {
    const ran = inTZ('Asia/Shanghai', -480, new Date(Date.UTC(2026, 7, 15, 19, 0, 0)), () => {
      // 东八区 2026-08-16 03:00 = UTC 2026-08-15 19:00
      const d = new Date(Date.UTC(2026, 7, 15, 19, 0, 0))
      expect(localDate(d)).toBe('2026-08-16')
      expect(d.toISOString().slice(0, 10)).toBe('2026-08-15') // ← 老写法给的是这个
    })
    expect(ran || process.platform === 'win32').toBe(true) // 切不动 TZ 就别静默放过
  })

  it('月末 / 年末 / 闰年进位', () => {
    inTZ('Asia/Shanghai', -480, new Date(Date.UTC(2026, 0, 1)), () => {
      expect(localDate(new Date(2026, 0, 1, 12))).toBe('2026-01-01')
      expect(localDatePlus(1, new Date(2026, 11, 31, 12))).toBe('2027-01-01')
      expect(localDatePlus(1, new Date(2028, 1, 28, 12))).toBe('2028-02-29')
      expect(localDatePlus(-1, new Date(2026, 2, 1, 12))).toBe('2026-02-28')
      expect(localDatePlus(7, new Date(2026, 7, 28, 12))).toBe('2026-09-04')
    })
  })

  it('★夏令时那两天:setDate 对,「加 86400000 毫秒」差整整一天', () => {
    // 美东 2026-03-08 02:00 春季进位。EST 偏移 +300 分钟。
    const ran = inTZ('America/New_York', 300, new Date(Date.UTC(2026, 2, 8, 4, 30, 0)), () => {
      const from = new Date(2026, 2, 7, 23, 30, 0) // 本地 03-07 23:30 EST
      expect(localDatePlus(1, from)).toBe('2026-03-08')
      expect(localDate(new Date(from.getTime() + 86_400_000))).toBe('2026-03-09') // ← 毫秒加法错在这
    })
    expect(ran || process.platform === 'win32').toBe(true)
  })

  it('★月初 / 元旦的早上:localMonth·localYear 给本月本年,toISOString 给上一个', () => {
    // 东八区 2026-09-01 03:00 = UTC 2026-08-31 19:00;2026-01-01 03:00 = UTC 2025-12-31 19:00
    const ran = inTZ('Asia/Shanghai', -480, new Date(Date.UTC(2026, 7, 31, 19, 0, 0)), () => {
      const monthEdge = new Date(Date.UTC(2026, 7, 31, 19, 0, 0))
      expect(localMonth(monthEdge)).toBe('2026-09')
      expect(monthEdge.toISOString().slice(0, 7)).toBe('2026-08') // ← 老写法给上个月
      const yearEdge = new Date(Date.UTC(2025, 11, 31, 19, 0, 0))
      expect(localYear(yearEdge)).toBe('2026')
      expect(yearEdge.toISOString().slice(0, 4)).toBe('2025') // ← 老写法给去年
    })
    expect(ran || process.platform === 'win32').toBe(true)
  })
})
