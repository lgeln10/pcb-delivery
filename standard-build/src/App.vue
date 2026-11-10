<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { ArrowRightLeft, Bell, Bot, Boxes, BrainCircuit, Building2, CalendarClock, CalendarDays, ChartColumn, CircleDollarSign, ClipboardCheck, Coins, FileSignature, FileText, Gem, GitBranch,
  Gauge, Globe, Handshake, IdCard, KeyRound, Landmark, LayoutDashboard, Lightbulb, Mail, Menu, MessageCircle, Moon, Package, PanelLeftClose, PanelLeftOpen, ReceiptText, ScrollText, Settings2, ShoppingCart, SlidersHorizontal, Sprout, Sun, Tags, Target, Users, Wallet, Workflow, Inbox, Newspaper, Sparkles, Link2, BookOpen, PieChart, Search, ChevronDown, LogOut, MessageSquarePlus, QrCode , MapPin, Route, Network, FolderKanban, UserRound, Factory,
} from '@lucide/vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'
// EP 组件默认英文文案(分页条 "Total/page"、空表 "No Data"、日期面板英文星期)——中文系统里非常扎眼。
// 用 <el-config-provider> 而不是 app.use(ElementPlus, { locale }):后者依赖全量引入,前者在
// 全量与按需(unplugin resolver)两种装法下都生效。
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import AsyncState from '../core/ui-kit/AsyncState.vue'
import LoginPage from './pages/LoginPage.vue'
import LicenseBanner from './ui/LicenseBanner.vue'
import NotificationBell from '../modules/inapp-notify/ui/NotificationBell.vue'
import { NAV_CATALOG, flattenNavItems, isNavFolder } from './nav-catalog'
import { apiLogout, apiDemoLogin, apiGetAppSettings, apiGetLicense, apiListFeatureToggles, apiGetMenuOrder, apiMyPermissions, apiGetInappNotifyCount, errorMessage, API_CLIENT_VERSION } from './api/client'
import { initializeAuth, useAuth, TOKEN_KEY } from './auth'
import { isNativeShell, nativeShellLogout } from './native-app'
import { requestQrLogin } from '../core/org/ui/qr-login-open'
import { useIsMobile } from './composables/useIsMobile'
import { lazyPage } from './lazy-page'
import MobileTabBar from './ui/MobileTabBar.vue'
import { visibleMobileTabs } from './mobile-tabs'
import { isMobileImmersive } from './mobile-immersive'
import { readNavCollapsed, writeNavCollapsed } from './nav-collapse'

type SectionKey =
  | 'pcb-cam'
  | 'notifications'
  | 'org'
  | 'roles'
  | 'audit'
  | 'notify-config'
  | 'app-settings'
  | 'my-settings'
type NavItem ={ key: SectionKey; label: string; icon: unknown; permission?: string; hidden?: boolean }
/** 二级文件夹:本身不是页面,没有 permission —— 可见性由「过滤后还剩几个子项」决定。 */
type NavFolderView = { key: string; label: string; icon: unknown; children: NavItem[] }
type NavEntryView = NavItem | NavFolderView
type NavGroup = { key: string; label: string; icon: unknown; items: NavEntryView[] }
const isFolderView = (e: NavEntryView): e is NavFolderView => Array.isArray((e as NavFolderView).children)
const flattenEntries = (items: NavEntryView[]): NavItem[] => items.flatMap((e) => (isFolderView(e) ? e.children : [e]))

// 业务页面按菜单懒加载,避免登录首屏把 CRM/财务/进销存/HR 等全部打进主包。
const NotificationsPage = lazyPage(() => import('../modules/inapp-notify/ui/NotificationsPage.vue'))
const PcbCamWorkspace = lazyPage(() => import('../modules/pcb-cam/ui/PcbCamWorkspace.vue'))
const RolePermissions = lazyPage(() => import('../core/org/ui/RolePermissions.vue'))
const NotifyConfig = lazyPage(() => import('../modules/notify/ui/NotifyConfig.vue'))
const AppSettings = lazyPage(() => import('../modules/app-settings/ui/AppSettings.vue'))
const AuditLog = lazyPage(() => import('../core/audit/ui/AuditLog.vue'))
const OrgManagement = lazyPage(() => import('../core/org/ui/OrgManagement.vue'))
// 个人设置(头像 / 修改密码 / 企业邮箱)。不进左侧菜单(nav-catalog 里 hidden: true),
// 入口是右上角账号菜单;但它是一个正经 section —— 深链 #/my-settings、顶栏标题、si:navigate 都照旧。
const PersonalSettings = lazyPage(() => import('../core/org/ui/PersonalSettings.vue'))

const { employee, isAuthenticated, authStartupComplete, logout, setSession } = useAuth()
// 启动认证:App 壳内会话已由 main.ts 的 nativeShellBootstrap 领养,这里只压住 demo
// 自动登录(壳是真实登录面,demo 环境的王老板不能把壳递交的真实身份顶掉);
// 飞书客户端里打开先走免登;其余情况照旧,由 initializeAuth 决定 demo 会话还是登录页。
void bootAuth()
async function bootAuth() {
  if (isNativeShell()) {
    void initializeAuth(() => Promise.reject(new Error('native shell: demo auto-login disabled')))
    return
  }
  void initializeAuth(apiDemoLogin)
}
const queryClient = useQueryClient()

