// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { lazyPage } from './lazy-page'

const OLD_ENTRY = '/assets/index-AAAAAAAA.js'
const ORIGINAL_LOCATION = Object.getOwnPropertyDescriptor(window, 'location')!
const reload = vi.fn()

/** 页面自称是 OLD_ENTRY 那一版;服务器现在回的是 serverEntry(null = 请求直接失败) */
function stubBuild(serverEntry: string | null) {
  document.head.innerHTML = `<script type="module" crossorigin src="${OLD_ENTRY}"></script>`
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (!serverEntry) throw new Error('Failed to fetch')
    return {
      ok: true,
      text: async () => `<!doctype html><html><head><script type="module" src="${serverEntry}"></script></head></html>`,
    } as unknown as Response
  }))
}

beforeEach(() => {
  sessionStorage.clear()
  reload.mockReset()
  Object.defineProperty(window, 'location', { value: { ...window.location, pathname: '/', reload }, configurable: true })
})

afterEach(() => {
  Object.defineProperty(window, 'location', ORIGINAL_LOCATION)
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

describe('lazyPage', () => {
  it('延迟加载时显示页面加载提示，并在组件可用后渲染内容', async () => {
    vi.useFakeTimers()
    let resolvePage!: (component: ReturnType<typeof defineComponent>) => void
    const Page = defineComponent({ template: '<p>页面内容</p>' })
    const AsyncPage = lazyPage(() => new Promise((resolve) => { resolvePage = resolve }))
    const wrapper = mount(defineComponent({ components: { AsyncPage }, template: '<AsyncPage />' }))

    await vi.advanceTimersByTimeAsync(150)
    expect(wrapper.text()).toContain('页面加载中')

    resolvePage(Page)
    await flushPromises()
    expect(wrapper.text()).toContain('页面内容')
    vi.useRealTimers()
  })

  it('加载失败后自动重试一次，再显示重新加载提示', async () => {
    stubBuild(null) // 服务器问不到 = 不是发版,不自动刷新
    const loader = vi.fn<() => Promise<ReturnType<typeof defineComponent>>>()
      .mockRejectedValue(new Error('chunk unavailable'))
    const AsyncPage = lazyPage(loader)
    const wrapper = mount(defineComponent({ components: { AsyncPage }, template: '<AsyncPage />' }))

    await flushPromises()
    await flushPromises()

    expect(loader).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('页面加载失败')
    expect(wrapper.get('button').text()).toBe('重新加载')
    expect(wrapper.html()).not.toContain('chunk unavailable')
  })

  it('★服务器发了新版导致的加载失败 → 自动刷新页面,不给用户看错误页', async () => {
    stubBuild('/assets/index-BBBBBBBB.js')
    const loader = vi.fn<() => Promise<ReturnType<typeof defineComponent>>>()
      .mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'))
    const AsyncPage = lazyPage(loader)
    const wrapper = mount(defineComponent({ components: { AsyncPage }, template: '<AsyncPage />' }))

    await flushPromises()
    await flushPromises()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).not.toContain('页面加载失败')
  })
})
