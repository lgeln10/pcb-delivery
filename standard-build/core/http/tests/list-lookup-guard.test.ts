// 质量护栏固化:分页列表的结果不得用于 .find() 反查(CLAUDE.md 红线「无上限的列表接口」的姊妹条)。
// 起因:2026-07-29 排查「为了快速反查把常用实体拉进内存当缓存,但只拉了 50 条,超出就查不到」
// 这类 bug。逐页核实后发现 payment-voucher 的供应商确实中招(选中第 50 名之后的供应商,
// 收款账户/发票销方静默不填充)。这条测试把那次核对固化下来,新页面再犯会自动变红。
import { describe, expect, it } from 'vitest'
import { listPaginatedLookupIssues } from '../list-lookup-guard'

describe('分页列表反查护栏', () => {
  it('分页接口的结果不得用于 .find() 反查,除非在 ALLOWLIST 里写明理由', async () => {
    const issues = await listPaginatedLookupIssues()
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([])
  })
})