const SESSION_SECTION_KEY = 'standard-build.active-section'

/**
 * ── 地址栏路由(hash 式)────────────────────────────────────────────
 * 早先只把页面记在 history.state 里,**URL 从头到尾不变** —— 于是链接分享不了、
 * 刷新回不到原处、别人问「你说的那条工作流在哪」只能口述路径(实测反馈)。
 *
 * 用 hash 而不是 history 路径:这套是纯前端 SPA,换成路径就要服务端对所有路径回落
 * index.html(Caddy 那边得改),hash 不用动部署,收益一样。
 * 形式:`#/工作流` → `#/si-workflows`;二级 → `#/si-workflows/<自动化id>`。
 */
function parseHash(): { section: string | null; sub: string | null } {
  const raw = location.hash.replace(/^#\/?/, '')
  if (!raw) return { section: null, sub: null }
  const [section, sub] = raw.split('/')
  return { section: section || null, sub: sub || null }
}
function writeHash(section: string, sub?: string | null, replace = false) {
  const next = `#/${section}${sub ? `/${sub}` : ''}`
  if (location.hash === next) return
  // 用 replaceState/pushState 而不是直接改 location.hash —— 后者会额外触发一次 hashchange,
  // 和我们自己的 popstate 处理打架
  history[replace ? 'replaceState' : 'pushState']({ ...(history.state ?? {}), siSection: section, siSub: sub ?? null }, '', next)
}
const pendingAutomationId = ref<string | null>(parseHash().sub)

const activeSection = ref<SectionKey>(
  // 优先地址栏(能分享/能刷新),其次上次停留的页
  (parseHash().section as SectionKey | null)
  ?? (sessionStorage.getItem(SESSION_SECTION_KEY) as SectionKey | null)
  ?? 'pcb-cam',
)
// 侧栏收起/展开:桌面档的用户偏好,跨会话记忆(默认展开)。
// ★只有用户点汉堡键才改它 —— 没有任何页面会替用户收起侧栏(见下方「问AI」那段的说明)。
const collapsed = ref(readNavCollapsed())
// 供子页面(如数字员工工位)判断:主导航收起时才腾出空间显示右侧收件箱
provide('navCollapsed', collapsed)

// 主题:亮 / 暗 / 暗金,写 <html data-theme>(深色与暗金 token 见 tokens.css),localStorage 记忆。
// 未手动选过主题时按时间取默认:夜间 20:00–次日 08:00 默认暗色,其余默认亮色(手动选过则始终尊重存储值)。
type Theme = 'light' | 'dark' | 'gold'
const THEMES: Theme[] = ['light', 'dark', 'gold']
const THEME_KEY = 'standard-build.theme'
function defaultThemeByTime(): Theme {
  const h = new Date().getHours()
  return h >= 20 || h < 8 ? 'dark' : 'light'
}
const stored = localStorage.getItem(THEME_KEY)
const theme = ref<Theme>((THEMES as string[]).includes(stored ?? '') ? (stored as Theme) : defaultThemeByTime())
function applyTheme(t: Theme) { document.documentElement.dataset.theme = t }
applyTheme(theme.value) // setup 阶段即生效,避免首屏闪烁
watch(theme, (t) => { localStorage.setItem(THEME_KEY, t); applyTheme(t) })
const THEME_LABEL: Record<Theme, string> = { light: '亮色', dark: '暗色', gold: '暗金' }
const THEME_ICON = { light: Sun, dark: Moon, gold: Gem }
const themeIcon = computed(() => THEME_ICON[theme.value])
// 单按钮循环切换:亮 → 暗 → 暗金 → 亮
function cycleTheme() { theme.value = THEMES[(THEMES.indexOf(theme.value) + 1) % THEMES.length]! }

// 三档形态。★断点必须与 styles.css 的媒体查询同数,两边分歧过一次:
//   壳层用 960、页面组件用 768,769–960 那一段就变成「桌面 DOM + 移动 CSS」的混合体,
//   筛选栏因此横向溢出三千像素、筛选项根本够不着(2026-08-02 修,见 styles.css 那条注释)。
//   ≤768   手机:off-canvas 抽屉侧栏 + 底部 tab 栏
//   769–1100 平板/展开的折叠屏:侧栏常驻但收成图标条,不要底部 tab —— 这个宽度
//            (华为 Mate X 系列展开约 890px、Galaxy Fold 约 820px)完全放得下常驻导航,
//            按手机处理等于白白浪费一条侧栏的宽度还多占 64px 底部高度。
//   >1100  桌面:侧栏展开/收起由用户自己定
const isMobile = useIsMobile('(max-width: 768px)')
const isTablet = useIsMobile('(min-width: 769px) and (max-width: 1100px)')
/**
 * 平板档里侧栏是否被用户临时展开。★单独一个 ref 而不是复用 collapsed:
 * collapsed 是**桌面**的用户偏好(持久化),折叠屏合上再展开不该把它改掉。
 */
const tabletNavExpanded = ref(false)
/** 侧栏是否呈图标条:平板档默认是(除非用户点开),桌面档看用户偏好 */
const railMode = computed(() => (isTablet.value ? !tabletNavExpanded.value : collapsed.value))
const mobileNavOpen = ref(false)
function toggleNav() {
  // ★三档各切各的:漏了平板这一档,汉堡键在 769–1100 会变成死键
  //   —— railMode 只看 isTablet 时,切 collapsed 不产生任何可见变化。
  if (isMobile.value) mobileNavOpen.value = !mobileNavOpen.value
  else if (isTablet.value) tabletNavExpanded.value = !tabletNavExpanded.value
  else {
    collapsed.value = !collapsed.value
    writeNavCollapsed(collapsed.value) // 只有这里落盘:这是用户**显式**表达的偏好
  }
}
// 离开平板档就把临时展开收回:折叠屏合上再展开,应该回到默认的图标条
watch(isTablet, (on) => { if (!on) tabletNavExpanded.value = false })
const myPermissionsQuery = useQuery({
  queryKey: computed(() => ['me', 'permissions', API_CLIENT_VERSION, isAuthenticated.value]),
  queryFn: () => apiMyPermissions(),
  enabled: isAuthenticated,
  // App 是根组件、登录期间不会重挂载:这条查询失败后没有天然的下一次重试,而 hasPermission
  // 对 undefined 一律 fail-closed,会把全部菜单隐藏成「已登录但什么都点不了」。
  // 失败态每 5 秒自动重拉直到成功(后端重启窗口/网络抖动自愈)。
  refetchInterval: (query) => (query.state.status === 'error' ? 5_000 : false),
})
const myPermissionCodes = computed(() => myPermissionsQuery.data.value?.codes)
const hasPermission = (code?: string) => {
  if (!code) return true
  const codes = myPermissionCodes.value
  return codes === null || (Array.isArray(codes) && codes.includes(code))
}

// 功能开关:被关闭的 group:/menu:/perm: 键。菜单组/菜单据此对所有人(含超管)从导航隐藏。
const featureTogglesQuery = useQuery({
  queryKey: computed(() => ['feature-toggles', isAuthenticated.value]),
  queryFn: () => apiListFeatureToggles(),
  enabled: isAuthenticated,
})
const disabledKeys = computed(() => new Set(featureTogglesQuery.data.value?.disabledKeys ?? []))

// 菜单排序:全系统统一的侧边栏顺序(所有用户共享)。缺失的 key 回落 nav-catalog 原序追加、未知 key 忽略
// —— 排序只重排,不隐藏,核心入口永远排得进去(不会被拖到不可见位置)。见 modules/menu-order。
const menuOrderQuery = useQuery({
  queryKey: computed(() => ['menu-order', isAuthenticated.value]),
  queryFn: () => apiGetMenuOrder(),
  enabled: isAuthenticated,
})
const savedGroupOrder = computed(() => menuOrderQuery.data.value?.groups ?? [])
const savedItemOrder = computed(() => menuOrderQuery.data.value?.items ?? {})
/** 按已保存顺序稳定重排:命中顺序的排前(按其位置),未命中的按原序追加在末尾(stable sort 保序)。 */
function orderBy<T>(list: T[], keyOf: (x: T) => string, order: string[]): T[] {
  if (order.length === 0) return list
  const rank = new Map(order.map((k, i) => [k, i]))
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.get(keyOf(a.item)) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(keyOf(b.item)) ?? Number.MAX_SAFE_INTEGER
      return ra === rb ? a.i - b.i : ra - rb
    })
    .map((x) => x.item)
}

