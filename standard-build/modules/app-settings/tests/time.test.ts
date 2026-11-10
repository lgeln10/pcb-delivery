// 系统时区换算(纯函数,不碰库)。这组用例守的是「提醒到底几点发」的地基:
// 算错一小时,所有定时提醒就全偏 —— 而且偏得很隐蔽(线上看着"发了",只是时候不对)。
// ★所有断言都用绝对时刻(...Z)构造,与跑测试的机器时区无关(CI 在 UTC、本机在东八区,结果必须一样)。
import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEZONE, isValidTimezone, zonedDate, zonedDayStart, zonedHour, zonedMonth, zonedTimeToUtc, zonedWallClockToUtc, zonedWeekday } from '../time'

const SH = 'Asia/Shanghai'
const NY = 'America/New_York'

describe('系统时区:基本换算', () => {
  it('默认东八区;同一时刻在不同时区是不同的「几点」', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Shanghai')
    const at = new Date('2026-07-27T01:00:00Z')
    expect(zonedHour(at, SH)).toBe(9) // 北京 09:00 —— 正是提醒该发的点
    expect(zonedHour(at, 'UTC')).toBe(1)
    expect(zonedHour(at, NY)).toBe(21) // 前一天晚上
  })

  it('跨日:UTC 还是 27 号,北京已是 28 号(按天幂等的标记必须按当地日)', () => {
    const at = new Date('2026-07-27T16:30:00Z')
    expect(zonedDate(at, 'UTC')).toBe('2026-07-27')
    expect(zonedDate(at, SH)).toBe('2026-07-28')
    expect(zonedHour(at, SH)).toBe(0) // 当地零点半,不是 24 点(hourCycle h23)
  })

  it('当地日起点 = 该时区当天 00:00 对应的绝对时刻', () => {
    const at = new Date('2026-07-27T16:30:00Z') // 北京 7/28 00:30
    expect(zonedDayStart(at, SH).toISOString()).toBe('2026-07-27T16:00:00.000Z') // 北京 7/28 00:00
    expect(zonedDayStart(at, 'UTC').toISOString()).toBe('2026-07-27T00:00:00.000Z')
  })

  it('把「当地某天某点」落成绝对时刻(9 点提醒真正发出的时刻)', () => {
    expect(zonedTimeToUtc('2026-07-27', 9, SH).toISOString()).toBe('2026-07-27T01:00:00.000Z')
    expect(zonedTimeToUtc('2026-07-27', 0, SH).toISOString()).toBe('2026-07-26T16:00:00.000Z')
    expect(zonedTimeToUtc('2026-07-27', 9, 'UTC').toISOString()).toBe('2026-07-27T09:00:00.000Z')
  })

  it('星期几按当地日算(发送日「周末不催」靠它)', () => {
    // UTC 周五 23:00 → 北京已是周六
    const at = new Date('2026-07-24T23:00:00Z')
    expect(zonedWeekday(at, 'UTC')).toBe(5)
    expect(zonedWeekday(at, SH)).toBe(6)
  })
})

describe('系统时区:钟面时间串 → 绝对时刻', () => {
  it('无偏移的钟面串按系统时区解释,不按进程时区', () => {
    // 东八区「明天下午2点」= 14:00 当地 → 06:00Z(而不是 new Date 的 14:00Z)
    expect(zonedWallClockToUtc('2026-08-12 14:00', SH)!.toISOString()).toBe('2026-08-12T06:00:00.000Z')
    // T 分隔、带秒也认;秒丢弃(相对时间到分钟)
    expect(zonedWallClockToUtc('2026-08-12T14:00:00', SH)!.toISOString()).toBe('2026-08-12T06:00:00.000Z')
    // 往返自洽:落库后再按当地读回来还是 14 点
    expect(zonedHour(zonedWallClockToUtc('2026-08-12 14:00', SH)!, SH)).toBe(14)
    // 换个时区结果不同(证明真按 tz 算)
    expect(zonedWallClockToUtc('2026-08-12 14:00', 'UTC')!.toISOString()).toBe('2026-08-12T14:00:00.000Z')
  })

  it('带时区偏移的绝对串返回 null(交回调用方 new Date 直解),格式不符也返回 null', () => {
    expect(zonedWallClockToUtc('2026-08-12T14:00:00Z', SH)).toBeNull()
    expect(zonedWallClockToUtc('2026-08-12T14:00:00+08:00', SH)).toBeNull()
    expect(zonedWallClockToUtc('2026-08-12', SH)).toBeNull() // 纯日期不归它管(走 zonedTimeToUtc)
    expect(zonedWallClockToUtc('明天下午', SH)).toBeNull()
  })
})

describe('系统时区:夏令时与非法值', () => {
  // ★两趟偏移修正就是为这条:美东 3/8 凌晨 2 点跳到 3 点,当天 9 点的 UTC 偏移与前一天不同。
  it('夏令时切换日:同样是「当地 9 点」,前后两天对应不同的 UTC 时刻', () => {
    expect(zonedTimeToUtc('2026-03-07', 9, NY).toISOString()).toBe('2026-03-07T14:00:00.000Z') // EST(-5)
    expect(zonedTimeToUtc('2026-03-08', 9, NY).toISOString()).toBe('2026-03-08T13:00:00.000Z') // EDT(-4)
    expect(zonedHour(new Date('2026-03-08T13:00:00.000Z'), NY)).toBe(9) // 往返自洽
  })

  it('夏令时切换日的当地日起点仍是当地 00:00', () => {
    const at = new Date('2026-03-08T18:00:00Z') // 美东 3/8 下午
    expect(zonedDayStart(at, NY).toISOString()).toBe('2026-03-08T05:00:00.000Z') // 当天 00:00 EST(-5)
    expect(zonedDate(at, NY)).toBe('2026-03-08')
  })

  it('时区名校验:认得 IANA 名,挡住 GMT+8 这类写法', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true)
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(isValidTimezone('GMT+8')).toBe(false)
    expect(isValidTimezone('北京时间')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })
})

describe('系统时区:当地月份(会计期间)', () => {
  it('★每月 1 号的头几个小时,UTC 月与当地月不是同一个', () => {
    // 北京 2026-09-01 03:00 = UTC 2026-08-31 19:00
    const at = new Date('2026-08-31T19:00:00Z')
    expect(zonedMonth(at, SH)).toBe('2026-09')
    expect(zonedMonth(at, 'UTC')).toBe('2026-08') // ← 老写法 toISOString().slice(0,7) 等价于这个
    // 反方向:纽约比 UTC 晚,月末最后几个小时 UTC 已经翻月、当地还没
    const at2 = new Date('2026-09-01T02:00:00Z') // 纽约 08-31 22:00
    expect(zonedMonth(at2, NY)).toBe('2026-08')
    expect(zonedMonth(at2, 'UTC')).toBe('2026-09')
  })

  it('与 zonedDate 同源:月份就是当地日期的前 7 位', () => {
    const at = new Date('2026-08-31T19:00:00Z')
    expect(zonedMonth(at, SH)).toBe(zonedDate(at, SH).slice(0, 7))
  })
})
