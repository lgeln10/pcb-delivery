// @vitest-environment jsdom
// ui-kit 组件测试:五态优先级 / 二次确认不确认不触发 / 字段错误定位。
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import AsyncState from './AsyncState.vue'
import ConfirmButton from './ConfirmButton.vue'
import FormField from './FormField.vue'

// ConfirmButton 现为 el-popover(确认条 teleport 到 body,不撑高表格行),需注册 ElementPlus
const ep = { global: { plugins: [ElementPlus] }, attachTo: document.body }

describe('AsyncState 五态', () => {
  const slots = { default: '<p id="content">成功内容</p>' }

  it('优先级:loading > error > forbidden > empty > 成功', () => {
    const w1 = mount(AsyncState, { props: { loading: true, error: '错', forbidden: true, empty: true }, slots })
    expect(w1.find('.sb-state--loading').exists()).toBe(true)
    expect(w1.find('#content').exists()).toBe(false)

    const w2 = mount(AsyncState, { props: { error: '加载失败', forbidden: true, empty: true }, slots })
    expect(w2.find('.sb-state--error').text()).toContain('加载失败')

    const w3 = mount(AsyncState, { props: { forbidden: true, empty: true }, slots })
    expect(w3.find('.sb-state--forbidden').text()).toContain('无权限')

    const w4 = mount(AsyncState, { props: { empty: true }, slots })
    expect(w4.find('.sb-state--empty').text()).toContain('暂无数据')

    const w5 = mount(AsyncState, { props: {}, slots })
    expect(w5.find('#content').text()).toBe('成功内容')
  })

  it('错误态点重试 emit retry', async () => {
    const w = mount(AsyncState, { props: { error: '网络错误' }, slots })
    await w.find('.sb-state__retry').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('空态可用插槽覆写', () => {
    const w = mount(AsyncState, { props: { empty: true }, slots: { ...slots, empty: '还没有客户,点右上角新建' } })
    expect(w.text()).toContain('还没有客户')
  })
})

describe('ConfirmButton 二次确认', () => {
  it('第一次点击展开确认浮层,不 emit confirm', async () => {
    const w = mount(ConfirmButton, { props: { label: '删除' }, ...ep })
    await w.find('.sb-confirm__trigger').trigger('click')
    await nextTick()
    expect(w.emitted('confirm')).toBeUndefined()
    expect(document.querySelector('.sb-confirm__pop')).toBeTruthy() // 浮层 teleport 到 body
    w.unmount()
  })

  it('点「确认」才 emit,且只 emit 一次', async () => {
    const w = mount(ConfirmButton, { props: { label: '删除', confirmText: '删了就没了?' }, ...ep })
    await w.find('.sb-confirm__trigger').trigger('click')
    await nextTick()
    expect(document.body.textContent).toContain('删了就没了?')
    ;(document.querySelector('.sb-confirm__yes') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('confirm')).toHaveLength(1)
    w.unmount()
  })

  it('点「取消」不 emit', async () => {
    const w = mount(ConfirmButton, { props: { label: '删除' }, ...ep })
    await w.find('.sb-confirm__trigger').trigger('click')
    await nextTick()
    ;(document.querySelector('.sb-confirm__no') as HTMLElement).click()
    await nextTick()
    expect(w.emitted('confirm')).toBeUndefined()
    expect(w.find('.sb-confirm__trigger').exists()).toBe(true)
    w.unmount()
  })

  it('disabled 时触发按钮带 disabled', async () => {
    const w = mount(ConfirmButton, { props: { label: '删除', disabled: true }, ...ep })
    expect(w.find('.sb-confirm__trigger').attributes('disabled')).toBeDefined()
    w.unmount()
  })
})

describe('FormField 字段错误定位', () => {
  it('error 非空 → 字段下方红字提示(role=alert)', () => {
    const w = mount(FormField, {
      props: { label: '手机号', error: '手机号已被使用', required: true },
      slots: { default: '<input />' },
    })
    expect(w.find('.sb-field__error').text()).toBe('手机号已被使用')
    expect(w.find('[role=alert]').exists()).toBe(true)
    expect(w.find('.sb-field__required').exists()).toBe(true)
    expect(w.classes()).toContain('sb-field--error')
  })

  it('无 error 不渲染错误节点', () => {
    const w = mount(FormField, { props: { label: '姓名' }, slots: { default: '<input />' } })
    expect(w.find('.sb-field__error').exists()).toBe(false)
  })
})