// 图标按 key 贴回(分组 key + 菜单 key 各一套);导航结构本体在 src/nav-catalog.ts(与功能开关页共用)。
// 新增菜单:先在 nav-catalog.ts 加 key/label/permission,再在这里给同名 key 配图标。
const NAV_ICONS: Record<string, unknown> = {
  manufacturing: Factory, biz: Bell, sys: Settings2,
  'pcb-cam': Package, notifications: Bell,
  org: Users, roles: KeyRound, 'notify-config': Bell, 'app-settings': SlidersHorizontal, audit: ScrollText,
  'my-settings': UserRound,
}
// 分组导航:当前页所在分组在首屏自动展开(default-openeds)。结构本体见 src/nav-catalog.ts。
const toNavItem = (item: { key: string; label: string; permission?: string; hidden?: boolean }): NavItem => ({
  key: item.key as SectionKey,
  label: item.label,
  icon: NAV_ICONS[item.key],
  permission: item.permission,
  // hidden = 可达但不进菜单(见 nav-catalog.ts)。只在渲染菜单那一层过滤,别在这里丢掉。
  hidden: item.hidden,
})
const allGroups: NavGroup[] = NAV_CATALOG.map((group) => ({
  key: group.key,
  label: group.label,
  icon: NAV_ICONS[group.key],
  items: group.items.map((entry): NavEntryView =>
    isNavFolder(entry)
      ? { key: entry.key, label: entry.label, icon: NAV_ICONS[entry.key], children: entry.children.map(toNavItem) }
      : toNavItem(entry),
  ),
}))
// 授权:未采购「智能体工作台」的客户,整块企业智能体(si 组)不显示。默认 true(加载中/失败不误删)。
const licenseQuery = useQuery({
  queryKey: computed(() => ['license', API_CLIENT_VERSION, isAuthenticated.value]),
  queryFn: apiGetLicense,
  enabled: isAuthenticated,
  retry: false,
})
const aiEnabled = computed(() => licenseQuery.data.value?.aiEnabled !== false)

