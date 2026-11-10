// @vitest-environment jsdom
// ToolbarActions:桌面端等于不存在,手机端把次要动作收进「更多」。
//
// ★这几条断言里最要紧的是「收起用 v-show 不是 v-if」那条。次要动作里常夹着
//   `<input type="file" hidden>`,页面靠模板 ref 去 `.click()` 它;换成 v-if 之后 ref 是 null,
//   「导入 Excel」变成点了没反应的死按钮,**而且不报错**——这种坏法只有真在手机上点一次才看得见。
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import ToolbarActions from './ToolbarActions.vue'

/** useIsMobile 走 matchMedia,jsdom 里没有 —— 按需要装一个假的 */
function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

const slots = {
  default:
    '<button class="a">渠道配置</button><button class="b">导出</button><button class="c">导入</button>' +
    '<input class="file" type="file" hidden />',
  primary: '<button class="p">录入线索</button>',
}
const mountIt = () => mount(ToolbarActions, { slots, global: { plugins: [ElementPlus] } })

describe('ToolbarActions', () => {
  it('桌面端:全部平铺,没有「更多」,顺序仍是次要在前主动作在后', () => {
    stubMatchMedia(false)
    const w = mountIt()
    expect(w.find('.toolbar-actions__more').exists(), '桌面端不该出现「更多」').toBe(false)
    expect(w.findAll('button').filter((b) => b.classes('a') || b.classes('p')).length).toBe(2)
    // DOM 顺序 = 桌面顺序:.a 在 .p 之前(桌面端外层是 display:contents,靠 DOM 顺序排版)
    const html = w.html()
    expect(html.indexOf('class="a"')).toBeLessThan(html.indexOf('class="p"'))
  })

  it('★手机端:只露主动作 + 「更多」,次要动作收起', () => {
    stubMatchMedia(true)
    const w = mountIt()
    expect(w.find('.toolbar-actions--mobile').exists()).toBe(true)
    expect(w.find('.toolbar-actions__more').exists()).toBe(true)
    expect(w.find('.p').exists(), '主动作必须始终可见').toBe(true)
    // 收起 = display:none,不是从 DOM 里拿掉
    expect((w.find('.toolbar-actions__rest').element as HTMLElement).style.display).toBe('none')
  })

  it('★收起用 v-show 不是 v-if:隐藏的 file input 仍在 DOM 里(否则「导入」变死按钮)', () => {
    stubMatchMedia(true)
    const w = mountIt()
    expect(w.find('input.file').exists(), '次要动作被 v-if 掉了 —— 页面拿不到 ref,导入会静默失效').toBe(true)
    expect(w.find('.a').exists()).toBe(true)
  })

  it('点「更多」展开、再点收起', async () => {
    stubMatchMedia(true)
    const w = mountIt()
    const rest = () => (w.find('.toolbar-actions__rest').element as HTMLElement).style.display
    await w.find('.toolbar-actions__more').trigger('click')
    await nextTick()
    expect(rest()).not.toBe('none')
    await w.find('.toolbar-actions__more').trigger('click')
    await nextTick()
    expect(rest()).toBe('none')
  })

  it('★次要动作太少就不折叠 —— 点一下「更多」只露出一个按钮,比直接摆着还费事', () => {
    stubMatchMedia(true)
    const w = mount(ToolbarActions, {
      slots: { default: '<button class="a">合同模板</button>', primary: '<button class="p">新建合同</button>' },
      global: { plugins: [ElementPlus] },
    })
    expect(w.find('.toolbar-actions__more').exists()).toBe(false)
    expect((w.find('.toolbar-actions__rest').element as HTMLElement).style.display).not.toBe('none')
  })

  it('★隐藏元素不计入「够不够多到要折叠」', () => {
    stubMatchMedia(true)
    // 两个真按钮 + 一个 hidden input:真正能看见的只有 2 个,不该折叠
    const w = mount(ToolbarActions, {
      slots: { default: '<button class="a">A</button><button class="b">B</button><input class="file" type="file" hidden />' },
      global: { plugins: [ElementPlus] },
    })
    expect(w.find('.toolbar-actions__more').exists()).toBe(false)
  })
})
