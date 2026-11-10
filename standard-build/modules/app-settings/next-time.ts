// modules/app-settings/next-time.ts — 「下一步动作时间」缺时分时的默认时刻。**唯一定义。**
//
// 在此之前这段逻辑在 lead/logic.ts 与 opportunity/logic.ts 里各有一份逐字重复的实现,
// 而 partner(客户)侧**一份都没有** —— 于是「记在客户上」的跟进存的是当地零点。
// 同一条判断散在多处,就是缺口埋下的那一刻(playbooks/security §3.2 的形状,这里是业务版)。
//
// ── 为什么不是零点 ──
// 日期选择器不动时分就是 00:00,而到期提醒「到点即发」:真按 00:00 存,提醒在凌晨把人吵醒。
//
// ── 为什么是 9:30 / 13:30 而不是整点 ──
// 销售嘴里的「下周三跟进」指的是上班之后,不是刚上班那一刻;9:00 常与晨会、通勤撞上。
// 9:30 / 13:30 是「已经坐下、还没进入下一件事」的位置,提醒在这个点最可能被真正处理。
// (2026-08-25 按 yibing 的实际使用反馈定的:原来是 9:00 整点。)
import type { Db } from '../../core/db/client'
import { getTenantTimezone } from './logic'
import { zonedDate, zonedDayStart, zonedTimeToUtc } from './time'

/** 只知道日期(或压根没说时间)→ 当天上午这个点。 */
export const DEFAULT_NEXT_TIME_MORNING = { hour: 9, minute: 30 } as const
/** 说了「下午」但没说几点 → 当天下午这个点。 */
export const DEFAULT_NEXT_TIME_AFTERNOON = { hour: 13, minute: 30 } as const

/**
 * 写入侧兜底:落在**租户时区当天零点**的时刻 → 挪到当天 9:30;其余原样返回。
 *
 * ★判定「没给时分」= 正好是当地零点。用户真想约零点属极罕见,让位给这个默认。
 * ★放在写入侧而不是提醒侧:列表里看到的「下次跟进 09:30」就是真正会提醒的时刻,两处不打架。
 * ★AI 那条路已经能表达「下午」(见 crm-assistant/tools.ts 的 parseNextTime),
 *   到这里时它带着 13:30 这种真时分,不是零点,所以不会被本函数改动 —— 两条路各管各的。
 */
export async function withDefaultNextTime(db: Db, tenantId: string, nextTime?: Date): Promise<Date | undefined> {
  if (!nextTime) return undefined
  const tz = await getTenantTimezone(db, tenantId)
  if (zonedDayStart(nextTime, tz).getTime() !== nextTime.getTime()) return nextTime
  const { hour, minute } = DEFAULT_NEXT_TIME_MORNING
  return zonedTimeToUtc(zonedDate(nextTime, tz), hour, tz, minute)
}
