// core/backup/tests/retention.test.ts
// 分层保留的判定。★这一族用例的核心是那条不变量:**坏备份永远不能淘汰好备份** ——
// 也就是用户提的那个场景:「库坏了,连备三天,把之前正常的备份全顶掉了」。
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, isMonthlyAnchor, isWeeklyAnchor, planRetention, type RetentionRow } from '../retention'

const row = (localDate: string, verdict: RetentionRow['verdict'] = 'ok', sizeBytes = 1000): RetentionRow => ({
  id: `${localDate}-${verdict}`,
  localDate,
  verdict,
  sizeBytes,
})
const keptIds = (rows: RetentionRow[], limits = DEFAULT_LIMITS) => planRetention(rows, limits).keep.map((k) => k.id).sort()
const prunedIds = (rows: RetentionRow[], limits = DEFAULT_LIMITS) => planRetention(rows, limits).prune.map((p) => p.id).sort()

describe('锚点判定', () => {
  it('周锚点是周日', () => {
    // 2026-08-16 是周日,08-17 是周一
    expect(isWeeklyAnchor('2026-08-16')).toBe(true)
    expect(isWeeklyAnchor('2026-08-17')).toBe(false)
  })

  it('★周锚点与运行机器的时区无关(用 UTC 星期几,不是本地星期几)', () => {
    const tz = process.env.TZ
    try {
      // 西半球:本地星期几会比 UTC 差一天;判定必须不变
      process.env.TZ = 'America/Los_Angeles'
      expect(isWeeklyAnchor('2026-08-16')).toBe(true)
      process.env.TZ = 'Asia/Shanghai'
      expect(isWeeklyAnchor('2026-08-16')).toBe(true)
    } finally {
      process.env.TZ = tz
    }
  })

  it('月锚点是每月 1 日', () => {
    expect(isMonthlyAnchor('2026-08-01')).toBe(true)
    expect(isMonthlyAnchor('2026-08-10')).toBe(false)
  })
})

describe('分层保留', () => {
  it('只有 3 份日备时全留,一份都不删', () => {
    const rows = [row('2026-08-17'), row('2026-08-16'), row('2026-08-15')]
    expect(prunedIds(rows)).toEqual([])
  })

  it('第 4 天把最老那份日备删掉(用户要的滚动三天)', () => {
    // 全是普通工作日,没有周/月锚点插手
    const rows = [row('2026-08-20'), row('2026-08-19'), row('2026-08-18'), row('2026-08-17')]
    expect(prunedIds(rows)).toEqual(['2026-08-17-ok'])
  })

  it('周日那份被提升为周备,滚出三天窗口后仍然留着', () => {
    // 08-16 是周日。四份日备本该把它滚掉,但它是周锚点
    const rows = [row('2026-08-19'), row('2026-08-18'), row('2026-08-17'), row('2026-08-16')]
    expect(prunedIds(rows)).toEqual([])
    expect(planRetention(rows).keep.find((k) => k.id === '2026-08-16-ok')?.reasons).toContain('weekly')
  })

  it('每月 1 日那份被提升为月备', () => {
    const rows = [row('2026-08-20'), row('2026-08-19'), row('2026-08-18'), row('2026-08-01')]
    expect(prunedIds(rows)).toEqual([])
    expect(planRetention(rows).keep.find((k) => k.id === '2026-08-01-ok')?.reasons).toContain('monthly')
  })

  it('日备/周备/月备可以叠在同一份上,不会因为算了两次而多留', () => {
    // 2026-11-01 既是周日又是 1 号
    const rows = [row('2026-11-01')]
    const plan = planRetention(rows)
    expect(plan.keep).toHaveLength(1)
    expect(plan.keep[0]!.reasons.sort()).toEqual(['daily', 'last-known-good', 'monthly', 'weekly'])
  })
})

describe('★坏备份不能淘汰好备份(用户提的那个场景)', () => {
  it('库坏了连备三天,三份好备份一份都不掉', () => {
    const good = [row('2026-08-14'), row('2026-08-13'), row('2026-08-12')]
    const bad = [row('2026-08-17', 'suspect'), row('2026-08-16', 'suspect'), row('2026-08-15', 'failed')]
    const pruned = prunedIds([...bad, ...good])
    // 三份 ok 全在
    expect(pruned).not.toContain('2026-08-14-ok')
    expect(pruned).not.toContain('2026-08-13-ok')
    expect(pruned).not.toContain('2026-08-12-ok')
    // 坏备份自己受额度约束(默认留 2 份给人排查),最老那份坏的被清掉
    expect(pruned).toEqual(['2026-08-15-failed'])
  })

  it('坏备份再多也只占自己的额度,好备份的三天窗口不受影响', () => {
    const good = [row('2026-08-10'), row('2026-08-09'), row('2026-08-08')]
    const bad = Array.from({ length: 10 }, (_, i) => row(`2026-08-${11 + i}`, 'failed'))
    const kept = keptIds([...bad, ...good])
    expect(kept).toContain('2026-08-10-ok')
    expect(kept).toContain('2026-08-09-ok')
    expect(kept).toContain('2026-08-08-ok')
    expect(kept.filter((id) => id.endsWith('-failed'))).toHaveLength(DEFAULT_LIMITS.bad)
  })

  it('最近一份 ok 被钉住:哪怕它已经很老、早滚出三天窗口', () => {
    // 只有一份 ok(很老),后面全是坏的
    const rows = [row('2026-07-01'), row('2026-08-17', 'failed'), row('2026-08-16', 'failed')]
    const plan = planRetention(rows)
    expect(plan.keep.find((k) => k.id === '2026-07-01-ok')?.reasons).toContain('last-known-good')
    expect(plan.prune.map((p) => p.id)).not.toContain('2026-07-01-ok')
  })
})

