// core/backup/verify.ts
// 备份定级(纯函数):ok / suspect / failed。轮转拿它当判据 —— **只有 ok 有资格参与好备份的淘汰**。
//
// ★这道闸拦得住什么、拦不住什么,必须说清楚,否则它会变成一块「看着安全」的招牌:
//
//   ① 库坏了 / 服务挂了 / dump 不完整 → pg_dump 非零退出、或 pg_restore 读不出清单。**拦得住。**
//   ② 库很健康,但数据错了(误删一批客户、跑错一条 UPDATE、迁移写坏字段)
//      → pg_dump 完全成功、pg_restore 完全正常。**拦不住** —— 任何技术校验都看不出来。
//
//   对 ② 只有两件事有用:一是下面的「体量/行数突降」粗筛(只抓得住**大批量**删除),
//   二是分层保留给出的**时间跨度**(见 retention.ts)。滚动三天之所以不够,正是因为
//   ② 常常过了三天才被发现 —— 月底对账、客户投诉才知道上周的数据没了。
//
// ★ok ≠ 验证过能恢复。默认档的 ok 只代表「dump 跑完了 + 清单读得出 + 体量没异常」,
//   **没有真的 restore 过一遍**。真 restore 校验要建临时库(权限/磁盘各客户不一),
//   本轮不做。别在 UI 上把 ok 写成「已验证可恢复」—— 把「没检查过」渲染成「检查通过」
//   是这类功能唯一的致命失败模式。

import type { BackupVerdict } from './retention'

/** dump 字节数低于上一份 ok 的这个比例 → suspect */
export const SIZE_SHRINK_RATIO = 0.7
/** 任一关键表行数低于上一份 ok 的这个比例 → suspect */
export const ROW_SHRINK_RATIO = 0.8
/** 行数比例判定的最小基数:小表天然波动大(3→2 就是 -33%),按比例判会天天误报 */
export const MIN_ROWS_FOR_RATIO = 50

export type TableRowCounts = Record<string, number>

export type VerifyInput = {
  /** pg_dump 退出码。★必须是**直接**拿到的退出码,不能来自管道 —— 管道的退出码是最后一段命令的 */
  dumpExitCode: number
  dumpStderr: string
  sizeBytes: number
  /** pg_restore --list 是否成功解析 */
  restoreListOk: boolean
  /** 清单里的对象数(0 = 空 dump,和解析失败一样致命) */
  restoreListObjects: number
  /** 本次 dump 时刻的关键表行数快照(估计值,见 service.ts 的取数注释) */
  rowCounts: TableRowCounts
  /** 上一份 ok 备份的对照基准;null = 这是第一份 */
  prev: { sizeBytes: number; rowCounts: TableRowCounts } | null
}

export type VerifyResult = { verdict: BackupVerdict; reasons: string[] }

export function verifyDump(input: VerifyInput): VerifyResult {
  const fatal: string[] = []
  if (input.dumpExitCode !== 0) {
    fatal.push(`pg_dump 退出码 ${input.dumpExitCode}${input.dumpStderr.trim() ? `:${input.dumpStderr.trim().slice(0, 300)}` : ''}`)
  }
  if (input.sizeBytes <= 0) fatal.push('dump 文件为空')
  if (!input.restoreListOk) fatal.push('pg_restore --list 解析不了这个 dump')
  else if (input.restoreListObjects <= 0) fatal.push('pg_restore --list 解析出 0 个对象')
  if (fatal.length) return { verdict: 'failed', reasons: fatal }

  // ★第一份没有对照基准,不能因此判 suspect —— 否则新装的客户第一次备份永远是 suspect,
  //   而 suspect 不参与好备份的额度,等于第一天就把这套机制的信号搞坏了。
  if (!input.prev) return { verdict: 'ok', reasons: [] }

  const suspect: string[] = []
  if (input.prev.sizeBytes > 0 && input.sizeBytes < input.prev.sizeBytes * SIZE_SHRINK_RATIO) {
    const pct = Math.round((input.sizeBytes / input.prev.sizeBytes) * 100)
    suspect.push(`dump 体量骤降到上一份的 ${pct}%(${input.prev.sizeBytes} → ${input.sizeBytes} 字节)`)
  }
  for (const [table, prevRows] of Object.entries(input.prev.rowCounts)) {
    if (prevRows < MIN_ROWS_FOR_RATIO) continue
    const now = input.rowCounts[table]
    // ★「上一份有、这一份没有」**不能**当成信号 —— 快照是「行数最多的前 N 张表」,
    //   一张表从名单里消失,最常见的原因是**别的表涨上来把它挤出去了**,与它自己有没有被删无关。
    //   靠 top-N 的缺席去判「表被 drop 了」,判据本身就不成立;真按它报 suspect,
    //   只会在表数量正常波动时天天误报(2026-08-17 生产实测栽过一次)。
    //   表真的没了,恢复演练那边点表时会实打实地查不到 —— 那才是有判据的地方(restore-drill.ts)。
    if (now == null) continue
    if (now < prevRows * ROW_SHRINK_RATIO) {
      suspect.push(`表 ${table} 行数骤降 ${prevRows} → ${now}`)
    }
  }
  return suspect.length ? { verdict: 'suspect', reasons: suspect } : { verdict: 'ok', reasons: [] }
}
