// @vitest-environment jsdom
// 侧栏收起偏好的读写。默认必须是「展开」—— 这是本次改动的用户诉求本身:
// 打开系统不该默认收起菜单,只有上次自己收起过才收起。
import { beforeEach, describe, expect, it } from 'vitest'
import { NAV_COLLAPSED_KEY, readNavCollapsed, writeNavCollapsed } from './nav-collapse'

beforeEach(() => localStorage.clear())

describe('侧栏收起偏好', () => {
  it('没存过 → 展开(默认打开菜单)', () => {
    expect(readNavCollapsed()).toBe(false)
  })

  it('上次收起的则收起,上次展开的则展开', () => {
    localStorage.setItem(NAV_COLLAPSED_KEY, 'true')
    expect(readNavCollapsed()).toBe(true)
    localStorage.setItem(NAV_COLLAPSED_KEY, 'false')
    expect(readNavCollapsed()).toBe(false)
  })

  it('脏值一律当展开,绝不当收起', () => {
    // 存坏了宁可忘掉偏好,也不能让人打开系统就看不见菜单
    for (const dirty of ['1', 'yes', 'TRUE', '', 'null', '{}']) {
      localStorage.setItem(NAV_COLLAPSED_KEY, dirty)
      expect(readNavCollapsed(), `脏值 ${JSON.stringify(dirty)} 应回退成展开`).toBe(false)
    }
  })

  it('写入的是可被 read 认出的字面量,且落在约定的 key 上', () => {
    writeNavCollapsed(true)
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('true')
    expect(readNavCollapsed()).toBe(true)
    writeNavCollapsed(false)
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('false')
    expect(readNavCollapsed()).toBe(false)
  })

  it('存储不可用(无痕/禁用/配额满)时:读回退成展开,写不抛', () => {
    const throwing = {
      getItem() { throw new Error('SecurityError') },
      setItem() { throw new Error('QuotaExceededError') },
    }
    expect(readNavCollapsed(throwing)).toBe(false)
    expect(() => writeNavCollapsed(true, throwing)).not.toThrow()
    // 拿不到 storage 本身(SSR / 无 window)也一样
    expect(readNavCollapsed(null)).toBe(false)
    expect(() => writeNavCollapsed(true, null)).not.toThrow()
  })
})
