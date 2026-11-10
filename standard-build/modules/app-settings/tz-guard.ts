// modules/app-settings/tz-guard.ts
// 护栏:扫业务代码里「不按系统时区算时间基准」的写法。
//
// ★为什么要机械扫:这一类错**在 CI 上永远是绿的** —— runner 跑 UTC,时区偏移恰好为 0,
//   所有断言都对。只有部署到东八区客户那里、而且只在**当地 00:00–08:00** 这个窗口才复现,
//   表现成「今天到期的单显示成已逾期」「久无跟进天数多一天」「助理把明天理解成今天」。
//   本仓已经踩过三次(见 memory/aios-tz-utc-ci-green-prod-wrong、hotel 的 facility 前滚)。
//   靠 review 记住是不可能的,只能扫。
//
// 判据(两条,都只认**确定错**的形状,不做模糊猜测):
//   ① `new Date().toISOString().slice(0, 10 | 7 | 4)` —— 取的是 **UTC 的今天/本月/今年**。
//      东八区 00:00–08:00 拿到昨天;每月 1 号那几个小时拿到上个月(会计期间可能已关账);元旦早上拿到去年。
//      正确写法:`zonedDate / zonedMonth(new Date(), await getTenantTimezone(db, tenantId))`
//   ② `.getFullYear() / .getMonth() / .getDate() / .getHours() / .getMinutes() / .getDay()`
//      —— 读的是**进程时区**,容器默认 UTC,与租户配置无关。
//      正确写法:`zonedDate / zonedDateTime / zonedHour / zonedWeekday / zonedDayStart`(本模块导出)。
//
// 不扫的:纯日期串算术(`new Date('2026-08-09T00:00:00Z')` 两侧同源、只做加减天数)是安全的,
// 它不涉及「时刻 → 哪一天」的换算;真出问题的一律是**时刻**与**当地日**混用。
//
// 新增豁免:加进 ALLOWLIST 并写清楚为什么这里不需要租户时区。**没有理由就不要加**。
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = process.cwd() // 运行/测试均在 standard-build/ 下

// 10 = 当地日、7 = 当地月(会计/报表/工资期间)、4 = 当地年。三个都是同一个病:拿 UTC 切片当业务日历。
// 月和年更隐蔽:只有**每月 1 号 / 元旦的头几个小时**才跨,一个月才有一次机会露馅。
const UTC_TODAY = /new Date\(\)\.toISOString\(\)\.slice\(0, ?(?:4|7|10)\)/
const PROC_TZ = /\.get(FullYear|Month|Date|Hours|Minutes|Day)\(\)/

/**
 * 豁免清单:`文件路径` → 为什么这里用进程时区/UTC 是对的。
 * ★一律是「与租户业务日无关」的场景:解析外部文件里的时刻、给人看的展示格式化。
 */
const ALLOWLIST: Record<string, string> = {
  // Excel 的日期单元格是**不带时区的钟面值**,SheetJS 按进程时区还原成 Date;
  // 再用同一套进程时区的 getter 读回来,才拿得到用户当初在表格里写的那个数。
  // 换成 zonedDate 反而会把「2026-08-09」读成「2026-08-08」。
  'modules/attendance/logic.ts': 'Excel 日期单元格还原(dateCellToYmd):钟面值往返,必须与 SheetJS 的解析口径一致',
  'modules/lead/import-excel.ts': '导入结果里给人看的时间戳展示格式化,不参与任何业务判定',
  'modules/finance/logic/bank-statement-import.ts': '银行流水 Excel 单元格展示(visibleCell),同上',
  'modules/opportunity/export-excel.ts': '导出文件里的展示格式化,不参与判定',
  // 邮件列表的时间戳只跑在**浏览器**里,而且要跟同一个浏览器里的 `new Date()` 比出「今天/今年」——
  // 两边必须是同一个时钟。租户时区在这里反而是错的:人在国外出差时,邮箱该显示他眼前的时间。
  // (这一版正是来修「iso.slice(0,16) 直接截 UTC、东八区每封都早 8 小时」的,不是绕过时区。)
  'modules/lead-intake-email/ui/mail-body.ts': '邮件列表时间戳:纯浏览器端展示,与浏览器本地时钟比「今天/今年」,不参与任何业务判定',
  // 平台自身的计量/计费口径,不是租户业务日:AI 网关是**全公司一个出口**,
  // 账期按服务器自然日切,与某个租户设了什么时区无关(改成按租户切会让同一笔用量在两个账期里)。
  'modules/ai-gateway/budget.ts': '网关预算周期键:平台级计量口径,按服务器自然日/月切,与租户时区无关',
  'modules/ai-gateway/usage-sync.ts': '网关价目生效日:同上,平台级',
}

export type TzIssue = { file: string; line: number; rule: 'utc-today' | 'process-tz'; text: string }

/**
 * 单行判定(导出供护栏自测:**先证明它在该报警时会报警**,再信它的绿)。
 * 注释行一律放过 —— 文档里举反例是必要的。
 */
export function detectTzIssue(line: string): TzIssue['rule'] | null {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return null
  if (UTC_TODAY.test(line)) return 'utc-today'
  if (PROC_TZ.test(line)) return 'process-tz'
  return null
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: { name: string; isDir: boolean }[] = []
  try {
    entries = (await readdir(resolve(ROOT, dir), { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`
    if (e.isDir) {
      if (e.name === 'node_modules' || e.name === 'tests') continue
      await walk(p, out)
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
}

/** 返回所有「时间基准没走系统时区」的可疑行(已排除豁免清单与本模块自身的实现)。 */
export async function listTimezoneIssues(): Promise<TzIssue[]> {
  const files: string[] = []
  for (const root of ['modules', 'core']) await walk(root, files)
  const issues: TzIssue[] = []
  for (const file of files) {
    // 时区工具自身、以及本护栏,当然要用这些原语
    if (file.startsWith('modules/app-settings/')) continue
    if (ALLOWLIST[file]) continue
    const src = await readFile(resolve(ROOT, file), 'utf8')
    src.split('\n').forEach((line, i) => {
      const rule = detectTzIssue(line)
      if (rule) issues.push({ file, line: i + 1, rule, text: line.trim() })
    })
  }
  return issues
}
