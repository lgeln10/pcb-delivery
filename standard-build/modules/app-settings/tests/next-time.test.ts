// 「下一步动作时间」默认时刻:唯一定义 + 三个模块的写入侧兜底 + AI 那条路的时段表达。
//
// ★这组用例钉的是一个真实抱怨:跟进里说「下周三下午过来」,记录落成 **01:00**(凌晨)。
//   两条成因各修一处,都在下面有断言:
//   ① 模型用 12 小时制把「下午一点」写成 01:00 —— 现在它可以给「日期 + 下午」,不必编钟点
//   ② 客户(partner)侧根本没有零点兜底 —— 线索/商机有,唯独它漏了
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { DEFAULT_NEXT_TIME_AFTERNOON, DEFAULT_NEXT_TIME_MORNING, withDefaultNextTime } from '../next-time'
import { zonedDateTime, zonedTimeToUtc } from '../time'
import { saveSettings } from '../logic'

const TZ = 'Asia/Shanghai'
let t: OrgTestDb
let ctx: { tenantId: string; employeeId: string }

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ctx = seeded.ownerCtx
  await saveSettings(t.db, ctx, { systemName: '默认时刻测试', logoUrl: null, timezone: TZ })
})
afterAll(() => t.close())

describe('默认时刻(唯一定义)', () => {
  it('当地零点 → 当天 9:30;已带时分的原样不动', async () => {
    const midnight = zonedTimeToUtc('2026-09-02', 0, TZ)
    const got = await withDefaultNextTime(t.db, ctx.tenantId, midnight)
    expect(zonedDateTime(got!, TZ)).toBe('2026-09-02 09:30')

    const afternoon = zonedTimeToUtc('2026-09-02', 13, TZ, 30)
    expect((await withDefaultNextTime(t.db, ctx.tenantId, afternoon))!.getTime()).toBe(afternoon.getTime())
  })

  it('不传时不造值(不给时间就是不给,别自己填一个)', async () => {
    expect(await withDefaultNextTime(t.db, ctx.tenantId, undefined)).toBeUndefined()
  })

  it('默认时刻不是整点 —— 9:00 会撞晨会/通勤,这是有意的', () => {
    expect(DEFAULT_NEXT_TIME_MORNING).toEqual({ hour: 9, minute: 30 })
    expect(DEFAULT_NEXT_TIME_AFTERNOON).toEqual({ hour: 13, minute: 30 })
  })
})