const leafVisible = (item: NavItem): boolean =>
  hasPermission(item.permission) &&
  !disabledKeys.value.has('menu:' + item.key) && // 功能开关:关闭的菜单隐藏
  !(item.permission && disabledKeys.value.has('perm:' + item.permission)) // 菜单关联功能被关 → 菜单也隐藏

const groups = computed<NavGroup[]>(() =>
  orderBy(allGroups, (g) => g.key, savedGroupOrder.value) // 一级菜单(分组)按保存顺序重排
    .filter((group) => group.key !== 'si' || aiEnabled.value) // 未采购 AI → 隐藏企业智能体整组
    .filter((group) => !disabledKeys.value.has('group:' + group.key)) // 功能开关:关闭的菜单组整组隐藏
    .map((group) => ({
      ...group,
      // 二级菜单(叶子菜单 / 二级文件夹)按该分组保存的顺序重排;文件夹内子项(三级)不排,沿用目录序。
      items: orderBy(group.items, (e) => e.key, savedItemOrder.value[group.key] ?? [])
        .map((entry): NavEntryView | null => {
          if (!isFolderView(entry)) return leafVisible(entry) ? entry : null
          if (disabledKeys.value.has('menu:' + entry.key)) return null // 整个文件夹被关
          const children = entry.children.filter(leafVisible)
          // ★子项被权限/开关滤空的文件夹必须整个消失 —— 否则点开是空的,比没有更糟。
          return children.length > 0 ? { ...entry, children } : null
        })
        .filter((e): e is NavEntryView => e != null),
    }))
    .filter((group) => group.items.length > 0),
)
// 当前所选栏目若已不可见(如未采购 AI 却停在企业智能体页)→ 跳到第一个可见栏目,避免看到空白/无权页。
//
// ★**权限没加载完之前不许跳**:hasPermission 对 undefined 是 fail-closed,加载中导航只剩
//   免权限的那几项,这条守卫会立刻把人弹到第一个可见页 —— 于是任何指向「需要权限的页面」的
//   深链(#/si-workflows 这种)一进来就被弹回 Ask AI,等权限回来也不会跳回去(实测)。
watch(groups, (gs) => {
  if (myPermissionCodes.value === undefined) return // 权限还没到,先别下判断
  const visible = gs.flatMap((g) => flattenEntries(g.items)).map((i) => i.key)
  if (visible.length && !visible.includes(activeSection.value)) activeSection.value = flattenEntries(gs[0]!.items)[0]!.key
})
const groupOf = (section: SectionKey) => groups.value.find((g) => flattenEntries(g.items).some((i) => i.key === section))?.key ?? 'biz'
/** 该页所在的二级文件夹 key(不在文件夹里则 null)。展开状态要同时开分组和文件夹两层。 */
const folderOf = (section: SectionKey): string | null => {
  for (const g of groups.value) {
    for (const e of g.items) if (isFolderView(e) && e.children.some((c) => c.key === section)) return e.key
  }
  return null
}
/** 手风琴同步:选中某页时把它所在的分组 + 文件夹都展开(两层都要,否则选中项藏在收起的文件夹里)。 */
function openTrail(section: SectionKey) {
  menuRef.value?.open(groupOf(section))
  const folder = folderOf(section)
  if (folder) menuRef.value?.open(folder)
}
const openedGroups = ref<string[]>([groupOf(activeSection.value), folderOf(activeSection.value)].filter(Boolean) as string[])
const menuRef = ref<{ open: (index: string) => void } | null>(null)

// 刷新保页：导航时写 sessionStorage；退出/过期时清空，确保下次登录回到工作台
watch(activeSection, (s) => { sessionStorage.setItem(SESSION_SECTION_KEY, s) })
watch(isAuthenticated, (authed) => {
  if (!authed) {
    sessionStorage.removeItem(SESSION_SECTION_KEY)
    activeSection.value = 'pcb-cam'
  }
})


/**
 * 当前可见的**叶子**菜单(已展开二级文件夹)。凡是「遍历所有页面」的地方一律用它。
 * ★踩过:加了二级文件夹之后,`groups.flatMap(g => g.items)` 里混进的是**文件夹对象**,
 *   文件夹里那 10 个页面(银行对账/固定资产/客户查重…)反而一个都不在集合里。表现是
 *   标题栏显示「工作台」、以及通知深链/浏览器返回跳不进这些页 —— 两处都不报错。
 */
const visibleLeaves = computed<NavItem[]>(() => groups.value.flatMap((g) => flattenEntries(g.items)))

