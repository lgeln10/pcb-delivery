// LLM 用量流水:记录 + 聚合。
//
// ★这条测试的意义不是「函数能跑」,而是钉住**用量页不会骗人**的三条性质:
//   ① 失败必须被记下 —— 否则「一直在报错」会显示成「没人用」,那是最误导的一种空
//   ② recordUsage 绝不抛 —— 观测失败不该让业务失败
//   ③ 没调用的日子要补 0 —— 否则折线会把空缺连成直线,看着像一直在用
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { recordUsage, usageByDay, usageByScene } from '../usage'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db)).ownerCtx
}, 60_000)
afterAll(async () => t.close())

describe('记录与聚合', () => {
  it('按场景聚合:次数 / 失败 / token / 平均耗时', async () => {
    for (let i = 0; i < 3; i++) {
      await recordUsage(t.db, ctx.tenantId, {
        scene: 'pcb_cam', provider: 'ark', model: 'glm-5-2',
        promptTokens: 100, completionTokens: 20, cachedTokens: 80, latencyMs: 2000, ok: true,
      })
    }
    await recordUsage(t.db, ctx.tenantId, {
      scene: 'pcb_cam', provider: 'ark', model: 'glm-5-2', latencyMs: 4000, ok: false, errorCode: 'LLM_ERROR',
    })
    await recordUsage(t.db, ctx.tenantId, {
      scene: 'vision', provider: 'ark', model: 'glm-5-2', promptTokens: 50, completionTokens: 10, latencyMs: 1000, ok: true,
    })

    const rows = await usageByScene(t.db, ctx, 30)
    const crm = rows.find((r) => r.scene === 'pcb_cam')!
    expect(crm.calls).toBe(4)
    // ★失败必须被记下 —— 否则「一直在报错」会显示成「没人用」
    expect(crm.failed).toBe(1)
    expect(crm.promptTokens).toBe(300)
    expect(crm.completionTokens).toBe(60)
    expect(crm.cachedTokens).toBe(240)
    // 平均含失败那次:(2000*3 + 4000) / 4 = 2500
    expect(crm.avgLatencyMs).toBe(2500)

    // 调用多的场景排前面 —— 这一页是用来找「谁在花钱」的
    expect(rows[0]!.scene).toBe('pcb_cam')
  })

  it('★没调用的日子补 0,不是缺行(否则折线会把空缺连成直线)', async () => {
    const days = await usageByDay(t.db, ctx, 7, 'UTC')
    expect(days.length).toBe(7)
    expect(days.every((d) => typeof d.calls === 'number')).toBe(true)
    // 今天有刚才那 5 条
    expect(days.at(-1)!.calls).toBe(5)
    // 昨天没有 —— 必须是 0 而不是不存在
    expect(days.at(-2)!.calls).toBe(0)
  })

  // ★这一组盯的是 2026-08-07 那个 bug:SQL 按数据库会话时区分桶、JS 按另一个时区造 key。
  //   两边在 UTC 机器上恰好一致 —— 所以 CI(跑在 UTC)永远绿,只有本地时区非 UTC 才露馅。
  //
  // ★第一版这组是**空的**:只断言「总数还是 5」和「最后一格的日期对不对」。都抓不到 ——
  //   补齐生成的是 7 天窗口,错位一天的桶照样落在窗口**里面**,总数不变;
  //   而「最后一格的日期」纯由 JS 算,SQL 怎么错都不影响它。反向验证(把 SQL 的
  //   `at time zone` 拿掉)当场全绿,才发现白写了。
  //   真正该钉的是:**这批刚写入的数据,落在该时区「今天」那一格**。
  describe('★「一天」按传进来的时区切,不是按服务器的', () => {
    const dayIn = (at: Date, tz: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

    // 跨日的极端时区:不管跑测试的机器在哪个时区,这几个里总有与 UTC 不同日的
    for (const tz of ['UTC', 'Asia/Shanghai', 'Pacific/Kiritimati', 'Pacific/Midway']) {
      it(`${tz}:刚写入的 5 条落在该时区「今天」那一格`, async () => {
        const days = await usageByDay(t.db, ctx, 7, tz)
        expect(days.length).toBe(7)
        const today = dayIn(new Date(), tz)
        expect(days.at(-1)!.day, '窗口最后一格不是该时区的今天').toBe(today)
        expect(
          days.at(-1)!.calls,
          `${tz}: 今天的数据没落在今天那一格 —— SQL 分桶用的时区与补齐用的对不上`,
        ).toBe(5)
      })
    }
  })

  it('★recordUsage 绝不抛 —— 观测失败不该让业务失败', async () => {
    // 传一个不存在的租户 id 形状(uuid 但无对应租户):插入本身仍会成功(流水不设外键),
    // 真正要验的是**任何异常都被吞掉**,所以这里直接给一个非法 uuid 逼它出错。
    await expect(
      recordUsage(t.db, 'not-a-uuid', { scene: 'x', provider: 'p', model: 'm', latencyMs: 1, ok: true }),
    ).resolves.toBeUndefined()
  })

  it('租户隔离:别的租户的调用不进本租户的统计', async () => {
    const other = (await seedTenant(t.db)).ownerCtx
    await recordUsage(t.db, other.tenantId, { scene: 'pcb_cam', provider: 'ark', model: 'm', latencyMs: 1, ok: true })
    const mine = await usageByScene(t.db, ctx, 30)
    expect(mine.find((r) => r.scene === 'pcb_cam')!.calls).toBe(4) // 仍是 4,没被别人的那条污染
  })
})
