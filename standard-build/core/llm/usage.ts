// core/llm/usage.ts
// LLM 调用流水的记录与聚合。
//
// ★**记录永不影响业务**:埋点整段 try/catch 吞掉。一次用量写失败让用户的对话报错,
//   是本末倒置 —— 用量是观测,不是业务。
// ★不记 prompt/response 正文:那是客户业务数据,留在这张表里等于多一份泄露面,
//   而排查用量问题不需要正文。
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { llmUsageLogs } from './usage-model'

export type UsageRecord = {
  scene: string
  provider: string
  model: string
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  latencyMs: number
  ok: boolean
  errorCode?: string
}

/** 记一次调用。**绝不抛** —— 观测失败不该让业务失败。 */
export async function recordUsage(db: Db, tenantId: string, r: UsageRecord): Promise<void> {
  try {
    await db.insert(llmUsageLogs).values({
      id: randomUUID(),
      tenantId,
      scene: r.scene,
      provider: r.provider,
      model: r.model,
      promptTokens: r.promptTokens ?? 0,
      completionTokens: r.completionTokens ?? 0,
      cachedTokens: r.cachedTokens ?? 0,
      latencyMs: Math.round(r.latencyMs),
      ok: r.ok,
      errorCode: (r.errorCode ?? '').slice(0, 200),
    })
  } catch (e) {
    // 只记日志,不抛。表还没迁移到位、库暂时不可写,都不该连累对话。
    console.warn('[llm-usage] 记录失败(已忽略):', e instanceof Error ? e.message : e)
  }
}

export type UsageBySceneRow = {
  scene: string
  calls: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  avgLatencyMs: number
}

/** 按场景聚合最近 N 天。 */
export async function usageByScene(db: Db, ctx: Ctx, days = 30): Promise<UsageBySceneRow[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({
      scene: llmUsageLogs.scene,
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where not ${llmUsageLogs.ok})::int`,
      promptTokens: sql<number>`coalesce(sum(${llmUsageLogs.promptTokens}), 0)::int`,
      completionTokens: sql<number>`coalesce(sum(${llmUsageLogs.completionTokens}), 0)::int`,
      cachedTokens: sql<number>`coalesce(sum(${llmUsageLogs.cachedTokens}), 0)::int`,
      avgLatencyMs: sql<number>`coalesce(avg(${llmUsageLogs.latencyMs}), 0)::int`,
    })
    .from(llmUsageLogs)
    .where(and(eq(llmUsageLogs.tenantId, ctx.tenantId), gte(llmUsageLogs.createdAt, since)))
    .groupBy(llmUsageLogs.scene)
    .orderBy(desc(sql`count(*)`))
  return rows
}

/** 最近 N 天每天的调用量(补齐没有调用的日子,否则折线会把空缺连成直线)。 */
/**
 * 该时刻在指定时区的当地日期(YYYY-MM-DD)。
 *
 * ★与 `modules/app-settings/time.ts` 的 `zonedDate` 同口径,**刻意各留一份**:
 *   core 不反向依赖 modules(那是分层倒置)。这里只有一次 Intl 格式化,没有逻辑可漂;
 *   真要改口径,两处一起改 —— 但 en-CA 输出 YYYY-MM-DD 这件事不会变。
 */
function zonedDay(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/**
 * 按天的调用数曲线。
 *
 * ★`tz` **必填,不给默认值**(2026-08-07)。原来两边各按各的算:
 *   SQL 按**数据库会话时区**分桶,JS 补齐空缺时按 `toISOString()` 即 **UTC** 造 key。
 *   两者在 UTC 机器上恰好一致,于是 CI 永远绿 —— 而部署到设了本地时区的机器上就错位。
 *   给个 `= 'UTC'` 的默认值只会让下一个调用方继续踩,所以必填:tsc 逼每个调用方想一次
 *   「这条曲线的『一天』是谁的一天」。答案永远是**租户的**,不是服务器的。
 */
export async function usageByDay(db: Db, ctx: Ctx, days: number, tz: string): Promise<{ day: string; calls: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  // ★列是 timestamptz,`at time zone '<tz>'` 得到的是该时区的**当地钟面时间**,正是分桶要的
  const localDay = sql<string>`to_char(${llmUsageLogs.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`
  const rows = await db
    .select({ day: localDay, calls: sql<number>`count(*)::int` })
    .from(llmUsageLogs)
    .where(and(eq(llmUsageLogs.tenantId, ctx.tenantId), gte(llmUsageLogs.createdAt, since)))
    // ★按**序号**分组,不是把 localDay 再写一遍:drizzle 会把同一个 sql 模板在 SELECT 和
    //   GROUP BY 里编成不同的参数占位符($1 / $4),Postgres 当成两个不同表达式直接报
    //   「must appear in the GROUP BY clause」。把 tz 拼进 SQL 字符串能绕过,但那是红线。
    .groupBy(sql`1`)
  const byDay = new Map(rows.map((r) => [r.day, r.calls]))
  const out: { day: string; calls: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = zonedDay(new Date(Date.now() - i * 86_400_000), tz)
    out.push({ day: d, calls: byDay.get(d) ?? 0 })
  }
  return out
}
