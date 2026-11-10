// @vitest-environment jsdom
// 前端认证启动协调:旧会话门控、demo 自动登录降级、主动退出与被动过期语义。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TOKEN_KEY = 'standard-build.auth.token'
const EMPLOYEE_KEY = 'standard-build.auth.employee'
const SUPPRESSED_KEY = 'standard-build.demo-auto-login-suppressed'

const oldEmployee = {
  id: 'employee-old',
  name: '旧用户',
  tenantId: 'tenant-old',
  phone: '13800000000',
}

const demoEmployee = {
  id: 'employee-demo',
  name: '王老板',
  tenantId: 'tenant-demo',
  phone: '13800000001',
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.resetModules()
})

describe('前端认证启动协调', () => {
  it('协调前旧 token 不算认证，成功后持久化新会话且并发调用复用 Promise', async () => {
    localStorage.setItem(TOKEN_KEY, 'old-token')
    localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(oldEmployee))
    const { initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi.fn().mockResolvedValue({ token: 'demo-token', employee: demoEmployee })

    expect(auth.isAuthenticated.value).toBe(false)

    const first = initializeAuth(loadDemoSession)
    const second = initializeAuth(loadDemoSession)
    expect(second).toBe(first)
    await first

    expect(loadDemoSession).toHaveBeenCalledTimes(1)
    expect(auth.authStartupComplete.value).toBe(true)
    expect(auth.isAuthenticated.value).toBe(true)
    expect(auth.token.value).toBe('demo-token')
    expect(auth.employee.value).toEqual(demoEmployee)
    expect(localStorage.getItem(TOKEN_KEY)).toBe('demo-token')
    expect(JSON.parse(localStorage.getItem(EMPLOYEE_KEY)!)).toEqual(demoEmployee)
  })

  it('抑制标记阻止 demo 接口调用，协调完成后仍停留未登录状态', async () => {
    localStorage.setItem(TOKEN_KEY, 'old-token')
    localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(oldEmployee))
    sessionStorage.setItem(SUPPRESSED_KEY, '1')
    const { initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi.fn()

    await initializeAuth(loadDemoSession)

    expect(loadDemoSession).not.toHaveBeenCalled()
    expect(auth.authStartupComplete.value).toBe(true)
    expect(auth.isAuthenticated.value).toBe(false)
  })

  it('demo 接口失败时静默完成协调并沿用当前本地会话', async () => {
    localStorage.setItem(TOKEN_KEY, 'old-token')
    localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(oldEmployee))
    const { initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()

    await expect(initializeAuth(() => Promise.reject(new Error('network down')))).resolves.toBeUndefined()

    expect(auth.authStartupComplete.value).toBe(true)
    expect(auth.isAuthenticated.value).toBe(true)
    expect(auth.token.value).toBe('old-token')
    expect(auth.employee.value).toEqual(oldEmployee)
  })

  it('启动 loader 内派发 401 时不额外触发运行时恢复', async () => {
    const { AUTH_EXPIRED_EVENT, initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi.fn().mockImplementation(() => {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
      return Promise.reject(new Error('demo login unauthorized'))
    })

    await expect(initializeAuth(loadDemoSession)).resolves.toBeUndefined()
    await Promise.resolve()

    expect(loadDemoSession).toHaveBeenCalledTimes(1)
    expect(auth.authStartupComplete.value).toBe(true)
    expect(auth.isAuthenticated.value).toBe(false)
  })

  it('主动退出写入抑制并清会话，随后手动 setSession 清除抑制', async () => {
    sessionStorage.setItem(SUPPRESSED_KEY, '1')
    const { useAuth } = await import('../../src/auth')
    const auth = useAuth()

    auth.setSession('manual-token', oldEmployee)
    expect(sessionStorage.getItem(SUPPRESSED_KEY)).toBeNull()

    auth.logout()
    expect(sessionStorage.getItem(SUPPRESSED_KEY)).toBe('1')
    expect(auth.token.value).toBe('')
    expect(auth.employee.value).toBeNull()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(EMPLOYEE_KEY)).toBeNull()

    auth.setSession('manual-token-next', oldEmployee)
    expect(sessionStorage.getItem(SUPPRESSED_KEY)).toBeNull()
    expect(localStorage.getItem(TOKEN_KEY)).toBe('manual-token-next')
  })

  // ★清会话必须连带清数字员工对话历史:对话里有客户名/报价/财务数字,
  //   共用浏览器时留着会漏给下一个登录的人。主动退出与被动过期两条路径都要清。
  it('清会话连带清掉数字员工对话历史，不误伤其他键', async () => {
    const { AUTH_EXPIRED_EVENT, DE_CHAT_KEY_PREFIX, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const seedChats = () => {
      localStorage.setItem(`${DE_CHAT_KEY_PREFIX}emp-1`, '{"messages":[{"role":"user","text":"报价 38 万"}]}')
      localStorage.setItem(`${DE_CHAT_KEY_PREFIX}emp-2`, '{"messages":[]}')
      localStorage.setItem('standard-build.theme', 'dark')
    }

    // 主动退出
    auth.setSession('t1', oldEmployee)
    seedChats()
    auth.logout()
    expect(localStorage.getItem(`${DE_CHAT_KEY_PREFIX}emp-1`)).toBeNull()
    expect(localStorage.getItem(`${DE_CHAT_KEY_PREFIX}emp-2`)).toBeNull()
    expect(localStorage.getItem('standard-build.theme')).toBe('dark') // 无关键不动

    // 被动过期(401 / token 失效)走的是同一个 clearSession
    auth.setSession('t2', oldEmployee)
    seedChats()
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    expect(localStorage.getItem(`${DE_CHAT_KEY_PREFIX}emp-1`)).toBeNull()
    expect(localStorage.getItem(`${DE_CHAT_KEY_PREFIX}emp-2`)).toBeNull()
  })

  it('AUTH_EXPIRED_EVENT 只清会话，不写入 demo 自动登录抑制', async () => {
    const { AUTH_EXPIRED_EVENT, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    auth.setSession('expired-token', oldEmployee)

    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))

    expect(auth.token.value).toBe('')
    expect(auth.employee.value).toBeNull()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(EMPLOYEE_KEY)).toBeNull()
    expect(sessionStorage.getItem(SUPPRESSED_KEY)).toBeNull()
  })

  it('运行中收到 401 后清除旧会话并换取新 demo token', async () => {
    const { AUTH_EXPIRED_EVENT, initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi
      .fn()
      .mockResolvedValueOnce({ token: 'startup-token', employee: demoEmployee })
      .mockResolvedValueOnce({ token: 'recovered-token', employee: demoEmployee })
    await initializeAuth(loadDemoSession)

    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))

    await vi.waitFor(() => expect(auth.token.value).toBe('recovered-token'))
    expect(loadDemoSession).toHaveBeenCalledTimes(2)
    expect(auth.isAuthenticated.value).toBe(true)
    expect(localStorage.getItem(TOKEN_KEY)).toBe('recovered-token')
  })

  it('并发 401 复用同一个运行时恢复请求', async () => {
    let resolveRecovery!: (session: { token: string; employee: typeof demoEmployee }) => void
    const recovery = new Promise<{ token: string; employee: typeof demoEmployee }>((resolve) => {
      resolveRecovery = resolve
    })
    const { AUTH_EXPIRED_EVENT, initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi
      .fn()
      .mockResolvedValueOnce({ token: 'startup-token', employee: demoEmployee })
      .mockReturnValueOnce(recovery)
    await initializeAuth(loadDemoSession)

    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    await vi.waitFor(() => expect(loadDemoSession).toHaveBeenCalledTimes(2))
    resolveRecovery({ token: 'deduped-token', employee: demoEmployee })

    await vi.waitFor(() => expect(auth.token.value).toBe('deduped-token'))
    expect(loadDemoSession).toHaveBeenCalledTimes(2)
  })

  it('非 demo loader 失败后停留未登录且不会递归重试', async () => {
    const { AUTH_EXPIRED_EVENT, initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi
      .fn()
      .mockResolvedValueOnce({ token: 'startup-token', employee: demoEmployee })
      .mockImplementationOnce(() => {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
        return Promise.reject(new Error('demo login unavailable'))
      })
    await initializeAuth(loadDemoSession)

    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))

    await vi.waitFor(() => expect(auth.token.value).toBe(''))
    await Promise.resolve()
    expect(loadDemoSession).toHaveBeenCalledTimes(2)
    expect(auth.isAuthenticated.value).toBe(false)
  })

  it('主动退出后迟到的 401 不触发 demo 恢复', async () => {
    const { AUTH_EXPIRED_EVENT, initializeAuth, useAuth } = await import('../../src/auth')
    const auth = useAuth()
    const loadDemoSession = vi.fn().mockResolvedValue({ token: 'startup-token', employee: demoEmployee })
    await initializeAuth(loadDemoSession)

    auth.logout()
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    await Promise.resolve()

    expect(loadDemoSession).toHaveBeenCalledTimes(1)
    expect(auth.token.value).toBe('')
    expect(auth.employee.value).toBeNull()
    expect(sessionStorage.getItem(SUPPRESSED_KEY)).toBe('1')
  })
})
