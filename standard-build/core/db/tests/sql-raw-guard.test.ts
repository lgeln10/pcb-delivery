// ★护栏:冻结全部 `sql.raw(...)` 调用点(security C3)。
//
// sql.raw 是唯一绕过参数化的口子。现存实参全部来自代码里的常量表/字面量三元/带范围校验的整数
// (逐个核过,见下面清单的注),**但这件事此前只靠 review** —— 哪天有人把变量传进去,
// 类型全绿、测试全绿,没有任何地方会报警。这道护栏把「实参长什么样」冻成清单:
// 新增调用点或改动实参就红,红了要么把它改回常量来源,要么核过安全后在清单里加一行并写明凭什么。
//
// 形状同 public-surface.test.ts / WRITE_TOOLS 差集护栏:断言「有意允许的清单」==「实际存在的清单」。
// ★基线按「文件|实参文本」计,不记行号(行号会让无关重构把护栏弄红,红多了就没人看了)。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['core', 'modules', 'seed']

/**
 * 已核准的调用点:`文件路径: 实参表达式`。**每行都要能说出凭什么安全。**
 * - repair-public:table/column 来自文件内 PUBLIC_COLUMNS 字面量表
 * - ai-review / automation / review-accuracy:String(整数常量);windowDays 是入参,
 *   但函数开头有 Number.isInteger + 范围校验(1..3650),字符串化后不可能含 SQL
 * - books-reset:tableName 的类型钉在 RESET_TABLES 常量元组的成员上
 * - bank / dimensions:两个字面量的三元/映射,值域封闭
 */
const APPROVED = new Set([
  'core/storage/repair-public.ts: `"${column}"`',
  'core/storage/repair-public.ts: `"${table}"`',
  // pcb-cam model.ts 的 CHECK 约束:实参全是 stages.ts / model.ts 里的 `as const` 字面量数组经 sqlList 拼成,建表期常量,无运行时输入
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_PROJECT_STATUSES)',
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_JOB_STATUSES)',
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_STAGES)',
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_STAGE_RUN_STATUSES)',
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_SEVERITIES)',
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_EQ_DECISIONS)',
  'modules/pcb-cam/model.ts: sqlList(PCB_CAM_ARTIFACT_KINDS)',
])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name.endsWith('.test.ts')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (name.endsWith('.ts')) yield p
  }
}

/** 取 `sql.raw(` 之后配平括号的实参文本(实参里有 String(...) 这类嵌套括号,不能用正则一把梭)。 */
function rawArgsIn(src: string): string[] {
  const out: string[] = []
  let i = 0
  for (;;) {
    const at = src.indexOf('sql.raw(', i)
    if (at === -1) break
    let depth = 1
    let j = at + 'sql.raw('.length
    const start = j
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') depth--
      j++
    }
    out.push(src.slice(start, j - 1).trim())
    i = j
  }
  return out
}

describe('sql.raw 调用点白名单', () => {
  it('★每一处 sql.raw 的实参都必须在已核准清单里(新增/改动即红,红了先核安全再加行)', () => {
    const found = new Set<string>()
    for (const root of ROOTS) {
      for (const file of walk(join(process.cwd(), root))) {
        const rel = file.slice(process.cwd().length + 1)
        for (const arg of rawArgsIn(readFileSync(file, 'utf8'))) found.add(`${rel}: ${arg}`)
      }
    }
    // 护栏最怕自己变成永真:一处都扫不到,说明扫描器坏了,不是代码变干净了
    expect(found.size, '一处 sql.raw 都没扫到 —— 扫描器失效,不是代码变干净了').toBeGreaterThan(0)
    const unapproved = [...found].filter((x) => !APPROVED.has(x))
    const gone = [...APPROVED].filter((x) => !found.has(x))
    expect(unapproved, '出现了清单外的 sql.raw 实参:先证明它只可能来自常量,再把它加进 APPROVED 并写明凭什么').toEqual([])
    expect(gone, '清单里有已不存在的调用点 —— 从 APPROVED 删掉,别留死行(死行会悄悄放行未来同名的调用)').toEqual([])
  })
})
