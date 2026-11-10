// 质量护栏固化:查询串里的布尔参数不得用 `z.coerce.boolean()`。
//
// 病根:查询串的值永远是字符串,而 coerce 走 `Boolean(v)` —— `Boolean('false') === true`。
// 于是「显式传 false」被读成 true,**不报错、不进日志**,只是行为悄悄反过来。
// 全仓已经栽过两次,而且是同一个形状:
//   ① inapp-notify `unreadOnly=false` → 「切回全部」也只剩未读(当时就地改成了枚举写法,
//      但只改了那一处,别处照旧,于是有了第二次);
//   ② crm-todo `includeResolved=false` → **点了「完成」的待办仍留在逾期列表里**
//      (2026-08-15 用户反馈,实测复现)。
// 正确写法是 core/http/query.ts 的 boolField()。这条测试把那句「别只改手上这一处」变成机器判据。
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const SCAN_DIRS = ['modules', 'core']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude'])

async function tsFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await tsFiles(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('查询串布尔参数护栏', () => {
  it('不得使用 z.coerce.boolean() —— 用 core/http/query.ts 的 boolField()', async () => {
    const offenders: string[] = []
    for (const dir of SCAN_DIRS) {
      for (const file of await tsFiles(join(ROOT, dir))) {
        const src = await readFile(file, 'utf8')
        src.split('\n').forEach((line, i) => {
          // 注释里可以提它(query.ts 与各处的说明注释就在讲这个坑)
          if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return
          if (line.includes('z.coerce.boolean(')) offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
        })
      }
    }
    expect(offenders, `这些地方会把 ?flag=false 读成 true:\n${offenders.join('\n')}`).toEqual([])
  })
})
