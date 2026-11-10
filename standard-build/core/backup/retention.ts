// core/backup/retention.ts
// 分层保留的**纯函数**:给一组还活着的备份台账行,算出留哪些、删哪些。
//
// ★为什么整块是纯函数:真正跑 pg_dump 的那条路在测试里跑不了(测试库是 PGlite,进程内 Postgres,
//   没有 pg_dump/pg_restore 二进制)。所以「保留策略」这个最容易算错、也最要命的部分被抽成
//   不碰库、不碰盘的纯函数,能被穷举测试;剩下的执行层靠依赖注入换假 runner 测。
//
// ★没有 tier / pinned 这两个列:档位(日/周/月)与「钉住哪一份」全部由 (local_date, verdict) 现算。
//   存派生状态就会漂移 —— 备份被删了一份、或者某天补跑了一次,存下来的 tier 立刻和事实对不上,
//   而这种漂移只有在你真要恢复的那天才会发现。
//
// ★★本模块要守的那条不变量:**坏备份永远不能淘汰好备份。**
//   实现方式不是加判断,而是把两个集合**分开算额度** —— good 的淘汰只在 good 内部发生,
//   bad 有自己独立的小额度。集合分开,就没有「坏的顶掉好的」这条路径可走。

export const BACKUP_VERDICTS = ['ok', 'suspect', 'failed'] as const
export type BackupVerdict = (typeof BACKUP_VERDICTS)[number]

export type RetentionRow = {
  id: string
  /** 本地日历日 `YYYY-MM-DD`(按 BACKUP_TZ 算,不是 UTC —— 见 config.ts 的时区注释) */
  localDate: string
  verdict: BackupVerdict
  sizeBytes: number
  /** 恢复演练**通过**过(见 restore-drill.ts)。缺省 false = 没验过,**不是**验过没通过 */
  restoreVerified?: boolean
}

export type RetentionLimits = {
  /** 滚动日备份数(用户要的「近三天」) */
  daily: number
  /** 周备份数:由周日那份日备**提升**而来,不额外 dump */
  weekly: number
  /** 月备份数:由每月 1 日那份提升而来 */
  monthly: number
  /** suspect/failed 合计留几份(给人排查用,不承担恢复职责) */
  bad: number
  /** 总磁盘额度;null = 不限。超额时按「牺牲顺序」逐份下线,见 trimToBudget */
  maxTotalBytes: number | null
}

export const DEFAULT_LIMITS: RetentionLimits = { daily: 3, weekly: 1, monthly: 1, bad: 2, maxTotalBytes: null }

/**
 * 一份备份被留下的全部理由(可叠加:同一份可能既是日备又是周备)。
 *
 * `last-known-good` 与 `last-restore-verified` 是**两个不同的钉子**,都不参与额度裁剪:
 * - `last-known-good` = 最近一份 `ok` —— **状态最新**,但只验到「dump 跑完、清单读得回来」;
 * - `last-restore-verified` = 最近一份**真恢复出来过**的(见 restore-drill.ts)—— 可能旧几天,
 *   但它是唯一一份「确定能救你」的。
 * 两者常常是同一份(那就零额外成本);一旦最新那份还没轮到演练、或者演练没过,
 * 这两个钉子就会分开 —— 而那正是你最需要旧那份还在的时候。
 */
export type KeepReason = 'last-known-good' | 'last-restore-verified' | 'daily' | 'weekly' | 'monthly' | 'triage'

export type RetentionPlan = {
  keep: Array<{ id: string; reasons: KeepReason[] }>
  prune: Array<{ id: string; reason: string }>
}

/** 周锚点 = 周日。★用 getUTCDay 而不是 getDay:`new Date('2026-08-16')` 按 UTC 午夜解析,
 *  取 UTC 星期几得到的正是这个**日历日**的星期几,与运行机器的时区无关。
 *  用 getDay 的话,东八区跑出来会是对的、CI 跑 UTC 也是对的,而西半球的机器会整体差一天 ——
 *  典型的「本地绿、CI 绿、某台机器歪」。 */
export function isWeeklyAnchor(localDate: string): boolean {
  return new Date(`${localDate}T00:00:00Z`).getUTCDay() === 0
}

/** 月锚点 = 每月 1 日 */
export function isMonthlyAnchor(localDate: string): boolean {
  return localDate.endsWith('-01')
}

