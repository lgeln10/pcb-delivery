#!/usr/bin/env node
// scripts/vue-typecheck-gate.mjs
// `.vue` 的类型检查闸门。
//
// 背景:`npm run typecheck` 跑的是 `tsc`,而 **tsc 根本读不了 .vue** —— 实测
// `tsc --listFilesOnly | grep -c '\.vue$'` = 0。也就是说 tsconfig 的 include 里虽然
// 列着 `**/*.vue`,但至今**一个 SFC 都没被类型检查过**;模板里写错属性名、拿 undefined
// 当对象用,全都能上线。2026-07-31 第一次真跑 vue-tsc,报出 72 条,其中好几条是
// 「这块界面根本不工作」级别的真 bug。
//
// 为什么是门槛而不是一刀切:那 72 条散在 25 个模块里,盲改一遍的风险(UI 没有测试兜着)
// 比它们本身还大。所以先**冻住存量、堵死增量**:基线里记着每个文件各有几条什么错,
// 新增一条就红。存量按模块认领着还,还一批就重生成一次基线,只许降不许升。
//
// 用法:
//   node scripts/vue-typecheck-gate.mjs            # 检查(CI 用)
//   node scripts/vue-typecheck-gate.mjs --update   # 修完一批后重生成基线
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BASELINE = resolve(here, 'vue-typecheck-baseline.json')
const update = process.argv.includes('--update')

/** 跑 vue-tsc,把输出解析成 { "文件|错误码": 条数 }。行号会随编辑漂移,所以不进签名。 */
function collect() {
  let out = ''
  try {
    // ★堆上限跟 package.json 的 typecheck 保持一致。这套代码的类型图已经吃到 ~2.5GB,
    //   超过 node 在 CI runner 上的默认上限(约 2GB)—— 那边是**直接 OOM 退出 134**,
    //   而不是报类型错误,读日志时很容易当成别的毛病。见提交里那条 CI 修复的说明。
    out = execFileSync('node_modules/.bin/vue-tsc', ['--noEmit'], {
      cwd: resolve(here, '..'),
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=6144`.trim() },
    })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    if (!out.trim()) throw e // 真的没跑起来(没装依赖之类),别当成 0 错误放过去
  }
  const counts = {}
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error (TS\d+):/)
    if (!m) continue
    const key = `${m[1]}|${m[2]}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const now = collect()
const total = Object.values(now).reduce((a, b) => a + b, 0)

if (update) {
  writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`)
  console.log(`基线已更新:${Object.keys(now).length} 个签名 / ${total} 条`)
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error('缺少基线文件,先跑 node scripts/vue-typecheck-gate.mjs --update')
  process.exit(1)
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const baseTotal = Object.values(base).reduce((a, b) => a + b, 0)

const worse = []
for (const [key, n] of Object.entries(now)) {
  const allowed = base[key] ?? 0
  if (n > allowed) worse.push(`  ${key}  基线 ${allowed} → 现在 ${n}`)
}
const fixed = Object.entries(base).filter(([k, n]) => (now[k] ?? 0) < n)

if (worse.length) {
  console.error(`✗ .vue 类型错误变多了(总数 ${baseTotal} → ${total}):\n${worse.join('\n')}`)
  console.error('\n新写的 .vue 代码必须零类型错误。跑 node_modules/.bin/vue-tsc --noEmit 看详情。')
  process.exit(1)
}

console.log(`✓ .vue 类型检查:无新增(存量 ${total} 条,基线 ${baseTotal} 条)`)
if (fixed.length) {
  console.log(`↓ 有 ${fixed.length} 个签名比基线少了 —— 修完记得 --update 把基线压下去,否则它会悄悄变回可用额度:`)
  for (const [k, n] of fixed) console.log(`  ${k}  基线 ${n} → 现在 ${now[k] ?? 0}`)
}