/**
 * 左侧菜单**渲染用**的分组:把 `hidden` 的叶子摘掉(它们仍是可达页面,只是已有别的入口)。
 *
 * ★只在渲染这一层摘,不动 `groups` 本身 —— `visibleLeaves` / `knownSections` / 顶栏标题
 *   全是从 groups 算的。要是在 groups 里就滤掉,`si:navigate` 的白名单会跟着少一个 key,
 *   全仓 5 处「跳去任务收件箱」的按钮当场静默变成死按钮(见 nav-catalog 的 hidden 注释)。
 */
const menuGroups = computed<NavGroup[]>(() =>
  groups.value
    .map((group) => ({
      ...group,
      items: group.items
        .map((entry): NavEntryView | null => {
          if (!isFolderView(entry)) return entry.hidden ? null : entry
          const children = entry.children.filter((c) => !c.hidden)
          return children.length > 0 ? { ...entry, children } : null
        })
        .filter((e): e is NavEntryView => e != null),
    }))
    .filter((group) => group.items.length > 0),
)

/**
 * 手机菜单搜索。抽屉里有 10 个分组、68 个页面,而高频入口已经在底部 tab 上 ——
 * 会来翻抽屉的人多半是找一个**不常用**的页面(「付款凭证」「汇率管理」),那正是最难滚到的。
 * 输入即跨分组扁平列出命中,连分组名一起显示(同名概念在不同分组里出现过,只给标签会选错)。
 * ★只在手机渲染:桌面侧栏是常驻的,一眼扫得到,再加个框反而占地方。
 * ★声明必须排在 menuGroups **之后** —— const 不提升,顺序反了就是 setup 期 TDZ、整页白屏
 *   (仓里已经栽过一次,见 memory: vue-setup-tdz-blank-page)。
 */
const menuSearch = ref('')

// ── 拼音首字母匹配:打「fkpz」找得到「付款凭证」 ─────────────────────────────
// ★不引拼音数据表:用 Intl.Collator 的 zh-CN 拼音排序做「边界字二分」——
//   「付」排在「发(f 段起点)」之后、「噶(g 段起点)」之前,首字母就是 f。
//   多音字会按词典序取主音(「行」得 h),对菜单搜索这个用途足够;不支持的引擎返回空串,
//   彻底退化成原来的子串匹配,不会更糟。
const PY_BOUNDARIES: Array<[string, string]> = [
  ['a', '阿'], ['b', '芭'], ['c', '擦'], ['d', '搭'], ['e', '蛾'], ['f', '发'], ['g', '噶'],
  ['h', '哈'], ['j', '击'], ['k', '喀'], ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '哦'],
  ['p', '啪'], ['q', '七'], ['r', '然'], ['s', '撒'], ['t', '塌'], ['w', '挖'], ['x', '西'],
  ['y', '压'], ['z', '匝'],
]
const pinyinCollator = (() => {
  try { return new Intl.Collator('zh-CN-u-co-pinyin') } catch { return null }
})()
const initialsCache = new Map<string, string>()
function labelInitials(label: string): string {
  const hit = initialsCache.get(label)
  if (hit !== undefined) return hit
  let out = ''
  if (pinyinCollator) {
    for (const ch of label) {
      if (/[a-z0-9]/i.test(ch)) { out += ch.toLowerCase(); continue }
      if (!/[\u4e00-\u9fff]/.test(ch)) continue
      let letter = ''
      for (const [l, boundary] of PY_BOUNDARIES) {
        if (pinyinCollator.compare(boundary, ch) <= 0) letter = l
        else break
      }
      out += letter
    }
  }
  initialsCache.set(label, out)
  return out
}

const menuHits = computed(() => {
  const kw = menuSearch.value.trim().toLowerCase()
  if (!kw) return []
  // 纯字母的关键词才走拼音首字母通道(混着汉字说明人在打全名)
  const kwIsAscii = /^[a-z0-9]+$/.test(kw)
  const out: Array<{ key: SectionKey; label: string; icon: NavItem['icon']; groupLabel: string }> = []
  for (const group of menuGroups.value) {
    for (const entry of group.items) {
      // 文件夹本身不是页面(不可点、没有 permission),只收它的子项
      const leaves = isFolderView(entry) ? entry.children : [entry]
      for (const leaf of leaves) {
        if (leaf.label.toLowerCase().includes(kw) || (kwIsAscii && labelInitials(leaf.label).includes(kw))) {
          out.push({ key: leaf.key, label: leaf.label, icon: leaf.icon, groupLabel: group.label })
        }
      }
    }
  }
  return out.slice(0, 20) // 命中太多说明关键词太泛,再往下列不如让人多打一个字
})
// 抽屉一关就清搜索:下次拉开菜单该是完整目录,不是上次搜到一半的残留。
// ★拉开时**不**自动聚焦:聚焦 = 立刻弹软键盘盖掉半屏菜单,而拉开抽屉的人多半是来**点**分组的,
//   不是马上打字(与 v-drawer-autofocus 在触屏上不聚焦是同一条判断)。真要搜,框就在最顶上。
watch(mobileNavOpen, (open) => {
  if (!open) menuSearch.value = ''
})

