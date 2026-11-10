// 迁移 SQL 的形状护栏。
//
// 由来:0172 用了两条语句(CREATE TABLE + CREATE INDEX)却没写 `--> statement-breakpoint`。
// runner 是整段发给 Postgres 的 —— 于是整份文件成了一条语法错误的语句,**所有**用 PGlite
// 建库的测试一起挂(241 个文件里挂了一片),而报错是「syntax error」,排查要绕一圈。
//
// ★写这条测试时我一并加了「文件不能以注释开头」—— **那条是错的**,60+ 个既有迁移都以
//   注释开头且跑得好好的。前导注释无罪,真正的规则只有下面这一条。留着这句话是为了
//   让下一个人别再去加那条假规则。
//
// 这条测试把它变成一句人话。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, '../migrations')
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()

/** 去掉行注释与空行后的正文。 */
function body(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .trim()
}

describe('迁移 SQL 形状', () => {
  it('有迁移文件可检(否则这条测试是空跑)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('★多条语句必须用 --> statement-breakpoint 分隔', () => {
    const bad: string[] = []
    for (const f of files) {
      const sql = readFileSync(join(DIR, f), 'utf8')
      if (sql.includes('--> statement-breakpoint')) continue
      // 去掉注释和字符串字面量后数分号:> 1 条独立语句却没有分隔符 = runner 会整段发出去
      const stripped = body(sql).replace(/'(?:[^']|'')*'/g, "''")
      const stmts = stripped.split(';').map((x) => x.trim()).filter(Boolean)
      if (stmts.length > 1) bad.push(`${f}(${stmts.length} 条语句)`)
    }
    expect(bad, `这些迁移有多条语句却没有 --> statement-breakpoint,runner 会整段发给 Postgres 导致语法错误:\n${bad.join('\n')}`).toEqual([])
  })

})
