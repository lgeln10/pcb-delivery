// 护栏:业务代码里的「时间基准」必须走系统时区,不许用 UTC 日或进程时区。
// ★这一类错在 CI 上永远是绿的(runner 跑 UTC,偏移恰好 0),只在东八区客户的
//   当地 00:00–08:00 才复现 —— 所以只能靠机械扫,不能靠 review。
import { describe, expect, it } from 'vitest'
import { detectTzIssue, listTimezoneIssues } from '../tz-guard'

describe('时间基准护栏', () => {
  // ★先证明它在该报警时会报警,再信它的绿(本仓 verification-tool-traps 那条:
  //   一个永远不报警的检查比没有检查更糟)。
  it('该报警时会报警:两条判据各自命中,注释与安全写法放过', () => {
    expect(detectTzIssue('  const asOf = new Date().toISOString().slice(0, 10)')).toBe('utc-today')
    expect(detectTzIssue('  const asOf = new Date().toISOString().slice(0,10)')).toBe('utc-today') // 无空格写法
    expect(detectTzIssue('  return `${d.getFullYear()}-${d.getMonth() + 1}`')).toBe('process-tz')
    expect(detectTzIssue('  const h = at.getHours()')).toBe('process-tz')
    // 放过:注释里举反例是必要的
    expect(detectTzIssue('// 不要写 new Date().toISOString().slice(0, 10)')).toBeNull()
    expect(detectTzIssue(' * 曾经写成 d.getHours(),那是进程时区')).toBeNull()
    // 放过:UTC 版 getter 是显式意图,纯日期串算术用它是安全的
    expect(detectTzIssue('  date.setUTCDate(date.getUTCDate() + days)')).toBeNull()
    // 放过:正确写法
    expect(detectTzIssue('  const asOf = zonedDate(new Date(), tz)')).toBeNull()
  })

  it('全仓无违规(新增请改用 zonedDate/zonedDateTime/zonedHour,或加进 tz-guard 的 ALLOWLIST 并写明理由)', async () => {
    const issues = await listTimezoneIssues()
    expect(
      issues.map((i) => `${i.rule} ${i.file}:${i.line}  ${i.text}`),
      '时间基准必须按系统设置里的系统时区算',
    ).toEqual([])
  })
})
