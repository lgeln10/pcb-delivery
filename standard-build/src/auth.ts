// src/auth.ts
// 登录状态与启动协调的前端单例。token 只存在浏览器 localStorage,API 客户端每次请求即时读取。
// 启动时由 App 注入 demo 会话加载函数；本文件不依赖 API client，避免形成循环依赖。
import { computed, ref } from 'vue'

export const TOKEN_KEY = 'standard-build.auth.token'
export const EMPLOYEE_KEY = 'standard-build.auth.employee'
// 数字员工对话历史的 localStorage 前缀(写入方:modules/digitalemployee/ui/DigitalEmployeeDesk.vue)。
// ★清会话时必须一起清:对话里有客户名/报价/财务数字,共用浏览器时会漏给下一个登录的人。
export const DE_CHAT_KEY_PREFIX = 'sb.dechat.'
// 内置智能体(销售助理/需求助手)对话历史前缀(写入方:modules/im-connect/ui/builtin-chat-store.ts)。
// ★同样必须随会话清:销售助理的对话里就是线索/客户/商机金额,泄漏面和数字员工那条一模一样。
export const BUILTIN_CHAT_KEY_PREFIX = 'sb.builtinchat.'
export const AUTH_EXPIRED_EVENT = 'standard-build.auth.expired'
// 会话清除广播:内置智能体对话是**模块级** store(状态活在内存里,不随组件卸载消失),
// 光清 localStorage 拦不住它 —— 退出后同一页面再登录,内存里还是上一个人的对话;
// 飞行中的回复甚至会在清库之后把旧对话重新写回去。store 听到这个事件后丢弃全部状态。
// 用事件而不是直接调用:本文件刻意不依赖任何 UI/业务模块(见文件头),反着 import 会成环。
export const SESSION_CLEARED_EVENT = 'standard-build.session-cleared'
export const DEMO_AUTO_LOGIN_SUPPRESSED_KEY = 'standard-build.demo-auto-login-suppressed'

export type AuthEmployee = {
  id: string
  name: string
  tenantId: string
  phone: string
}

const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
const employee = ref<AuthEmployee | null>(readEmployee())
const authStartupComplete = ref(false)
const demoAutoLoginSuppressed = ref(sessionStorage.getItem(DEMO_AUTO_LOGIN_SUPPRESSED_KEY) === '1')
let authStartupPromise: Promise<void> | null = null

function readEmployee(): AuthEmployee | null {
  const raw = localStorage.getItem(EMPLOYEE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthEmployee
  } catch {
    localStorage.removeItem(EMPLOYEE_KEY)
    return null
  }
}

type AuthSession = { token: string; employee: AuthEmployee }
type DemoSessionLoader = () => Promise<AuthSession>

let demoSessionLoader: DemoSessionLoader | null = null
let authRecoveryPromise: Promise<void> | null = null

function clearSession() {
  token.value = ''
  employee.value = null
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EMPLOYEE_KEY)
  // 数字员工对话历史随会话一起清:留着会让同一浏览器上的下一个登录者看到上一个人的对话
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(DE_CHAT_KEY_PREFIX) || k.startsWith(BUILTIN_CHAT_KEY_PREFIX)) localStorage.removeItem(k)
  }
  // 内存里的对话 store 也得跟着丢(见 SESSION_CLEARED_EVENT 注释)
  window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT))
}

function setSession(nextToken: string, nextEmployee: AuthEmployee) {
  demoAutoLoginSuppressed.value = false
  sessionStorage.removeItem(DEMO_AUTO_LOGIN_SUPPRESSED_KEY)
  token.value = nextToken
  employee.value = nextEmployee
  localStorage.setItem(TOKEN_KEY, nextToken)
  localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(nextEmployee))
}

/**
 * 清本地会话。★服务端那枚令牌的作废**不在这里**做 —— 本文件不依赖 API client(见文件头,
 * 避免循环依赖),所以调用方(App.vue 的 confirmLogout)负责先调 apiLogout()。
 * 光调这个函数 = 只清了浏览器,令牌在服务端还活 7 天。
 */
function logout() {
  demoAutoLoginSuppressed.value = true
  sessionStorage.setItem(DEMO_AUTO_LOGIN_SUPPRESSED_KEY, '1')
  clearSession()
}

/**
 * 单页生命周期只执行一次的认证启动协调。
 * demo 登录不可用是部署环境的正常情况，因此失败只结束协调并沿用当前本地会话。
 */
export function initializeAuth(loadDemoSession: () => Promise<AuthSession>): Promise<void> {
  if (!demoSessionLoader) demoSessionLoader = loadDemoSession
  if (authStartupPromise) return authStartupPromise

  authStartupPromise = (async () => {
    try {
      if (demoAutoLoginSuppressed.value) return
      const session = await loadDemoSession()
      setSession(session.token, session.employee)
    } catch (error) {
      // 404/401/网络错误均是预期降级路径；不展示错误，协调后由现有会话决定登录态。
      void error
    } finally {
      authStartupComplete.value = true
    }
  })()

  return authStartupPromise
}

function recoverDemoSession(): Promise<void> {
  // 启动 loader 自身的 401 由启动协调静默降级，不能再触发第二次 demo-login。
  if (!authStartupComplete.value || demoAutoLoginSuppressed.value || !demoSessionLoader) {
    return Promise.resolve()
  }
  if (authRecoveryPromise) return authRecoveryPromise

  const loader = demoSessionLoader
  const recovery = Promise.resolve()
    .then(() => loader())
    .then((session) => {
      // 主动退出可能发生在 demo 请求飞行期间；此时迟到的响应不得重新建立会话。
      if (!demoAutoLoginSuppressed.value) setSession(session.token, session.employee)
    })
    .catch((error) => {
      // 非 demo 环境的 404/401 及网络失败均静默降级；401 事件会复用当前 Promise，不递归请求。
      void error
    })
    .finally(() => {
      if (authRecoveryPromise === recovery) authRecoveryPromise = null
    })

  authRecoveryPromise = recovery
  return recovery
}

export function useAuth() {
  // 协调完成前压住旧 token，防止 App 级受保护查询抢跑。
  const isAuthenticated = computed(
    () => authStartupComplete.value && !demoAutoLoginSuppressed.value && Boolean(token.value),
  )

  return { token, employee, isAuthenticated, authStartupComplete, setSession, logout }
}

window.addEventListener(AUTH_EXPIRED_EVENT, () => {
  // 被动过期先清失效会话；demo loader 已注册且未主动退出时，再静默换取当前会话。
  clearSession()
  void recoverDemoSession()
})

// 跨标签页会话同步:storage 事件只在「其他」标签页触发。别的标签页清了/换了 token,
// 本页内存态跟着走,否则本页会一直显示「已登录」而每个请求都 401。
// localStorage 里的键已由触发方写好,这里只同步内存 ref,不再回写。
window.addEventListener('storage', (e) => {
  if (e.key !== TOKEN_KEY) return
  if (!e.newValue) {
    token.value = ''
    employee.value = null
    // 别的标签页退出了:本页内存里的对话 store 同样不能留给下一个登录的人
    window.dispatchEvent(new CustomEvent(SESSION_CLEARED_EVENT))
  } else if (e.newValue !== token.value) {
    token.value = e.newValue
    employee.value = readEmployee()
  }
})
