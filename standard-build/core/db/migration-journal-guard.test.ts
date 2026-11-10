// 质量护栏固化:迁移 journal 的 when 必须严格递增,否则新迁移会被生产库**静默跳过**。
//
// 起因(2026-07-27):飞书销售助理回「助理暂时不可用(模型调用失败或未配置)」。真实原因不是模型,
// 是 0188/0189/0190 三条迁移根本没在生产库跑过 —— partners.grade_id 不存在,而助理每轮都要
// listPartners 拉客户名喂模型,drizzle 会把模型里声明的全部列写进 SQL,于是每轮必抛,被 im-connect
// 的兜底 catch 归成「模型调用失败」。
//
// 机制(drizzle-orm/pg-core/dialect.js 的 migrate):开跑前取一次库里 __drizzle_migrations 的最大
// created_at 当基准(**循环期间不更新**),然后只执行 journal 里 when 严格大于该基准的条目。所以只要
// 某条的 when 低于它前面任何一条,凡是已经迁过前面那条的库,这条就**永远**不会被执行 —— 而且全新库
// (基准为空)反而一条不落,于是本地/CI/新装客户全绿,只有老生产库中招,极难自查。
//
// 同类事故本仓已经吃过第三次:0073_feedback_attachments 当年也是这么漏跑的,只能在
// scripts/db-migrate.ts 里补幂等 DDL 兜底。这条测试把「合并前就拦住」固化下来。
//
// 修法:新迁移的 when 取「当前 journal 里最大值 + 一档」,并放在 entries 末尾。若已经漏跑到生产,
// 把漏掉的条目 when 抬到最大值之上并移到末尾即可补跑(迁移 SQL 均为 IF NOT EXISTS,重跑幂等)。
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type JournalEntry = { idx: number; when: number; tag: string }

const JOURNAL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations/meta/_journal.json')

function loadEntries(): JournalEntry[] {
  return (JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { entries: JournalEntry[] }).entries
}

describe('迁移 journal 护栏', () => {
  it('when 严格递增 —— 否则该迁移在已有生产库上会被永久跳过', () => {
    const entries = loadEntries()
    const skipped: string[] = []
    let maxSoFar = Number.NEGATIVE_INFINITY
    for (const e of entries) {
      // drizzle 的判据是「严格大于」,所以相等同样跑不了
      if (e.when <= maxSoFar) skipped.push(`${e.tag}(when=${e.when} ≤ 前序最大 ${maxSoFar})`)
      maxSoFar = Math.max(maxSoFar, e.when)
    }
    expect(
      skipped,
      `以下迁移在「已迁过前序条目」的库上会被 drizzle 静默跳过(全新库却正常,故本地/CI 发现不了)。\n` +
        `修法:把它们的 when 抬到 journal 当前最大值之上,并移到 entries 末尾。\n` +
        skipped.map((s) => `  - ${s}`).join('\n'),
    ).toEqual([])
  })

  it('tag 不重复,且每条都能对上一个迁移文件', () => {
    const entries = loadEntries()
    const dupes = entries.map((e) => e.tag).filter((t, i, a) => a.indexOf(t) !== i)
    expect(dupes, `journal 里有重复 tag:${dupes.join(', ')}`).toEqual([])

    const missing = entries
      .map((e) => e.tag)
      .filter((tag) => {
        try {
          readFileSync(resolve(dirname(JOURNAL_PATH), '..', `${tag}.sql`))
          return false
        } catch {
          return true
        }
      })
    expect(missing, `journal 引用了不存在的迁移文件:${missing.join(', ')}`).toEqual([])
  })

  // 反向:磁盘上有 .sql 但 journal 没登记 —— drizzle 只按 journal.entries 找文件读,
  // 没登记的文件**在任何环境都不会被执行**,而它躺在目录里看着像已经生效了,最误导人。
  // 起因(2026-08-03):0026_voucher_attachments.sql 是合并时的残留 —— 特性分支上它是 0026,
  // 合进来时为了避开已占号的 0026_pale_drax 改名成 0027 并只给后者登了 journal,漏 git rm 前者。
  // 两份内容逐字节相同(都是 vouchers.attachments 那一行 ADD COLUMN IF NOT EXISTS),
  // 故删掉即可,加列由 0027 负责。同一缺陷类 unix 分支也中过一个(0066_digital_employees)。
  it('磁盘上的 .sql 都在 journal 里 —— 未登记的迁移永远不会执行', () => {
    const tags = new Set(loadEntries().map((e) => e.tag))
    const orphans = readdirSync(resolve(dirname(JOURNAL_PATH), '..'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -'.sql'.length))
      .filter((tag) => !tags.has(tag))
      .sort()
    expect(
      orphans,
      `以下迁移文件没有 journal 条目,drizzle 根本不会读它们(建表/加列全不会发生):\n` +
        orphans.map((s) => `  - ${s}.sql`).join('\n') +
        `\n修法:若 DDL 已被别的迁移覆盖 → 删文件;否则补一条 journal 条目` +
        `(tag=文件名去掉 .sql,when=当前最大值+一档,idx=顺延,放 entries 末尾)。`,
    ).toEqual([])
  })

  // 文件名前四位数字**不是**唯一键(唯一键是 tag),但同一个号挂多条迁移会让「按号查」撞车,
  // 也是上面那种残留最常见的伴生现象。base 目前干净(0026 的重号随孤儿文件一起消失),
  // 所以这里钉死为空集 —— 冒出任何撞车都变红。
  // ★注意:客户 fork 从 base/其它 fork 拣迁移时,journal 按本分支下一个 idx 登记、文件名却留来源
  //   分支的号,撞号是历史存量(如 unix 有 0096–0101 六组),那边的同名测试带白名单,别照抄过来。
  it('同一个四位号只挂一条迁移', () => {
    const nums = loadEntries().map((e) => e.tag.slice(0, 4))
    const dupes = [...new Set(nums.filter((n, i, a) => a.indexOf(n) !== i))].sort()
    expect(dupes, `这些四位号挂了多条迁移,请给新迁移换一个没被占用的号:${dupes.join(', ')}`).toEqual([])
  })
})