const activeTitle = computed(
  () => visibleLeaves.value.find((i) => i.key === activeSection.value)?.label ?? '工作台',
)
// 当前页所属模块(nav-catalog 显式映射):AI 需求助手用它高亮本页模块知识 + 本模块未完结需求去重
const activeModule = computed(
  () => NAV_CATALOG.flatMap((g) => flattenNavItems(g.items)).find((i) => i.key === activeSection.value)?.module,
)

// ── 系统设置(品牌:系统名称 + 企业 logo)──────────────────────────────────────
// 任一登录用户都要拿品牌渲染壳层(左上角 + 浏览器标签页标题);GET 仅需登录。
const DEFAULT_SYSTEM_NAME = 'PCB CAM'
const appSettingsQuery = useQuery({
  queryKey: computed(() => ['app-settings', isAuthenticated.value]),
  queryFn: () => apiGetAppSettings(),
  enabled: isAuthenticated,
})
const systemName = computed(() => appSettingsQuery.data.value?.systemName?.trim() || DEFAULT_SYSTEM_NAME)
const logoUrl = computed(() => appSettingsQuery.data.value?.logoUrl || null)
// 浏览器标签页标题:登录后跟随系统名称;未登录回落默认名。
watch(
  [systemName, isAuthenticated],
  ([name, authed]) => { document.title = authed ? name : DEFAULT_SYSTEM_NAME },
  { immediate: true },
)

function onSelect(index: string) {
  const next = index as SectionKey
  if (next === activeSection.value) { mobileNavOpen.value = false; return }
  activeSection.value = next
  // 浏览器历史:每次切换页面压入一条,使「返回」回到上一个页面而非退回打开系统前(甚至退出系统)。
  pendingAutomationId.value = null // 换页就不再停在某条详情上
  writeHash(next)
  // 手风琴:选中某页时只展开其所在分组,其它分组收起(配合 el-menu unique-opened)。
  openTrail(activeSection.value)
  mobileNavOpen.value = false // 移动端选中后自动收起抽屉
}
// 「返回」:从历史条目恢复上一个页面(不再压栈,避免与 pushState 互相触发)。
function onPopState(e: PopStateEvent) {
  // 以**地址栏**为准:直接改 hash(手输/收藏夹)时 history.state 是空的,只认 state 会漏掉
  const fromUrl = parseHash()
  const s = fromUrl.section ?? (e.state as { siSection?: string } | null)?.siSection
  pendingAutomationId.value = fromUrl.sub
  if (typeof s === 'string' && s !== activeSection.value && knownSections.value.has(s)) {
    activeSection.value = s as SectionKey
    openTrail(activeSection.value)
    mobileNavOpen.value = false
  }
}
function onLogout() {
  // ★先让服务端作废这枚令牌,再清本地 —— 顺序不能反:logout() 清掉 localStorage 之后
  //   请求就没有 Authorization 头了,服务端不知道该吊销哪一枚。
  //   不 await:界面必须立刻退出,不能被网络卡住。失败(离线 / 服务端是没有这个接口的旧版本)
  //   只是退化回旧行为(令牌等自然过期),不比以前差。
  void apiLogout().catch(() => {})
  logout()
  queryClient.clear()
  sessionStorage.removeItem(SESSION_SECTION_KEY)
  activeSection.value = 'pcb-cam'
  // App 壳内:清壳存的凭据并把整个 webview 退回壳登录页(浏览器里此调用是空操作)
  void nativeShellLogout()
}

// 右上角用户菜单:个人设置 / 退出
// ★「邮箱设置」「修改密码」两个弹窗 2026-08-16 搬进「个人设置」整页(core/org/ui/PersonalSettings.vue)。
//   账号菜单里塞表单是个死角:手机上下拉菜单本来就难点,弹窗里再套一层「高级设置」更没人找得到;
//   而且头像也要有个地方设,三件事凑在一起才够一页。菜单这里只留一个入口。
function onUserCommand(cmd: string) {
  // 手机上浮标隐藏,靠这个事件把「提需求」窗口叫起来(FeedbackWidget 监听)
  if (cmd === 'feedback') window.dispatchEvent(new CustomEvent('si:open-feedback'))
  else if (cmd === 'my-settings') onSelect('my-settings')
  // 先留便条再跳页:目标页是懒加载的,跳过去之后组件才挂载,挂载时自己来取(见 core/org/ui/qr-login-open.ts)
  else if (cmd === 'qr-login') { requestQrLogin(); onSelect('my-settings') }
  else if (cmd === 'logout') confirmLogout()
}
function confirmLogout() {
  ElMessageBox.confirm('确认退出当前账号?', '退出登录', {
    type: 'warning',
    confirmButtonText: '退出',
    cancelButtonText: '取消',
  })
    .then(() => onLogout())
    .catch(() => {}) // 取消不处理
}

// 我的 AI 工作台「打开」功能卡 → 跳到对应落地页(仅接受已知 section,避免乱跳)
const knownSections = computed(() => new Set<string>(visibleLeaves.value.map((i) => i.key)))
// 「需要处理」队列按它决定拉不拉某个源(可见性与菜单同源,见 modules/attention)
provide('knownSections', knownSections)
function onSiNavigate(e: Event) {
  const route = (e as CustomEvent<string>).detail
  if (typeof route === 'string' && knownSections.value.has(route)) onSelect(route)
}