/** 日期倒序(新→旧);同日再按 id 稳定排,避免不同引擎下顺序抖动导致计划不可复现 */
function byDateDesc(a: RetentionRow, b: RetentionRow): number {
  if (a.localDate !== b.localDate) return a.localDate < b.localDate ? 1 : -1
  return a.id < b.id ? 1 : -1
}

/**
 * 算保留计划。入参只应包含**对象还在**的行(`pruned_at is null`);已经删掉对象的历史行
 * 留在台账里做审计,不参与额度。
 */
export function planRetention(rows: RetentionRow[], limits: RetentionLimits = DEFAULT_LIMITS): RetentionPlan {
  const good = rows.filter((r) => r.verdict === 'ok').sort(byDateDesc)
  const bad = rows.filter((r) => r.verdict !== 'ok').sort(byDateDesc)

  const reasons = new Map<string, KeepReason[]>()
  const mark = (id: string, why: KeepReason) => {
    const cur = reasons.get(id)
    if (cur) {
      if (!cur.includes(why)) cur.push(why)
    } else reasons.set(id, [why])
  }

  // ★last-known-good 先标:最近一份 ok 的备份,后面的额度裁剪一律绕开它。
  //   它是「至少还能恢复到某个已知正常状态」的底线,宁可超磁盘额度也不砍。
  if (good[0]) mark(good[0].id, 'last-known-good')
  // ★最近一份真恢复过的,同样钉住。它可能比 last-known-good 旧几天 —— 那正是它值钱的地方。
  const verified = good.find((r) => r.restoreVerified)
  if (verified) mark(verified.id, 'last-restore-verified')
  for (const r of good.slice(0, limits.daily)) mark(r.id, 'daily')
  for (const r of good.filter((r) => isWeeklyAnchor(r.localDate)).slice(0, limits.weekly)) mark(r.id, 'weekly')
  for (const r of good.filter((r) => isMonthlyAnchor(r.localDate)).slice(0, limits.monthly)) mark(r.id, 'monthly')
  // bad 的额度独立,永远不与 good 争 —— 这就是「坏备份不能顶掉好备份」的实现。
  for (const r of bad.slice(0, limits.bad)) mark(r.id, 'triage')

  const plan: RetentionPlan = { keep: [], prune: [] }
  for (const r of [...good, ...bad]) {
    const why = reasons.get(r.id)
    if (why) plan.keep.push({ id: r.id, reasons: why })
    else plan.prune.push({ id: r.id, reason: r.verdict === 'ok' ? '超出分层保留额度' : '超出坏备份排查额度' })
  }

  trimToBudget(plan, rows, limits)
  return plan
}

/**
 * 总额度裁剪。**牺牲顺序 = 恢复价值从低到高**:
 *   ① 坏备份(只用于排查,不承担恢复)→ ② 只因月备被留的 → ③ 只因周备被留的 → ④ 日备里最老的。
 * 两个钉子(`last-known-good` / `last-restore-verified`)不在候选里,任何情况下都不砍 ——
 * 砍到一份不剩的备份系统比没有备份更糟,因为面板上还显示着「已启用」。
 */
function trimToBudget(plan: RetentionPlan, rows: RetentionRow[], limits: RetentionLimits): void {
  if (limits.maxTotalBytes == null) return
  const size = new Map(rows.map((r) => [r.id, r.sizeBytes]))
  const dateOf = new Map(rows.map((r) => [r.id, r.localDate]))
  let total = plan.keep.reduce((s, k) => s + (size.get(k.id) ?? 0), 0)
  if (total <= limits.maxTotalBytes) return

  const rank = (reasons: KeepReason[]): number => {
    // 两个钉子都不可牺牲:一个是「状态最新」,一个是「确定能救你」
    if (reasons.includes('last-known-good') || reasons.includes('last-restore-verified')) return -1
    if (reasons.includes('triage')) return 0
    if (reasons.includes('daily')) return 3
    if (reasons.includes('weekly')) return 2
    return 1 // 只剩 monthly
  }
  // 同一档内先砍最老的
  const candidates = plan.keep
    .map((k) => ({ ...k, rank: rank(k.reasons), date: dateOf.get(k.id) ?? '' }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.date < b.date ? -1 : 1))

  for (const c of candidates) {
    if (total <= limits.maxTotalBytes) break
    const i = plan.keep.findIndex((k) => k.id === c.id)
    if (i < 0) continue
    plan.keep.splice(i, 1)
    plan.prune.push({ id: c.id, reason: `总额度超限(${c.reasons.join('+')})` })
    total -= size.get(c.id) ?? 0
  }
}
