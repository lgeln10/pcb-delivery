// @vitest-environment jsdom
//
// 「模型该在哪一页配」的说法(2026-08-22)。
//
// ★这条护栏钉的是一次真事故的收尾:图片识别报错 → 提示把人指到「系统设置 → AI 大模型」→
//   用户在那一页把「图片识别」改成了一个**实测能看图**的模型、保存、以为配好了 →
//   再试还是同一个错。因为那台是网关模式,那一页的设置根本不生效。
//   **当时那一页已经有一条「不生效」的提示了** —— 提示没挡住。所以这里钉的是三件事:
//     ① 不生效的那一页必须说自己不生效(而不是只说别处也能配);
//     ② 必须指出**去哪儿**,并且真的能跳过去;
//     ③ 没权限看对面那页时**不给按钮** —— si:navigate 会被可见性白名单静默丢弃,那是死按钮。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelRoutingNotice from '../ModelRoutingNotice.vue'

const nav = vi.fn()
beforeEach(() => {
  nav.mockReset()
  window.addEventListener('si:navigate', (e) => nav((e as CustomEvent<string>).detail))
})

const at = (page: 'local' | 'gateway', gatewayActive: boolean, canGoOther = true, locked = false) =>
  mount(ModelRoutingNotice, { props: { page, gatewayActive, canGoOther, locked } })

describe('★不生效的那一页要说自己不生效,并指到对的地方', () => {
  it('★★AI 大模型页 + 网关开着 → 说不生效,按钮跳「AI 网关」', async () => {
    const w = at('local', true)
    expect(w.text()).toContain('这一页现在不生效')
    expect(w.text(), '「不生效」不说清是哪几项,人还是会去改').toContain('API Key')
    const btn = w.find('button')
    expect(btn.exists(), '不给去处 = 只告诉他「你错了」').toBe(true)
    await btn.trigger('click')
    expect(nav).toHaveBeenCalledWith('ai-gateway')
  })

  it('★深度思考是例外,必须点名 —— 它在网关模式下照样生效', async () => {
    // 不点名的话,「本页全部不生效」会让人以为这个开关也白配,那句话就成了新的错误信息
    expect(at('local', true).text()).toContain('深度思考')
  })

  it('★★AI 网关页 + 网关没接上 → 反过来,指回「AI 大模型」', async () => {
    const w = at('gateway', false)
    expect(w.text()).toContain('这一页现在不生效')
    await w.find('button').trigger('click')
    expect(nav).toHaveBeenCalledWith('app-settings')
  })

  it('★没权限看对面那页 → 不给按钮(死按钮比没按钮更糟),改成一句话', () => {
    const w = at('local', true, false)
    expect(w.find('button').exists()).toBe(false)
    expect(w.text()).toContain('没有那一页的权限')
  })

  it('锁住时要说清「所以下面锁了」+ 怎么解锁', () => {
    expect(at('local', true, true, true).text()).toContain('仍要编辑')
    expect(at('local', true, true, false).text(), '没锁就别说锁了').not.toContain('已锁住')
  })
})

describe('生效的那一页只做确认,不喧宾夺主', () => {
  it('AI 大模型页 + 直连 → 说「这一页配的就是生效的」,没有跳转按钮', () => {
    const w = at('local', false)
    expect(w.text()).toContain('这一页配的就是生效的那份')
    expect(w.find('button').exists(), '生效中还催人去别处 = 制造新的困惑').toBe(false)
  })

  it('AI 网关页 + 网关开着 → 同上', () => {
    const w = at('gateway', true)
    expect(w.text()).toContain('这一页配的就是生效的那份')
    expect(w.find('button').exists()).toBe(false)
  })
})