onMounted(() => window.addEventListener('si:navigate', onSiNavigate))
onUnmounted(() => window.removeEventListener('si:navigate', onSiNavigate))

// ── 移动端底部 tab 栏 ──────────────────────────────────────────────────────
// 常驻四个高频入口(首页/助手/收件箱/通知)。左侧汉堡菜单照旧可去任何页面,这条栏不替代它;
// 站在别的页面(比如财务账表)时四个 tab 都不高亮,点任意一个都直接回到那一页。
// 可见性与左侧菜单同源:直接拿算好的 knownSections,不重算权限/开关/授权(见 src/mobile-tabs.ts)。
const mobileTabs = computed(() => visibleMobileTabs(knownSections.value))
// tab 栏真正出不出:还要看当前页有没有进「沉浸视图」(手机上的聊天窗)。
// ★两处必须用同一个判断 —— 下面的 `.app-shell--tabbar` 不只是显示开关,它同时下发
//   --sb-tabbar-h(内容区让位高度)与 --sb-page-foot-pad。只藏 <MobileTabBar> 不摘 class,
//   页面底部会平白空出 56px + 安全区,而那里什么都没有。见 src/mobile-immersive.ts。
const tabbarVisible = computed(() => isMobile.value && mobileTabs.value.length > 0 && !isMobileImmersive.value)
// 未读通知角标。**只有通知配角标**:它有专用的计数接口(/api/inapp-notify/count,轻),
// 而「任务收件箱」的未读数只能靠拉整个列表(apiListInbox 要透传到 getdeployed,慢且会失败)——
// 为一个角标每 30 秒打一次那条链路不值当。
// queryKey 与铃铛完全相同,vue-query 会自动共用同一份缓存与轮询,不会变成两个轮询。
const tabUnreadQuery = useQuery({
  queryKey: ['inapp-notify-count'],
  queryFn: apiGetInappNotifyCount,
  enabled: isAuthenticated,
  refetchInterval: 30_000,
})
const mobileTabBadges = computed<Record<string, number>>(() => ({
  notifications: tabUnreadQuery.data.value?.count ?? 0,
  }))

// 浏览器返回/前进接管:挂载时给当前(落地)历史条目盖上 siSection,
// 使从首个跳转「返回」时能恢复到落地页;监听 popstate 处理返回。
onMounted(() => {
  writeHash(activeSection.value, pendingAutomationId.value, true)
  window.addEventListener('popstate', onPopState)
  // 手输地址 / 点收藏夹:hashchange 不一定伴随 popstate,单独接一次
  window.addEventListener('hashchange', onHashChange)
})
onUnmounted(() => {
  window.removeEventListener('popstate', onPopState)
  window.removeEventListener('hashchange', onHashChange)
})

function onHashChange() {
  const { section, sub } = parseHash()
  pendingAutomationId.value = sub
  if (section && section !== activeSection.value && knownSections.value.has(section)) {
    activeSection.value = section as SectionKey
  }
}

</script>

