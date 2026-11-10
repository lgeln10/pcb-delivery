// @vitest-environment jsdom
//
// 「知会」类通知的**读全文**护栏(2026-08-21)。
//
// ★为什么非要挂起来测:这一版改的正是「点了之后发生什么」,而那件事 tsc 和后端测试全看不见。
//   改之前的实际状态就是这一类:日报/周报/晨检/告警的正文在列表里被截成 2–3 行,点一下**跳走**,
//   于是那份二三十行的报告在产品里永远读不到 —— 接口全 200、类型全绿、测试全过。
//
// 两条:
//   ① read 类点了**不跳**(不发 si:navigate),正文按 markdown 渲染出来(不是一坨纯文本)
//   ② 抽屉底部的次要动作是「去<菜单名>」,名字取自导航目录,不手抄
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import NotificationDetail from '../ui/NotificationDetail.vue'

const elButton = defineComponent({
  // ★不能 inheritAttrs:false —— 那样 @click 落不到真实 button 上,断言会假绿
  setup: (_p, { slots, attrs }) => () => h('button', attrs, slots.default?.() ?? []),
})
const passthrough = (tag = 'div') =>
  defineComponent({
    inheritAttrs: false,
    props: { modelValue: { type: null, default: undefined }, title: { type: String, default: '' } },
    emits: ['update:modelValue'],
    setup: (props, { slots }) => () =>
      h(tag, {}, [props.title, ...(slots.default?.() ?? []), ...(slots.footer?.() ?? [])]),
  })

const BODY = [
  '**近 7 天**判绿 128 条,其中 3 条最终被驳回。',
  '',
  '【分规则看】',
  '- `PAY_FIRST` 命中 12 · 放行 12 · 驳回 0 —— **基本是噪音**',
  '- `INVOICE_DUPLICATE` 命中 4 · 放行 1 · 驳回 3',
  '',
  '【漏判样本】',
  '  - FK-2026-0311:驳回意见「发票抬头不是我们公司」',
].join('\n')

function mountDetail(sourceType: string) {
  return mount(NotificationDetail, {
    props: {
      item: { title: '[AI 预审对账] 近 7 天', body: BODY, createdAt: new Date().toISOString(), sourceType, sourceId: 'T1' },
      selfEmployeeId: 'E1',
    },
    global: {
      stubs: { 'el-drawer': passthrough(), 'el-button': elButton, ChevronRight: passthrough('span') },
    },
  })
}

beforeEach(() => vi.clearAllMocks())

describe('通知正文详情', () => {
  it('★正文按 markdown 渲染 —— 报告里的分段/列表/加粗/代码不能糊成一坨', async () => {
    const w = mountDetail('review_report')
    await flushPromises()
    const html = w.html()
    expect(html, '加粗没渲染').toContain('<strong>')
    expect(html, '列表没渲染').toContain('<li>')
    expect(html, '行内代码没渲染').toContain('<code>')
    // 全文都在(列表里那 3 行截断是预览态的事,详情里不许截)
    expect(w.text()).toContain('FK-2026-0311')
  })

  it('★点开详情不发 si:navigate —— read 类跳走等于把内容丢了', async () => {
    const spy = vi.fn()
    window.addEventListener('si:navigate', spy)
    const w = mountDetail('review_report')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    window.removeEventListener('si:navigate', spy)
    w.unmount()
  })

  it('★次要动作叫「去<菜单名>」,名字取自导航目录(不手抄 key→中文)', async () => {
    const spy = vi.fn()
    window.addEventListener('si:navigate', spy)
    const w = mountDetail('db_backup') // read + section 'app-settings' → 系统设置
    await flushPromises()
    const btn = w.find('button')
    expect(btn.exists(), '没有次要动作按钮').toBe(true)
    expect(btn.text()).toContain('去')
    await btn.trigger('click')
    expect(spy, '点「去…」才跳').toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0]![0] as CustomEvent).detail).toBe('app-settings')
    window.removeEventListener('si:navigate', spy)
    w.unmount()
  })
})
