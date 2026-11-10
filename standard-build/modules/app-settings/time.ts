// modules/app-settings/time.ts — 按「系统时区」做时刻换算的纯函数(零依赖,用 Node/浏览器自带的
// Intl IANA 时区库;Node 22 自带 full-icu,不需要装 tzdata)。
//
// ★为什么不能直接用 `date.getHours()`:那读的是**进程所在时区**,取决于容器起在哪儿(镜像默认 UTC)。
//   而「几点发提醒」「今天填没填」是**业务口径**,必须按租户自己设的时区算 —— 否则同一份代码
//   部署到 UTC 机器上,配的 9:00 会在北京时间 17:00 才发(本仓真踩过)。
//
// 覆盖范围:所有「到点触发 / 按天幂等 / 当天窗口」的判定。展示层格式化不走这里(前端按浏览器本地时区)。
export const DEFAULT_TIMEZONE = 'Asia/Shanghai' // 东八区北京时间

/** 是否是运行时认得的 IANA 时区名(保存前校验,免把 'GMT+8' 这种写坏值存进库)。 */
export function isValidTimezone(tz: string): boolean {
  if (!tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

// hourCycle:'h23' 是关键 —— 不指定时某些实现会把午夜给成 "24",算出 hour=24 这种不存在的钟点。
function partsIn(at: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  }
}

/** 该时刻在指定时区是「几点」(0-23)。 */
export function zonedHour(at: Date, tz: string): number {
  return partsIn(at, tz).hour
}

/**
 * 该时刻在指定时区的「当地日期 + 时分」(`YYYY-MM-DD HH:mm`)。
 * 给 LLM 当「现在几点」的基准用 —— 模型算相对时间(「明天下午三点」「上周五」)全靠这一个串,
 * 用进程时区拼会让容器(默认 UTC)上的模型以为现在是当地 8 小时之前,整轮日期全错。
 */
export function zonedDateTime(at: Date, tz: string): string {
  const p = partsIn(at, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/** 该时刻在指定时区的当地日期(YYYY-MM-DD)。按天幂等的标记一律用它,不用 UTC 日。 */
export function zonedDate(at: Date, tz: string): string {
  const p = partsIn(at, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * 该时刻在指定时区的当地**月份**(YYYY-MM)。会计期间、报表期间、工资期间一律用它。
 *
 * ★比 `zonedDate` 更少被撞到,所以更难查:UTC 与当地只有在**每月 1 号的那几个小时**才跨月。
 *   在东八区,1 号 00:00–08:00 用 `toISOString().slice(0, 7)` 拿到的是**上个月** ——
 *   那几个小时里登记的发票会落进上一个会计期间,而那个期间可能已经关账。
 */
export function zonedMonth(at: Date, tz: string): string {
  return zonedDate(at, tz).slice(0, 7)
}

// 该时刻在指定时区的偏移(毫秒,东八区 = +8h)。做法:把「当地钟面时间」当成 UTC 读一遍,差值即偏移。
function offsetMsAt(at: Date, tz: string): number {
  const p = partsIn(at, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000
}

/**
 * 指定时区的「某天某点」对应的绝对时刻(UTC)。用于把「当天 0 点 / 9 点」落成真正的 Date。
 * ★两趟:先按 UTC 猜一个时刻取偏移、再用修正后的时刻复算一次 —— 夏令时切换日偏移会变,一趟会差 1 小时。
 *   (东八区没有夏令时,第二趟等价于空转;写上是为了换到有夏令时的地区时不出错。)
 */
export function zonedTimeToUtc(date: string, hour: number, tz: string, minute = 0): Date {
  const [y, m, d] = date.split('-').map(Number)
  const wallClock = Date.UTC(y!, m! - 1, d!, hour, minute)
  const firstPass = wallClock - offsetMsAt(new Date(wallClock), tz)
  return new Date(wallClock - offsetMsAt(new Date(firstPass), tz))
}

// 「当地钟面时间」串(无时区偏移):YYYY-MM-DD[ T]HH:mm[:ss]。分隔符收空格或 T,秒可省。
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/
/**
 * 把一个**不带时区偏移**的「当地钟面时间」串按系统时区解释成绝对时刻(UTC)。
 * 用于 LLM 算出的相对时间落库:模型据「现在=当地时间」把「明天下午2点」换算成钟面串
 * 「2026-08-12 14:00」,这个 14:00 是**当地**的 14 点,不能交给 `new Date(str)` —— 那会按
 * 进程时区(容器默认 UTC)解释成 14:00Z(东八区的 22 点),整整差一个时区偏移。
 *
 * ★只认无偏移的钟面串;带 `Z` / `+08:00` 的串本就有绝对含义,返回 null 交回调用方用 `new Date` 直解。
 *   无法解析(格式不符)也返回 null。秒被丢弃(相对时间到分钟即可)。
 */
export function zonedWallClockToUtc(wallClock: string, tz: string): Date | null {
  const m = WALL_CLOCK_RE.exec(wallClock.trim())
  if (!m) return null
  const [, y, mo, d, hh, mm] = m
  return zonedTimeToUtc(`${y}-${mo}-${d}`, Number(hh), tz, Number(mm))
}

/** 该时刻在指定时区是星期几(0=周日…6=周六,与 JS getDay 同口径)。「发送日」判定用。 */
export function zonedWeekday(at: Date, tz: string): number {
  // 拿当地日期再按 UTC 读它的星期,避开二次时区换算
  return new Date(`${zonedDate(at, tz)}T00:00:00Z`).getUTCDay()
}

/** 该时刻所在「当地日」的起点(绝对时刻)。「今天有没有填跟进」这类窗口的左端。 */
export function zonedDayStart(at: Date, tz: string): Date {
  return zonedTimeToUtc(zonedDate(at, tz), 0, tz)
}
