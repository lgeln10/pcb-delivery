// @vitest-environment jsdom
// 发版后「页面加载失败」的自愈刷新:什么时候该自动刷、什么时候**绝不能**刷。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const RELOADED_AT_KEY = 'standard-build.build-refresh.at'
const OLD_ENTRY = '/assets/index-AAAAAAAA.js'
const NEW_ENTRY = '/assets/index-BBBBBBBB.js'

const htmlWith = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body></body></html>`

const ORIGINAL_LOCATION = Object.getOwnPropertyDescriptor(window, 'location')!
const reload = vi.fn()

/** 当前页面就是用 entry 这份 HTML 加载起来的 */
function pageLoadedWith(entry: string | null) {
  document.head.innerHTML = entry ? `<script type="module" crossorigin src="${entry}"></script>` : ''
}

function serverReturns(res: { ok?: boolean; entry?: string } | Error) {
  const fetchMock = vi.fn(async () => {
    if (res instanceof Error) throw res
    return { ok: res.ok ?? true, text: async () => htmlWith(res.entry ?? OLD_ENTRY) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  sessionStorage.clear()
  reload.mockReset()
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname: '/', reload },
    configurable: true,
  })
  pageLoadedWith(OLD_ENTRY)
})

afterEach(() => {
  Object.defineProperty(window, 'location', ORIGINAL_LOCATION)
  vi.unstubAllGlobals()
  document.head.innerHTML = ''
})

describe('reloadIfStaleBuild', () => {
  it('服务器上的入口脚本换了哈希 = 真发版了 → 自动刷新', async () => {
    serverReturns({ entry: NEW_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('入口脚本没变 → 不刷新(是别的毛病,刷了也没用,还会把错误藏起来)', async () => {
    serverReturns({ entry: OLD_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('★请求不通(断网 / 后端还没起来)→ 不刷新,绝不能转成刷新循环', async () => {
    serverReturns(new Error('Failed to fetch'))
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('响应不是 200 → 不刷新', async () => {
    serverReturns({ ok: false, entry: NEW_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('★刚刷过一次还失败 → 冷却期内不再刷(刷完仍坏说明不是发版能解释的)', async () => {
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now() - 5_000))
    const fetchMock = serverReturns({ entry: NEW_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled() // 连问都不问
  })

  it('冷却期过了还能再刷(下一次发版是新的一回事)', async () => {
    sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now() - 120_000))
    serverReturns({ entry: NEW_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('页面里找不到入口脚本(判不出自己是哪一版)→ 不刷新', async () => {
    pageLoadedWith(null)
    serverReturns({ entry: NEW_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await expect(reloadIfStaleBuild()).resolves.toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('刷新前把时间戳落进 sessionStorage(下一轮才认得出「刚刷过」)', async () => {
    serverReturns({ entry: NEW_ENTRY })
    const { reloadIfStaleBuild } = await import('./build-refresh')

    await reloadIfStaleBuild()
    expect(Number(sessionStorage.getItem(RELOADED_AT_KEY))).toBeGreaterThan(0)
  })
})
