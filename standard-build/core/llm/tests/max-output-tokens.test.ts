// 输出上限(max_tokens)这道闸。
//
// ★来历是线上一次真实的慢(2026-08-28,base.sixamtech.ai):需求助手一次调用吐了 3312 token、
//   跑了 37.5 秒,而同场景 37 次调用里另外 36 次都 ≤1365 token。用同一份提示词复现 10 次
//   (入参 2774 vs 2694,几乎相同)只跑出 101~546 token / 2.5~9.1 秒 —— 复现不出来,
//   **那就是模型自己的长尾**。而在此之前聊天场景**一个输出上限都没设过**,
//   耗时又几乎线性跟着输出长度走 → 「一次调用能慢到什么程度」没有上界。
//
// ★提示词里写「写短一点」拦不住这种事:那次存下来的需求正文本来就只有 442 字,
//   长的部分根本不在卡里。能硬性兜住的只有 max_tokens。
import { describe, expect, it } from 'vitest'
import { LLM_SCENES, sceneMaxOutputTokens } from '../scenes'

describe('★场景输出上限', () => {
  it('需求助手有上限,且宽到不会砍掉正常回答', () => {
    const cap = sceneMaxOutputTokens('pcb_cam')
    expect(cap, 'requirement 必须有上限 —— 它就是这条护栏的来历').toBeTypeOf('number')
    // 线上非离群的最大一次是 1365 token;留约一倍余量。低于 1400 就会开始砍正常回答。
    expect(cap!).toBeGreaterThanOrEqual(1400)
  })

  it('未登记的场景不下发上限(= 行为与加这个字段之前一模一样)', () => {
    expect(sceneMaxOutputTokens('bank_statement')).toBeUndefined()
    expect(sceneMaxOutputTokens('压根不存在的场景')).toBeUndefined()
  })

  it('★viaAgentHost 的场景不许填上限 —— 填了不报错,只是永远不生效', () => {
    // 那些场景由 dsh 拿着模型名自己去调网关,不经过 core/llm/caller.ts,
    // 我们下发的任何请求参数都到不了。填一个数看起来像是「已经限住了」,那是最坏的一种假象。
    const wrong = LLM_SCENES.filter((s) => s.viaAgentHost && s.maxOutputTokens !== undefined).map((s) => s.key)
    expect(wrong, `这些场景走 dsh,填了 maxOutputTokens 也不会生效:${wrong.join(', ')}`).toEqual([])
  })

  it('填了的都是正整数,且没有小到会砍掉正常回答的值', () => {
    for (const s of LLM_SCENES) {
      if (s.maxOutputTokens === undefined) continue
      expect(Number.isInteger(s.maxOutputTokens), `${s.key} 的上限不是整数`).toBe(true)
      // 400 以下基本只够一两句话,任何对话场景都不该设这么小;设成 0 更会被当成「不下发」。
      expect(s.maxOutputTokens, `${s.key} 的上限过小`).toBeGreaterThanOrEqual(400)
    }
  })
})

describe('★截断不许静默', () => {
  it('caller 对 finish_reason=length 有专门处理,而不是落进「当普通回复」那条兜底', async () => {
    // 扫源码:这条闸唯一新增的坏情况就是截断,而它默认会被三个 catch 里的
    // 「/* 工具参数解析失败 → 当普通回复 */」悄悄吃掉(用户拿到半句话,没有卡,也没有解释)。
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'core/llm/caller.ts'), 'utf8')
    expect(src, '没有读 finish_reason —— 截断会完全看不见').toContain("finish_reason === 'length'")
    expect(src, '截断时没有抛出可读错误,会退化成半句话').toMatch(/truncated[\s\S]{0,400}throw new LlmError/)
    expect(src, '纯文本被截断时没有在正文里标出来').toContain('(回答太长,已截断)')
  })
})
