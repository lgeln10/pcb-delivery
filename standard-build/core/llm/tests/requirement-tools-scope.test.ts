// core/llm/tests/requirement-tools-scope.test.ts
// **需求收集那三个工具只准挂在需求助手那条链路上。**
//
// 2026-08-19 之前是反过来的:`core/llm/caller.ts` 无条件下发 `TOOLS`,
// 每一个走 `buildTenantLLMCaller` 的调用点都带着 —— 合同生成、线索打分、邮件抽取、
// 银行流水解析这些**根本不消费工具结果**的一次性调用,白付一份 schema 的输入 token。
// 更糟的是它和「只吐一个 JSON 动作」的协议打架:实测同一句话同一个模型,带着这套工具时
// 5 次里有 2 次改去调 `confirm_requirement`,动作 JSON 就没了(压测 39% 的轮次要重问)。
//
// ★这是**源码扫描**护栏,不是行为测试。它挡得住「有人改回来」和「扩散到新调用点」,
//   挡不住「这条路根本跑不通」—— 后者由需求助手自己的用例保证。
//   两者的分工见 memory/source-scanning-guards-are-not-tests。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()

/**
 * 允许开启需求工具的地方,每条写明为什么。
 * **只有这三处真的消费 `confirm` / `readFull` / `loadModule` 的结果。**
 */
const ALLOWED: Record<string, string> = {
  'core/llm/caller.ts': '默认 caller 仍认识 requirementTools,但本产品没有任何调用点把它打开',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.ts') && !full.includes(`${'tests'}/`)) out.push(full)
  }
  return out
}

const files = [...walk(join(ROOT, 'modules')), ...walk(join(ROOT, 'core'))]

describe('★需求工具的下发范围', () => {
  it('只有名单里那三处开启,别处开了要写明理由再加进名单', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = f.slice(ROOT.length + 1)
      if (rel in ALLOWED) continue
      const src = readFileSync(f, 'utf8')
      if (/requirementTools\s*:\s*true/.test(src)) offenders.push(rel)
    }
    expect(
      offenders,
      `这些地方开启了需求收集工具:${offenders.join(', ')}\n`
      + '→ 它们真的会读 confirm/readFull/loadModule 吗?不读就别开:\n'
      + '  ① 白付一份工具 schema 的输入 token;\n'
      + '  ② 模型可能改去调 confirm_requirement 而不回答你要的东西(实测 5 次里 2 次)。\n'
      + '  确实需要就加进 ALLOWED 并写清理由。',
    ).toEqual([])
  })

  it('名单里的每一条都还存在,而且真的开着(名单不许腐烂)', () => {
    for (const [rel, why] of Object.entries(ALLOWED)) {
      expect(why.trim().length, `${rel} 没写理由`).toBeGreaterThan(0)
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(
        /requirementTools/.test(src),
        `${rel} 在名单里却没有 requirementTools —— 要么代码改了名单没跟,要么这条已经作废`,
      ).toBe(true)
    }
  })

  it('★没有人再用旧的 noTools 开关(反过来的默认已经删了)', () => {
    // 留着旧名字最危险的形态是:有人照着老代码写 `noTools: true` —— 语义已经反了。
    // ★只扫**代码形态**(`noTools:` / `noTools?` / `.noTools`),不扫散文:
    //   caller.ts 的文件头刻意保留了「以前叫 noTools、默认是反的」这段历史,
    //   那是给下一个人看的,不该被护栏当成违规。第一版没区分,当场把自己顶红了。
    const CODE_USE = /noTools\s*[:?=]|\.noTools\b/
    const stale = files.filter((f) => CODE_USE.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1))
    expect(stale, `还有地方在代码里用 noTools:${stale.join(', ')}`).toEqual([])
  })
})
