// core/org/logic/emp-no.ts
// 系统自动工号:No.00001(五位补零),取租户内已有自动工号的最大序号 +1。
// 手工建员工(工号留空)与 Excel 批量导入共用这一套规则,避免两处口径漂移。
// 自定义工号(非 No.数字)不参与序号计算,只由唯一索引保证不重复。
import type { Db } from '../../db/client'
import { scope } from '../../db/soft-delete'
import { employees } from '../model'

const AUTO_EMP_NO_PREFIX = 'No.'
export const AUTO_EMP_NO_RE = /^No\.(\d+)$/

/** 已有工号里最大的自动序号 +1(没有自动工号时从 1 起) */
export function nextAutoEmpNoSerial(existingEmpNos: Iterable<string>): number {
  let max = 0
  for (const empNo of existingEmpNos) {
    const match = AUTO_EMP_NO_RE.exec(empNo)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/** 自动生成工号:No.00001(五位,不足补零) */
export function formatAutoEmpNo(serial: number): string {
  return `${AUTO_EMP_NO_PREFIX}${String(serial).padStart(5, '0')}`
}

/**
 * 生成本租户下一个可用自动工号。软删员工不占号(部分唯一索引 where is_deleted = false,与 scope 口径一致)。
 * 并发同时算出同一个号由唯一索引兜底 → 调用方重算重试(见 createEmployee)。
 */
export async function generateEmpNo(db: Db, tenantId: string): Promise<string> {
  const rows = await db.select({ empNo: employees.empNo }).from(employees).where(scope(employees, tenantId))
  return formatAutoEmpNo(nextAutoEmpNoSerial(rows.map((row) => row.empNo)))
}
