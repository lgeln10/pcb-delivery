// @vitest-environment jsdom
// demo 自动登录的「先问再发」门:
// 生产实例根本没注册 /api/auth/demo-login,盲发就是每次打开在控制台留一条 404 红字 ——
// 应用层 catch 得住,浏览器的网络日志 catch 不住,用户看着就是「系统报错了」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDemoLogin } from './client'

type Call = { url: string; method: string }
let calls: Call[] = []

/** 装一个假 fetch:/api/health 按参数回 demo 位,demo-login 恒成功。 */
function stubFetch(health: unknown, opts: { healthFails?: boolean } = {}) {
  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string }) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.includes('/api/health')) {
      if (opts.healthFails) throw new Error('network down')
      return new Response(JSON.stringify(health), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(
      JSON.stringify({ token: 'tk', employee: { id: 'e1', name: '王老板', tenantId: 't1', phone: '13800000001' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
}

const posted = () => calls.filter((c) => c.url.includes('demo-login'))

beforeEach(() => {
  calls = []
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('demo 自动登录的探测门', () => {
  it('demo 实例(demo=true):照常发 demo-login 并拿到会话', async () => {
    stubFetch({ ok: true, push: false, demo: true })
    const session = await apiDemoLogin()
    expect(session.employee.name).toBe('王老板')
    expect(posted()).toHaveLength(1)
  })

  it('生产实例(demo=false):**一次都不发** demo-login,直接抛让调用方静默降级', async () => {
    stubFetch({ ok: true, push: false, demo: false })
    await expect(apiDemoLogin()).rejects.toThrow()
    expect(posted(), '发了就会在控制台留 404').toHaveLength(0)
  })

  it('旧后端(health 没有 demo 字段):按不是 demo 处理,也不发', async () => {
    stubFetch({ ok: true, push: false })
    await expect(apiDemoLogin()).rejects.toThrow()
    expect(posted()).toHaveLength(0)
  })

  it('health 本身挂了:不抱侥幸再去发 demo-login', async () => {
    stubFetch(null, { healthFails: true })
    await expect(apiDemoLogin()).rejects.toThrow()
    expect(posted()).toHaveLength(0)
  })
})