<template>
  <!-- 全局中文 locale(分页/空表/日期面板);只包不缩进,保持 diff 干净 -->
  <el-config-provider :locale="zhCn">
  <AsyncState v-if="!authStartupComplete" loading />
  <LoginPage v-else-if="!isAuthenticated" />
  <div v-else class="app-shell" :class="{ 'app-shell--collapsed': railMode, 'app-shell--nav-open': mobileNavOpen, 'app-shell--tabbar': tabbarVisible, 'app-shell--immersive': isMobile && isMobileImmersive }">
    <div v-if="isMobile && mobileNavOpen" class="app-nav-overlay" @click="mobileNavOpen = false" />
    <aside class="app-sidebar" aria-label="主导航">
      <div class="app-brand">
        <img :src="logoUrl || '/logo.png'" class="app-brand__logo" alt="" />
        <span v-show="!railMode">{{ systemName }}</span>
      </div>
      <!-- ★手机菜单顶部的搜索:68 个页面、10 个分组,靠展开分组 + 滚动去找「付款凭证」是一段
           很长的路,而抽屉本来就是「找不常用页面」的地方(高频入口已经在底部 tab 上)。
           输入即跨分组扁平出结果 —— 这比把抽屉做得更大更有用。桌面侧栏常驻,不需要,故只在手机渲染。 -->
      <div v-if="isMobile" class="app-menu-search">
        <el-input v-model="menuSearch" placeholder="搜索菜单…" clearable :prefix-icon="Search" />
      </div>
      <div v-if="isMobile && menuSearch.trim()" class="app-menu-hits">
        <p v-if="menuHits.length === 0" class="app-menu-hits__empty">没有匹配的菜单</p>
        <button
          v-for="hit in menuHits"
          :key="hit.key"
          type="button"
          class="app-menu-hits__item"
          :class="{ 'is-active': hit.key === activeSection }"
          @click="menuSearch = ''; onSelect(hit.key)"
        >
          <component :is="hit.icon" v-if="hit.icon" :size="18" />
          <span class="app-menu-hits__label">{{ hit.label }}</span>
          <span class="app-menu-hits__group">{{ hit.groupLabel }}</span>
        </button>
      </div>
      <el-menu
        v-show="!isMobile || !menuSearch.trim()"
        ref="menuRef"
        :default-active="activeSection"
        :default-openeds="openedGroups"
        :collapse="!isMobile && railMode"
        :collapse-transition="false"
        unique-opened
        class="app-menu"
        @select="onSelect"
      >
        <el-sub-menu v-for="group in menuGroups" :key="group.key" :index="group.key">
          <template #title>
            <component :is="group.icon" :size="18" class="app-menu__group-icon" />
            <span class="app-menu__group">{{ group.label }}</span>
          </template>
          <template v-for="entry in group.items" :key="entry.key">
            <!-- 二级文件夹:只收纳低频页;本身不是页面,所以不可点、也没有 permission -->
            <el-sub-menu v-if="isFolderView(entry)" :index="entry.key">
              <template #title>
                <component :is="entry.icon" :size="18" />
                <span>{{ entry.label }}</span>
              </template>
              <el-menu-item v-for="item in entry.children" :key="item.key" :index="item.key">
                <component :is="item.icon" :size="18" />
                <template #title>{{ item.label }}</template>
              </el-menu-item>
            </el-sub-menu>
            <el-menu-item v-else :index="entry.key">
              <component :is="entry.icon" :size="18" />
              <template #title>
                {{ entry.label }}
              </template>
            </el-menu-item>
          </template>
        </el-sub-menu>

      </el-menu>
    </aside>

    <main class="app-main">
      <LicenseBanner />
      <header class="app-topbar">
        <div class="app-topbar__left">
          <button
            type="button"
            class="icon-button"
            :title="isMobile ? '菜单' : railMode ? '展开菜单' : '收起菜单'"
            @click="toggleNav"
          >
            <component :is="isMobile ? Menu : railMode ? PanelLeftOpen : PanelLeftClose" :size="18" />
          </button>
          <div class="app-topbar__title">
            <h1>{{ activeTitle }}</h1>
          </div>
        </div>
        <div class="app-user">
          <button type="button" class="icon-button" :title="`主题:${THEME_LABEL[theme]}(点击切换)`" aria-label="切换主题" @click="cycleTheme">
            <component :is="themeIcon" :size="18" />
          </button>
          <!-- ★手机上不摆铃铛:底部 tab 已经有「收件箱」那一格,同一个东西两个入口
               (而且顶栏那个还更小更难点)。角标语义不丢 —— tab 上的红点走 mobileTabBadges,
               与铃铛读的是同一个未读数。顺带少一条 30s 轮询:铃铛自己有一条,
               App.vue 的 tabUnreadQuery 又有一条,手机上等于同一个数字拉两遍。 -->
          <NotificationBell v-if="!isMobile" />
          <el-dropdown trigger="hover" @command="onUserCommand">
            <span class="app-user__menu" role="button" tabindex="0" title="账号菜单">
              <span class="app-user__name">{{ employee?.name }}</span>
              <ChevronDown :size="14" />
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <!-- ★v-if 不是多余的:管理员可以用功能开关关掉 `menu:my-settings`,那时这一项不在
                     knownSections 里,onSelect 过去会被 `watch(groups)` 弹回第一个可见页 ——
                     留着就是个「点了没反应」的死按钮。要么能去,要么不显示。 -->
                <el-dropdown-item v-if="knownSections.has('my-settings')" command="my-settings" :icon="UserRound">个人设置</el-dropdown-item>
                <!-- ★捷径,不是第二个功能:它落到的还是「个人设置」那一页,只是替你把二维码点开了。
                     v-if 跟着 my-settings 走 —— 那一页被功能开关关掉时,这条捷径无处可落。 -->
                <el-dropdown-item v-if="knownSections.has('my-settings')" command="qr-login" :icon="QrCode">扫码登录移动端</el-dropdown-item>
                <el-dropdown-item command="logout" divided :icon="LogOut">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <PcbCamWorkspace v-if="activeSection === 'pcb-cam'" />
      <NotificationsPage v-else-if="activeSection === 'notifications'" />
      <RolePermissions v-else-if="activeSection === 'roles'" />
      <NotifyConfig v-else-if="activeSection === 'notify-config'" />
      <AppSettings v-else-if="activeSection === 'app-settings'" />
      <AuditLog v-else-if="activeSection === 'audit'" />
      <PersonalSettings v-else-if="activeSection === 'my-settings'" />
      <OrgManagement v-else />

    </main>

    <!-- 底部 tab 栏:仅移动端;不足两个可见入口时整条不渲染(见 src/mobile-tabs.ts);
         页面进到手机聊天窗这类沉浸视图时也收起(见 src/mobile-immersive.ts) -->
    <MobileTabBar
      v-if="tabbarVisible"
      :tabs="mobileTabs"
      :icons="NAV_ICONS"
      :active="activeSection"
      :badges="mobileTabBadges"
      @select="onSelect"
    />


  </div>
  </el-config-provider>
</template>