describe('★钉住「真恢复过」的那一份(恢复演练的产物)', () => {
  const verified = (localDate: string, sizeBytes = 1000): RetentionRow => ({
    id: `${localDate}-ok`,
    localDate,
    verdict: 'ok',
    sizeBytes,
    restoreVerified: true,
  })

  it('演练过的那份即使早滚出三天窗口,也不被淘汰', async () => {
    // 08-11 演练通过过;后面四天的日备本该把它滚掉(08-11 是周二,不是周/月锚点)
    const rows = [row('2026-08-14'), row('2026-08-13'), row('2026-08-12'), verified('2026-08-11')]
    const plan = planRetention(rows)
    expect(plan.prune.map((p) => p.id)).not.toContain('2026-08-11-ok')
    expect(plan.keep.find((k) => k.id === '2026-08-11-ok')?.reasons).toContain('last-restore-verified')
  })

  it('最新那份就是演练过的那份时,两个钉子重合,不多占一份', () => {
    const plan = planRetention([verified('2026-08-14'), row('2026-08-13')])
    const newest = plan.keep.find((k) => k.id === '2026-08-14-ok')!
    expect(newest.reasons).toContain('last-known-good')
    expect(newest.reasons).toContain('last-restore-verified')
    expect(plan.keep).toHaveLength(2)
  })

  it('★总额度再紧也不砍它(它是唯一一份「确定能救你」的)', () => {
    const rows = [row('2026-08-14', 'ok', 999_999), verified('2026-08-11', 999_999)]
    const plan = planRetention(rows, { ...DEFAULT_LIMITS, maxTotalBytes: 1 })
    const kept = plan.keep.map((k) => k.id).sort()
    expect(kept).toEqual(['2026-08-11-ok', '2026-08-14-ok'])
  })

  it('★没演练过 ≠ 演练没过:restoreVerified 缺省时不钉,但也不因此被优先砍', () => {
    // 全都没演练过 → 只有 last-known-good 一个钉子,行为与加这个特性之前完全一致
    const rows = [row('2026-08-14'), row('2026-08-13'), row('2026-08-12'), row('2026-08-11')]
    const plan = planRetention(rows)
    expect(plan.keep.flatMap((k) => k.reasons)).not.toContain('last-restore-verified')
    expect(plan.prune.map((p) => p.id)).toEqual(['2026-08-11-ok'])
  })
})

describe('总额度裁剪', () => {
  const limits = { ...DEFAULT_LIMITS, maxTotalBytes: 2500 }

  it('牺牲顺序:先砍坏备份,再砍月备/周备,日备最后', () => {
    const rows = [
      row('2026-08-20', 'ok', 1000), // 日备(也是 last-known-good)
      row('2026-08-19', 'ok', 1000), // 日备
      row('2026-08-01', 'ok', 1000), // 月备
      row('2026-08-18', 'failed', 1000), // 坏的
    ]
    const plan = planRetention(rows, limits)
    const pruned = plan.prune.map((p) => p.id)
    // 坏的先走,然后月备;两份日备都留下
    expect(pruned).toContain('2026-08-18-failed')
    expect(pruned).toContain('2026-08-01-ok')
    expect(pruned).not.toContain('2026-08-20-ok')
    expect(pruned).not.toContain('2026-08-19-ok')
  })

  it('★额度再小也不会砍掉 last-known-good —— 一份不剩比没有备份更糟', () => {
    const rows = [row('2026-08-20', 'ok', 999_999), row('2026-08-19', 'ok', 999_999)]
    const plan = planRetention(rows, { ...DEFAULT_LIMITS, maxTotalBytes: 1 })
    expect(plan.keep).toHaveLength(1)
    expect(plan.keep[0]!.id).toBe('2026-08-20-ok')
    expect(plan.keep[0]!.reasons).toContain('last-known-good')
  })

  it('没超额度就一份不动', () => {
    const rows = [row('2026-08-20', 'ok', 100), row('2026-08-19', 'ok', 100)]
    expect(planRetention(rows, limits).prune).toEqual([])
  })
})
