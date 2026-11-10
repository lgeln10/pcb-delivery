// core/backup/tests/verify.test.ts
// 备份定级。★这里同时钉住一条**否定性**事实:体量/行数正常的 dump 一律 ok ——
// 也就是说这道闸**拦不住「库健康但数据被改错」**。别把它当成「验证过能恢复」。
import { describe, expect, it } from 'vitest'
import { MIN_ROWS_FOR_RATIO, verifyDump, type VerifyInput } from '../verify'

const base: VerifyInput = {
  dumpExitCode: 0,
  dumpStderr: '',
  sizeBytes: 10_000,
  restoreListOk: true,
  restoreListObjects: 500,
  rowCounts: { leads: 100, employees: 60 },
  prev: { sizeBytes: 10_000, rowCounts: { leads: 100, employees: 60 } },
}

describe('failed:硬失败', () => {
  it('pg_dump 非零退出 → failed,且原始 stderr 带进 reasons', () => {
    const r = verifyDump({ ...base, dumpExitCode: 1, dumpStderr: 'pg_dump: error: server version: 17.10; pg_dump version: 16.14' })
    expect(r.verdict).toBe('failed')
    expect(r.reasons.join()).toContain('16.14')
  })

  it('dump 文件为空 → failed', () => {
    expect(verifyDump({ ...base, sizeBytes: 0 }).verdict).toBe('failed')
  })

  it('pg_restore --list 解析不了 → failed', () => {
    expect(verifyDump({ ...base, restoreListOk: false }).verdict).toBe('failed')
  })

  it('清单解析出 0 个对象 → failed(能打开但里面什么都没有)', () => {
    expect(verifyDump({ ...base, restoreListObjects: 0 }).verdict).toBe('failed')
  })
})

describe('suspect:体量/行数骤降', () => {
  it('dump 体量掉到上一份的一半 → suspect', () => {
    const r = verifyDump({ ...base, sizeBytes: 5000 })
    expect(r.verdict).toBe('suspect')
    expect(r.reasons.join()).toContain('体量骤降')
  })

  it('关键表行数骤降 → suspect(这是「有人删了一批数据」的粗筛)', () => {
    const r = verifyDump({ ...base, rowCounts: { leads: 10, employees: 60 } })
    expect(r.verdict).toBe('suspect')
    expect(r.reasons.join()).toContain('leads')
  })

  it('★上一份有、这一份没有的表**不算信号** —— 快照是 top-N,掉出名单最常见的原因是别的表涨上来了', () => {
    // 2026-08-17 生产实测:原来这里判 suspect,结果在表数量正常波动时误报。
    // 表真的没了,恢复演练点表时会实打实地查不到 —— 那才是有判据的地方。
    const r = verifyDump({ ...base, rowCounts: { employees: 60 } })
    expect(r.verdict).toBe('ok')
    expect(r.reasons).toEqual([])
  })

  it('掉出名单的表不算,但还在名单里且骤降的照抓', () => {
    const r = verifyDump({ ...base, rowCounts: { leads: 10 } }) // employees 掉出名单 + leads 骤降
    expect(r.verdict).toBe('suspect')
    expect(r.reasons.join()).toContain('leads')
    expect(r.reasons.join()).not.toContain('employees')
  })

  it('★小表的波动不算:低于 MIN_ROWS_FOR_RATIO 的表按比例判会天天误报', () => {
    const small = MIN_ROWS_FOR_RATIO - 1
    const r = verifyDump({
      ...base,
      rowCounts: { tiny: 1, leads: 100, employees: 60 },
      prev: { sizeBytes: 10_000, rowCounts: { tiny: small, leads: 100, employees: 60 } },
    })
    expect(r.verdict).toBe('ok')
  })
})

describe('ok', () => {
  it('体量小幅波动、行数在涨 → ok', () => {
    expect(verifyDump({ ...base, sizeBytes: 9500, rowCounts: { leads: 120, employees: 61 } }).verdict).toBe('ok')
  })

  it('★第一份没有对照基准时判 ok,不判 suspect', () => {
    // 反过来的话,新装客户第一次备份永远是 suspect,而 suspect 不参与好备份额度 ——
    // 等于第一天就把这套机制的信号搞坏了。
    expect(verifyDump({ ...base, prev: null }).verdict).toBe('ok')
  })

  it('★库健康但数据被改错时,这道闸判 ok —— 它本来就拦不住这种,兜底靠分层保留的时间跨度', () => {
    // 场景:某张表被误更新(金额全写错),行数与体量都没变
    const r = verifyDump({ ...base, rowCounts: { leads: 100, employees: 60 } })
    expect(r.verdict).toBe('ok')
    expect(r.reasons).toEqual([])
  })
})
