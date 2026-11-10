// @vitest-environment jsdom
// 左缘右滑返回的判定逻辑。这条手势最容易出的问题是**抢掉正文的横滑**
// (表格横向滚动、图片轮播),所以起手位置与方向比例的判定必须锁住。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initEdgeSwipeBack } from './edge-swipe-back'

function touch(x: number, y: number) {
  return { clientX: x, clientY: y } as Touch
}
function fire(type: 'touchstart' | 'touchend' | 'touchcancel', x: number, y: number) {
  const e = new Event(type) as TouchEvent & { touches: Touch[]; changedTouches: Touch[] }
  Object.defineProperty(e, 'touches', { value: type === 'touchstart' ? [touch(x, y)] : [] })
  Object.defineProperty(e, 'changedTouches', { value: [touch(x, y)] })
  window.dispatchEvent(e)
}
/** 走一趟完整手势:从 (x1,y1) 滑到 (x2,y2) */
function swipe(x1: number, y1: number, x2: number, y2: number) {
  fire('touchstart', x1, y1)
  fire('touchend', x2, y2)
}

let back: ReturnType<typeof vi.fn>

beforeEach(() => {
  initEdgeSwipeBack()
  back = vi.fn()
  vi.spyOn(history, 'back').mockImplementation(back as unknown as () => void)
  // 只有历史里有本应用压入的页面才允许回退
  history.replaceState({ siSection: 'si-employees' }, '')
})
afterEach(() => vi.restoreAllMocks())

describe('左缘右滑返回', () => {
  it('从左缘明显右滑 → 回退', () => {
    swipe(5, 300, 200, 310)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('★从屏幕中间右滑不算 —— 那是表格横向滚动/轮播,抢了就毁掉正文交互', () => {
    swipe(200, 300, 400, 310)
    expect(back).not.toHaveBeenCalled()
  })

  it('位移太小不算(避免误触)', () => {
    swipe(5, 300, 40, 305)
    expect(back).not.toHaveBeenCalled()
  })

  it('★更像竖滑的不算 —— 竖向滚列表时手指常常也会横向偏一点', () => {
    swipe(5, 300, 90, 500)
    expect(back).not.toHaveBeenCalled()
  })

  it('往左滑不算(那是前进方向,不是返回)', () => {
    swipe(20, 300, 5, 305)
    expect(back).not.toHaveBeenCalled()
  })

  it('★历史里没有本应用的页面时不回退 —— 否则会退出到壳登录页', () => {
    history.replaceState({}, '')
    swipe(5, 300, 200, 310)
    expect(back).not.toHaveBeenCalled()
  })

  it('手势被系统打断(touchcancel)后,下一次 touchend 不该用过期起点', () => {
    fire('touchstart', 5, 300)
    fire('touchcancel', 5, 300)
    fire('touchend', 200, 310)
    expect(back).not.toHaveBeenCalled()
  })
})
