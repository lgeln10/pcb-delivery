// src/api/client.ts
// 前端唯一 HTTP 入口:用 Hono hc 的类型绑定后端 AppType,并在这里统一解析错误响应。
// 页面只调用本文件导出的函数,避免散落 fetch 和重复的错误处理。
import type { hc } from 'hono/client'
import type { AppType } from '../../core/http/app'
import type { HttpErrorBody } from '../../core/http/errors'
import { AUTH_EXPIRED_EVENT, EMPLOYEE_KEY, TOKEN_KEY } from '../auth'

export type EmployeeDTO = {
  id: string
  tenantId: string
  name: string
  empNo: string
  phone: string
  position: string
  email: string | null
  /** 本人上传的头像;null = 没设过 → 显示姓名首字。系统不替任何人分配头像。 */
  avatarUrl: string | null
  departmentId: string | null
  leaderId: string | null
  status: 'active' | 'left'
  roleNames: string[]
  hasLogin: boolean
  createdAt: string
}

export type DepartmentDTO = {
  id: string
  parentId: string | null
  path: string
  name: string
  sort: number
  status: 'active' | 'disabled'
  isAccountingEntity: boolean // 财务独立核算(= 一套独立的账)
  headEmployeeId: string | null // 部门负责人(该部门成员默认上级)
  createdAt: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type RpcResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL)
export const API_CLIENT_VERSION = 'direct-backend-v6'

function resolveApiBase(configured?: string): string {
  const origin = globalThis.location?.origin ?? 'http://127.0.0.1:5175'
  return configured ? new URL(configured, origin).toString().replace(/\/$/, '') : origin
}

async function read<T>(res: RpcResponse): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(EMPLOYEE_KEY)
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    }
    const error = (body as HttpErrorBody | null)?.error
    throw new ApiError(res.status, error?.code ?? 'HTTP_ERROR', error?.message ?? '请求失败', error?.fields ?? [])
  }
  return body as T
}

type QueryValue = string | number | boolean | null | undefined

/** 当前选中账套实体(财务独立核算部门 id)的本地存储键 */
export const FINANCE_ENTITY_KEY = 'standard-build.finance.entity'

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: { query?: Record<string, QueryValue>; json?: unknown } = {},
): Promise<T> {
  const url = new URL(path, API_BASE)
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = {}
  const token = localStorage.getItem('standard-build.auth.token')
  if (token) headers.Authorization = `Bearer ${token}`
  // 多组织财务:当前选中的账套实体(独立核算部门 id)。后端仅 finance 消费,其余模块忽略。
  const entity = localStorage.getItem(FINANCE_ENTITY_KEY)
  if (entity) headers['X-Accounting-Entity'] = entity
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  })
  return read<T>(res)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return '请求失败'
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  return Object.fromEntries(error.fields.map((field) => [field.path, field.message]))
}

export type AuthSessionDTO = {
  token: string
  employee: Pick<EmployeeDTO, 'id' | 'name' | 'tenantId' | 'phone'>
}

export async function apiLogin(input: { phone: string; password: string; tenantId?: string }) {
  return request<AuthSessionDTO>('POST', '/api/auth/login', {
    json: input,
  })
}

/** 公开健康检查。demo=本实例是否提供演示自动登录;push=有没有配 APNs 凭据。 */
export async function apiHealth() {
  return request<{ ok: true; push: boolean; demo?: boolean }>('GET', '/api/health')
}

/**
 * 演示自动登录。★先问 /api/health 的 demo 位再发:生产环境这个路由**根本没注册**,
 * 盲发就是每次打开都在控制台留一条 404 红字(应用层 catch 得住,浏览器网络日志 catch 不住)。
 * health 拿不到或没这个字段(旧后端)时按「不是 demo」处理 —— 宁可少登一次,也不留报错。
 */
export async function apiDemoLogin() {
  const health = await apiHealth().catch(() => null)
  if (!health?.demo) throw new Error('demo login unavailable')
  return request<AuthSessionDTO>('POST', '/api/auth/demo-login')
}

/**
 * 退出登录:让服务端**真的**作废当前这枚令牌。
 * ★在这之前「退出登录」只清了 localStorage —— 令牌服务端还活着,7 天内谁拿到都能用。
 *   scope='this_session' = 只退这台;'all_sessions' = 老令牌无 jti 只能整体退(后端会如实告知)。
 */
export async function apiLogout() {
  return request<{ ok: true; scope: 'this_session' | 'all_sessions'; reason?: string }>('POST', '/api/session/logout')
}

// ── 扫码授权手机登录(个人设置 → 移动端扫码登录)────────────────────────────────
// 方向与微信那种扫码登录**相反**:这里是已登录的电脑把身份授给一台新手机。
// 所以真正的威胁是「别人看到了你的屏幕」,主闸是③「扫到之后必须回电脑上按确认」。
// 完整威胁模型见 core/auth/qr-login.ts 的文件头。

export type QrTicketDTO = { ticket: string; expiresAt: string; rotateAfterMs: number }
export type QrScanDeviceDTO = { label: string; platform: string; ip: string | null; scannedAt: string }
export type QrTicketStatusDTO = {
  status: 'pending' | 'scanned' | 'approved' | 'rejected' | 'consumed' | 'expired'
  expiresAt?: string
  device: QrScanDeviceDTO | null
}

/** 出一张新二维码票。返回的 ticket 是**唯一一次**拿到明文的机会,只用来画码和轮询。 */
export async function apiCreateQrTicket() {
  return request<QrTicketDTO>('POST', '/api/session/qr/tickets')
}

/** 轮询这张码:等人扫 → 显示是哪台设备 → 等你确认。 */
export async function apiQrTicketStatus(ticket: string) {
  return request<QrTicketStatusDTO>('POST', '/api/session/qr/status', { json: { ticket } })
}

/** 确认 / 拒绝那台扫码的设备。★后端只认 scanned→approved,不能先批准再等人来扫。 */
export async function apiDecideQrTicket(ticket: string, approve: boolean) {
  return request<{ ok: boolean }>('POST', '/api/session/qr/decide', { json: { ticket, approve } })
}

export type LoginDeviceDTO = {
  jti: string
  label: string
  platform: string
  appVersion: string | null
  issuedAt: string
  expiresAt: string
  current: boolean
}

/** 我的登录设备(扫码授权出去的那些)。 */
export async function apiListLoginDevices() {
  return request<{ devices: LoginDeviceDTO[] }>('GET', '/api/session/devices')
}

/**
 * 下线一台设备。★这是「手机丢了」时唯一**只踢手机、不踢自己**的办法 ——
 * 「退出所有设备」会把当前这台电脑也一起作废。
 */
export async function apiRevokeLoginDevice(jti: string) {
  return request<{ ok: boolean }>('POST', `/api/session/devices/${encodeURIComponent(jti)}/revoke`)
}

export async function apiMe() {
  return request<EmployeeDTO>('GET', '/api/me')
}

// ── 功能开关(feature-toggle)──
// disabledKeys:被关闭的 group:/menu:/perm: 键;导航过滤、权限页过滤、按钮门控都读它。
export async function apiListFeatureToggles() {
  return request<{ disabledKeys: string[] }>('GET', '/api/feature-toggles')
}
export async function apiSetFeatureToggle(input: { key: string; enabled: boolean }) {
  return request<{ ok: true }>('PUT', '/api/feature-toggles', { json: input })
}

// ── 菜单排序(menu-order)──
// groups:一级菜单(导航分组)key 顺序;items:每个分组下二级菜单 key 顺序。
// 缺失的 key 前端按 nav-catalog 原序回落追加、未知 key 忽略——排序不隐藏任何菜单。
export type MenuOrderDTO = { groups: string[]; items: Record<string, string[]> }
export async function apiGetMenuOrder() {
  return request<MenuOrderDTO>('GET', '/api/menu-order')
}
export async function apiSaveMenuOrder(input: MenuOrderDTO) {
  return request<MenuOrderDTO>('PUT', '/api/menu-order', { json: input })
}

// ★功能开关·前端口径:非超管用户的权限码里,减去被关闭的 perm: 功能 → 各页面 canXxx 自动隐藏对应按钮。
//   超管 codes===null(视为拥有一切)不减,功能按钮仍显示(菜单/分组仍在 App.vue 导航层统一隐藏)。
//   toggles 拉取失败时降级为「无禁用」,不影响正常鉴权。
export async function apiMyPermissions() {
  const [perms, toggles] = await Promise.all([
    request<{ codes: string[] | null }>('GET', '/api/me/permissions'),
    apiListFeatureToggles().catch(() => ({ disabledKeys: [] as string[] })),
  ])
  if (perms.codes === null) return perms
  const disabledPerms = new Set(toggles.disabledKeys.filter((k) => k.startsWith('perm:')).map((k) => k.slice(5)))
  return { codes: perms.codes.filter((c) => !disabledPerms.has(c)) }
}

// 自助修改本人密码(须验原密码,只作用于当前登录人)
export async function apiChangeOwnPassword(input: { oldPassword: string; newPassword: string }) {
  return request<{ ok: true }>('POST', '/api/me/change-password', { json: input })
}

// 自助设置本人头像:走 multipart,单独 fetch(request() 只发 JSON)。同 apiUploadAppLogo 的写法。
// 返回的是私有文件地址(带票据,短时效)——直接塞 <img src> 能用,但**别存进 localStorage 长期复用**。
export async function apiUploadMyAvatar(file: File): Promise<{ avatarUrl: string }> {
  const url = new URL('/api/me/avatar', API_BASE)
  const form = new FormData()
  form.append('file', file)
  const headers: Record<string, string> = {}
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'POST', headers, body: form })
  return read<{ avatarUrl: string }>(res)
}
/** 移除本人头像 → 回到「没有头像」(显示姓名首字) */
export async function apiClearMyAvatar() {
  return request<{ avatarUrl: null }>('DELETE', '/api/me/avatar')
}

// ── 角色 / 权限 ──
export type DataScope = 'ALL' | 'DEPT_AND_SUB' | 'DEPT' | 'SELF' | 'CUSTOM'
export type RoleDTO = { id: string; name: string; code: string; isBuiltin: boolean; permissionCount: number; memberCount: number }
export type PermissionDefDTO = { code: string; name: string; module: string; type: 'menu' | 'action' }
export type RoleGrantDTO = { permCode: string; dataScope: DataScope }

export async function apiListRoles() {
  return request<{ items: RoleDTO[] }>('GET', '/api/org/roles')
}
export async function apiCreateRole(input: { name: string; code: string }) {
  return request<RoleDTO>('POST', '/api/org/roles', { json: input })
}
export async function apiDeleteRole(id: string) {
  return request<{ ok: true }>('DELETE', `/api/org/roles/${id}`)
}
export async function apiListPermissionCatalog() {
  return request<{ items: PermissionDefDTO[] }>('GET', '/api/org/permissions')
}
export async function apiGetRolePermissions(roleId: string) {
  return request<{ items: RoleGrantDTO[] }>('GET', `/api/org/roles/${roleId}/permissions`)
}
export async function apiGrantPermission(roleId: string, permCode: string, dataScope: DataScope) {
  return request<{ ok: true }>('POST', `/api/org/roles/${roleId}/permissions`, { json: { permCode, dataScope } })
}
export async function apiRevokePermission(roleId: string, permCode: string) {
  return request<{ ok: true }>('DELETE', `/api/org/roles/${roleId}/permissions/${encodeURIComponent(permCode)}`)
}
export async function apiGetEmployeeRoles(employeeId: string) {
  return request<{ ids: string[] }>('GET', `/api/org/employees/${employeeId}/roles`)
}
export async function apiAssignRoles(employeeId: string, roleIds: string[]) {
  return request<{ ok: true }>('POST', `/api/org/employees/${employeeId}/roles`, { json: { roleIds } })
}
export async function apiRevokeRole(employeeId: string, roleId: string) {
  return request<{ ok: true }>('DELETE', `/api/org/employees/${employeeId}/roles/${roleId}`)
}

export async function apiListDepartments() {
  return request<{ items: DepartmentDTO[] }>('GET', '/api/org/departments')
}

export async function apiCreateDepartment(input: { name: string; parentId?: string | null; sort?: number; isAccountingEntity?: boolean }) {
  return request<DepartmentDTO>('POST', '/api/org/departments', { json: input })
}

export async function apiUpdateDepartment(id: string, input: { name: string; sort?: number }) {
  return request<DepartmentDTO>('PATCH', `/api/org/departments/${id}`, { json: input })
}

export async function apiMoveDepartment(id: string, newParentId: string | null) {
  return request<{ ok: true }>('POST', `/api/org/departments/${id}/move`, { json: { newParentId } })
}

export async function apiSetDepartmentStatus(id: string, status: 'active' | 'disabled') {
  return request<{ ok: true }>('POST', `/api/org/departments/${id}/status`, { json: { status } })
}

/** 设/清部门负责人(该部门其余成员的上级会默认改指负责人)。headEmployeeId=null 清除。 */
export async function apiSetDepartmentHead(id: string, headEmployeeId: string | null) {
  return request<{ ok: true }>('POST', `/api/org/departments/${id}/head`, { json: { headEmployeeId } })
}

/** 开启/关闭部门「财务独立核算」 */
export async function apiSetDepartmentAccountingEntity(id: string, enabled: boolean) {
  return request<{ ok: true }>('POST', `/api/org/departments/${id}/accounting-entity`, { json: { enabled } })
}

/** 账套建账(幂等):部门设为独立核算后调,播标准科目 + 开当前期间 */
export async function apiBootstrapFinanceEntity() {
  return request<{ ok: true }>('POST', '/api/finance/entities/bootstrap')
}

/** 某账套实体是否已有账务数据(取消独立核算前的守卫) */
export async function apiFinanceEntityHasBooks(entityId: string) {
  return request<{ hasBooks: boolean }>('GET', `/api/finance/entities/${entityId}/has-books`)
}

export async function apiDeleteDepartment(id: string) {
  return request<{ ok: true }>('DELETE', `/api/org/departments/${id}`)
}

export async function apiListEmployees(input: { departmentId?: string; q?: string; cursor?: string; limit?: number } = {}) {
  return request<{ items: EmployeeDTO[]; nextCursor: string | null; total: number }>('GET', '/api/org/employees', { query: input })
}

export async function apiCreateEmployee(input: {
  name: string
  empNo?: string // 选填:留空由后端自动生成(No.00001 递增)
  phone: string
  position?: string
  departmentId: string
  leaderId?: string | null
  password?: string
  email?: string | null
}) {
  return request<EmployeeDTO>('POST', '/api/org/employees', { json: input })
}

// 新建/导入员工默认登录密码(明文,建员工页展示 + 可改;改后后续新建/导入都用它)。
export async function apiGetDefaultEmployeePassword() {
  return request<{ password: string }>('GET', '/api/org/default-employee-password')
}
export async function apiSetDefaultEmployeePassword(password: string) {
  return request<{ password: string }>('PUT', '/api/org/default-employee-password', { json: { password } })
}

export async function apiUpdateEmployee(
  id: string,
  patch: { name?: string; empNo?: string; phone?: string; position?: string; email?: string | null; departmentId?: string },
) {
  return request<EmployeeDTO>('PATCH', `/api/org/employees/${id}`, { json: patch })
}

/** 管理员重置员工登录密码;不传 password 则用后端默认值(changeMe@6am) */
export async function apiResetEmployeePassword(id: string, password?: string) {
  return request<{ ok: true }>('POST', `/api/org/employees/${id}/reset-password`, { json: { password } })
}

export type EmployeeImportRowDTO = {
  rowNumber: number
  empNo: string
  name: string
  phone: string
  department: string
  position: string
  email: string
  status: 'success' | 'failed'
  reason: string | null
  employeeId: string | null
}

export type EmployeeImportResultDTO = {
  total: number
  success: number
  failed: number
  rows: EmployeeImportRowDTO[]
}

export async function apiDownloadEmployeeImportTemplate() {
  const url = new URL('/api/org/employees/import-template', API_BASE)
  const headers: Record<string, string> = {}
  const token = localStorage.getItem('standard-build.auth.token')
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'GET', headers })
  if (!res.ok) await read<never>({ ok: res.ok, status: res.status, json: () => res.json() })
  return res.blob()
}

export async function apiImportEmployees(file: File) {
  const url = new URL('/api/org/employees/import', API_BASE)
  const form = new FormData()
  form.set('file', file)
  const headers: Record<string, string> = {}
  const token = localStorage.getItem('standard-build.auth.token')
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'POST', headers, body: form })
  return read<EmployeeImportResultDTO>(res)
}

export async function apiDeleteEmployee(id: string) {
  return request<{ ok: true }>('DELETE', `/api/org/employees/${id}`)
}

export async function apiMarkEmployeeLeft(id: string, subordinatesNewLeaderId?: string | null) {
  return request<{ ok: true }>('POST', `/api/org/employees/${id}/leave`, { json: { subordinatesNewLeaderId } })
}

export async function apiReinstateEmployee(id: string) {
  return request<{ ok: true }>('POST', `/api/org/employees/${id}/reinstate`)
}
export type HrGender = 'male' | 'female' | 'unknown'
export type HrEducation = 'doctor' | 'master' | 'bachelor' | 'college' | 'highschool' | 'other'
export type HrMarital = 'single' | 'married' | 'other'
export type HrContractType = 'fulltime' | 'parttime' | 'intern' | 'dispatch'
export type HrChangeType = 'hire' | 'transfer' | 'promotion' | 'demotion' | 'regularization' | 'separation'
export type HrProfileDTO = {
  id: string
  employeeId: string
  currentPositionId: string | null
  currentGradeId: string | null
  idCardNo: string | null
  gender: HrGender | null
  birthDate: string | null
  nativePlace: string | null
  residencePlace: string | null
  politicalStatus: string | null
  education: HrEducation | null
  maritalStatus: HrMarital | null
  skillCertificates: string | null
  strengths: string | null
  bankAccount: string | null
  bankName: string | null
  emergencyContact: string | null
  emergencyPhone: string | null
  hiredDate: string | null
  workStartYear: number | null
  probationMonths: number
  regularDate: string | null
  contractType: HrContractType | null
  contractStart: string | null
  contractEnd: string | null
}
export type HrRosterRow = {
  employeeId: string
  name: string
  empNo: string
  phone: string
  departmentId: string
  status: 'active' | 'left'
  currentPositionId: string | null
  currentGradeId: string | null
  contractType: HrContractType | null
  contractEnd: string | null
  hiredDate: string | null
  workStartYear: number | null
  probationMonths: number
  regularDate: string | null
}
export type EmploymentRecordDTO = {
  id: string
  employeeId: string
  changeType: HrChangeType
  departmentId: string | null
  positionId: string | null
  gradeId: string | null
  leaderId: string | null
  effectiveDate: string
  sourceDocId: string | null
  remark: string | null
  createdAt: string
}
export type HrProfilePatch = Partial<{
  idCardNo: string | null
  gender: HrGender | null
  birthDate: string | null
  nativePlace: string | null
  residencePlace: string | null
  politicalStatus: string | null
  education: HrEducation | null
  maritalStatus: HrMarital | null
  skillCertificates: string | null
  strengths: string | null
  bankAccount: string | null
  bankName: string | null
  emergencyContact: string | null
  emergencyPhone: string | null
  hiredDate: string | null
  workStartYear: number | null
  probationMonths: number
  regularDate: string | null
  contractType: HrContractType | null
  contractStart: string | null
  contractEnd: string | null
}>
export type HrRegularizationStatus = 'probation' | 'regularized' | 'unknown'
export type HrContractEndWithin = '1m' | '3m' | '6m'
export type HrRosterFilters = {
  departmentId?: string
  q?: string
  offset?: number
  limit?: number
  status?: 'active' | 'left'
  positionId?: string
  gradeId?: string
  contractEndWithin?: HrContractEndWithin
  regularizationStatus?: HrRegularizationStatus
  contractType?: HrContractType
  missingFileCategory?: HrFileCategory
}
export async function apiListRoster(input: HrRosterFilters = {}) {
  return request<{ items: HrRosterRow[]; total: number }>('GET', '/api/hr/roster', { query: input })
}
export async function apiUpsertProfile(employeeId: string, patch: HrProfilePatch) {
  return request<HrProfileDTO>('PUT', `/api/hr/employees/${employeeId}/profile`, { json: patch })
}
// ── 员工档案附件 + 身份证 OCR ──
export type HrFileCategory = 'id_card' | 'contract' | 'education' | 'certificate' | 'bank_card' | 'other'
export async function apiCreateEmploymentRecord(
  employeeId: string,
  input: {
    changeType: HrChangeType
    departmentId?: string
    positionId?: string
    gradeId?: string
    leaderId?: string
    effectiveDate: string
    remark?: string
  },
) {
  return request<EmploymentRecordDTO>('POST', `/api/hr/employees/${employeeId}/employment-records`, { json: input })
}

// ── 审计日志 ──
export type AuditLogDTO = {
  id: string
  actorEmployeeId: string | null
  actorName: string | null
  action: string
  targetType: string | null
  targetId: string | null
  summary: string | null
  detail: unknown
  source: 'http' | 'system' | 'login'
  result: 'success' | 'failed'
  ip: string | null
  createdAt: string
}
export async function apiListAudit(
  input: { actorId?: string; action?: string; result?: 'success' | 'failed'; from?: string; to?: string; cursor?: string; limit?: number } = {},
) {
  return request<{ items: AuditLogDTO[]; nextCursor: string | null; total: number }>('GET', '/api/audit', { query: input })
}

// ── 系统设置(品牌:系统名称 + 企业 logo)─────────────────────────────────────
/** timezone:IANA 时区名(如 Asia/Shanghai)。所有定时提醒的「几点发」按它算,不看服务器/浏览器时区。
 *  invoiceTitle/invoiceTaxNo:本公司开票信息(AI 预审核对发票买方抬头用),空 = 未配置不核对。 */
export type AppSettingsDTO = { systemName: string; logoUrl: string | null; timezone: string; invoiceTitle: string | null; invoiceTaxNo: string | null }
export async function apiGetAppSettings() {
  return request<AppSettingsDTO>('GET', '/api/app-settings')
}
export async function apiUpdateAppSettings(input: { systemName: string; logoUrl: string | null; timezone?: string; invoiceTitle?: string | null; invoiceTaxNo?: string | null }) {
  return request<AppSettingsDTO>('PATCH', '/api/app-settings', { json: input })
}
// logo 上传:走 multipart,单独 fetch(request() 只发 JSON)。复用 API_BASE + 登录 token。
export async function apiUploadAppLogo(file: File): Promise<{ url: string }> {
  const url = new URL('/api/app-settings/logo', API_BASE)
  const form = new FormData()
  form.append('file', file)
  const headers: Record<string, string> = {}
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'POST', headers, body: form })
  return read<{ url: string }>(res)
}

// ════════════ 平台 LLM 配置(系统设置 → AI 大模型)════════════
// LLM 是平台级基础设施:PCB CAM、图片识别、向量化共用这里生效的 provider/model/key。
export type LlmSceneConfigDTO = {
  scene: string
  label: string
  capability: 'chat' | 'vision' | 'embedding'
  provider: string | null // null = 继承主模型
  model: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  defaultModel: string | null // 占位提示:非 chat 场景的能力默认模型
  thinkingEnabled: boolean | null // 深度思考:null=继承主模型,true/false=本场景覆盖
}
export type LlmConfigDTO = {
  /** ★网关已接入时,这一页配的东西**不生效** —— 出口和模型都由「系统管理 → AI 网关」决定 */
  gatewayActive: boolean
  provider: string
  model: string
  fallbackProvider: string | null // 主模型备用(null=无)
  fallbackModel: string | null
  thinkingEnabled: boolean // 深度思考总开关(默认关;仅方舟生效)
  envKeyStatus: Record<string, boolean>
  savedKeyStatus: Record<string, boolean>
  keyStoreReady: boolean
  providers: Array<{ id: string; label: string; defaultModel: string }>
  scenes: LlmSceneConfigDTO[]
}
export async function apiGetLlmConfig() {
  return request<LlmConfigDTO>('GET', '/api/llm/config')
}
export async function apiUpdateLlmConfig(patch: {
  provider?: string
  model?: string
  fallbackProvider?: string | null
  fallbackModel?: string | null
  thinkingEnabled?: boolean
}) {
  return request<LlmConfigDTO>('PATCH', '/api/llm/config', { json: patch })
}
// 场景模型覆盖:upsert(模型 4 列传空串=清除继承主模型;thinkingEnabled 传 null=继承)/ 删除(整条清除)
export async function apiSaveLlmSceneConfig(input: {
  scene: string
  provider?: string | null
  model?: string | null
  fallbackProvider?: string | null
  fallbackModel?: string | null
  thinkingEnabled?: boolean | null
}) {
  return request<LlmConfigDTO>('PUT', '/api/llm/config/scene', { json: input })
}
export async function apiDeleteLlmSceneConfig(scene: string) {
  return request<LlmConfigDTO>('DELETE', `/api/llm/config/scene/${scene}`)
}
export async function apiSaveLlmProviderKey(provider: string, apiKey: string) {
  return request<{ ok: true }>('PUT', '/api/llm/config/provider-key', { json: { provider, apiKey } })
}
export async function apiDeleteLlmProviderKey(provider: string) {
  return request<{ ok: true }>('DELETE', `/api/llm/config/provider-key/${provider}`)
}

// ════════════ 平台文件存储配置(系统设置 → 文件存储)════════════
// 存储是平台级基础设施:所有模块的文件上传/下载走这里生效的 provider(本地磁盘 / 阿里云 OSS / 火山引擎 TOS)。
export type StorageProviderView = {
  id: 'local' | 'oss' | 'tos'
  label: string
  fields: { key: string; label: string; required: boolean; secret: boolean; placeholder: string }[]
  configured: boolean
  secretSaved: boolean
  values: { region: string; bucket: string; endpoint: string; publicBase: string; accessKeyId: string }
}
export type StorageConfigDTO = {
  activeProvider: 'local' | 'oss' | 'tos'
  keyStoreReady: boolean
  legacyEnvOss: boolean
  providers: StorageProviderView[]
}
export type StorageProviderPatch = {
  region?: string
  bucket?: string
  endpoint?: string
  publicBase?: string
  accessKeyId?: string
  accessKeySecret?: string
}
export async function apiGetStorageConfig() {
  return request<StorageConfigDTO>('GET', '/api/storage-config/config')
}
export async function apiSetActiveStorageProvider(activeProvider: 'local' | 'oss' | 'tos') {
  return request<StorageConfigDTO>('PATCH', '/api/storage-config/config', { json: { activeProvider } })
}
export async function apiSaveStorageProvider(provider: string, patch: StorageProviderPatch) {
  return request<StorageConfigDTO>('PUT', `/api/storage-config/config/provider/${provider}`, { json: patch })
}
export async function apiDeleteStorageProvider(provider: string) {
  return request<StorageConfigDTO>('DELETE', `/api/storage-config/config/provider/${provider}`)
}
export async function apiTestStorageProvider(provider: string) {
  return request<{ ok: true }>('POST', `/api/storage-config/config/provider/${provider}/test`)
}
export type StorageMigrationSummary = {
  provider: string
  filesMigrated: number
  filesSkipped: { key: string; reason: string }[]
  rowsUpdated: number
  byTable: Record<string, number>
}
// 一键把本地磁盘 /uploads 文件迁移到当前启用的云存储,并改写本租户所有数据指向(本地文件保留做备份)。
export async function apiMigrateStorageToCloud() {
  return request<StorageMigrationSummary>('POST', '/api/storage-config/migrate-to-cloud')
}
export type PublicAclRepairSummary = { provider: string; objectsFixed: number; failed: { key: string; reason: string }[] }
// 修复公开文件权限:给系统 logo / 官网图片重打 public-read(私有桶下这些必须匿名可读)。
export async function apiRepairPublicAcl() {
  return request<PublicAclRepairSummary>('POST', '/api/storage-config/repair-public-acl')
}

// ── 通知渠道配置(邮件 SMTP)──
// 保存时密码字段传此占位符 = 沿用原密码(不修改);与后端 SECRET_PLACEHOLDER 对齐。
export const NOTIFY_SECRET_PLACEHOLDER = '__SAVED__'
export type EmailConfigDTO = {
  enabled: boolean
  configured: boolean
  keyStoreReady: boolean
  host: string
  port: number
  secure: boolean
  user: string
  passSet: boolean
  fromName: string
  fromAddress: string
}
export type SaveEmailInput = {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  fromName: string
  fromAddress: string
}
export async function apiGetEmailConfig() {
  return request<EmailConfigDTO>('GET', '/api/notify/config/email')
}
export async function apiSaveEmailConfig(input: SaveEmailInput) {
  return request<EmailConfigDTO>('PATCH', '/api/notify/config/email', { json: input })
}
export async function apiTestEmail() {
  return request<{ ok: true }>('POST', '/api/notify/test/email')
}

// 飞书(群自定义机器人 webhook)渠道
export type FeishuConfigDTO = {
  enabled: boolean
  configured: boolean
  keyStoreReady: boolean
  webhookSet: boolean
  webhookHint: string
  secretSet: boolean
}
export type SaveFeishuInput = {
  enabled: boolean
  webhookUrl: string
  secret: string
}
export async function apiGetFeishuConfig() {
  return request<FeishuConfigDTO>('GET', '/api/notify/config/feishu')
}
export async function apiSaveFeishuConfig(input: SaveFeishuInput) {
  return request<FeishuConfigDTO>('PATCH', '/api/notify/config/feishu', { json: input })
}
export async function apiTestFeishu() {
  return request<{ ok: true }>('POST', '/api/notify/test/feishu')
}

// ── 企业 IM 接入(企业微信/钉钉/飞书 自建应用)────────────────────────────────
// ★与上面的「飞书群机器人 webhook」区分:这里是自建应用(给个人发消息 + 识别发送人)。
export const IM_SECRET_PLACEHOLDER = '__SAVED__'
export type ImPlatform = 'wecom' | 'dingtalk' | 'feishu'
export type ImReplyAgent = 'none' | 'sales' | 'requirement' | 'personal'

type ImBaseConfigDTO = {
  platform: ImPlatform
  enabled: boolean
  configured: boolean
  keyStoreReady: boolean
  replyAgent: ImReplyAgent
}
export type ImWecomConfigDTO = ImBaseConfigDTO & {
  platform: 'wecom'
  corpId: string
  agentId: string
  secretSet: boolean
  callbackToken: string
  callbackAesKeySet: boolean
}
export type ImDingtalkConfigDTO = ImBaseConfigDTO & {
  platform: 'dingtalk'
  appKey: string
  agentId: string
  robotCode: string
  appSecretSet: boolean
}
export type ImFeishuConfigDTO = ImBaseConfigDTO & {
  platform: 'feishu'
  appId: string
  verificationToken: string
  appSecretSet: boolean
  encryptKeySet: boolean
}
export type ImConfigDTO = ImWecomConfigDTO | ImDingtalkConfigDTO | ImFeishuConfigDTO

export type SaveImWecomInput = { enabled: boolean; replyAgent: ImReplyAgent; corpId: string; agentId: string; secret: string; callbackToken: string; callbackAesKey: string }
export type SaveImDingtalkInput = { enabled: boolean; replyAgent: ImReplyAgent; appKey: string; appSecret: string; agentId: string; robotCode: string }
export type SaveImFeishuInput = { enabled: boolean; replyAgent: ImReplyAgent; appId: string; appSecret: string; verificationToken: string; encryptKey: string }
export type SaveImInput = SaveImWecomInput | SaveImDingtalkInput | SaveImFeishuInput

export type ImBindingDTO = { id: string; platform: ImPlatform; employeeId: string; employeeName: string; externalUserId: string; boundBy: 'phone' | 'manual' }

export async function apiGetImConfig(platform: ImPlatform) {
  return request<ImConfigDTO>('GET', `/api/im-connect/config/${platform}`)
}
export async function apiSaveImConfig(platform: ImPlatform, input: SaveImInput) {
  return request<ImConfigDTO>('PATCH', `/api/im-connect/config/${platform}`, { json: input })
}
export async function apiResolveImBindings(platform: ImPlatform) {
  return request<{ resolved: number; total: number }>('POST', `/api/im-connect/resolve/${platform}`)
}
// 单员工按手机号解析绑定(组织及账号管理页「绑定IM」弹窗;已绑直接回,解析不到 bound=false 不报错)
export async function apiResolveOneImBinding(input: { platform: ImPlatform; employeeId: string }) {
  return request<{ bound: boolean; externalUserId: string | null }>('POST', '/api/im-connect/bindings/resolve-one', { json: input })
}
export async function apiListImBindings() {
  return request<{ items: ImBindingDTO[] }>('GET', '/api/im-connect/bindings')
}
export async function apiAddImBinding(input: { platform: ImPlatform; employeeId: string; externalUserId: string }) {
  return request<{ ok: true }>('POST', '/api/im-connect/bindings', { json: input })
}
export async function apiRemoveImBinding(id: string) {
  return request<{ ok: true }>('DELETE', `/api/im-connect/bindings/${id}`)
}

// ════════════ License 授权状态（本地化部署）════════════
export type LicenseStatusDTO = {
  enforced: boolean
  configured: boolean
  aiEnabled: boolean // 后端 core/license/routes.ts 一直在返回,但类型漏了 —— App.vue 拿它隐藏「企业智能体」整组
  valid: boolean
  state: 'active' | 'grace' | 'expired' | 'invalid'
  customer: string
  seats: number
  seatsUsed: number
  overSeat: boolean
  expiresAt: string | null
  daysLeft: number
  readOnly: boolean
}
export async function apiGetLicense() {
  return request<LicenseStatusDTO>('GET', '/api/license')
}
export async function apiActivateLicense(license: string, server?: string) {
  return request<{ ok: boolean } & LicenseStatusDTO>('POST', '/api/license/activate', { json: { license, server } })
}

// ════════════ 员工企业邮箱(自助配置,收发线索邮件用)════════════
export type MailAccountDTO = {
  emailAddress: string
  displayName: string | null
  imapHost: string
  imapPort: number
  imapUseTls: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  enabled: boolean
  hasAuthPassword: boolean
  lastCheckedAt: string | null
  lastError: string | null
}
export type SaveMailAccountInput = {
  emailAddress: string
  authPassword?: string // 留空=保留原授权密码
  displayName?: string | null
  imapHost?: string
  imapPort?: number
  imapUseTls?: boolean
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  enabled?: boolean
}
export async function apiGetMyMailbox() {
  return request<{ account: MailAccountDTO | null }>('GET', '/api/my-mailbox')
}
export async function apiSaveMyMailbox(input: SaveMailAccountInput) {
  return request<{ account: MailAccountDTO }>('PUT', '/api/my-mailbox', { json: input })
}
export async function apiDeleteMyMailbox() {
  return request<{ ok: true }>('DELETE', '/api/my-mailbox')
}
export async function apiTestMyMailbox() {
  return request<{ ok: true }>('POST', '/api/my-mailbox/test')
}

// ── 站内信 ────────────────────────────────────────────────────────────────────

export type InappNotificationDTO = {
  id: string
  recipientId: string
  title: string
  body: string
  sourceType: string
  sourceId: string
  isRead: boolean
  readAt: string | null
  createdAt: string
}
export async function apiGetInappNotifyCount() {
  return request<{ count: number }>('GET', '/api/inapp-notify/count')
}
export async function apiListInappNotifications(opts: { cursor?: string; limit?: number; unreadOnly?: boolean } = {}) {
  const params = new URLSearchParams()
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.limit) params.set('limit', String(opts.limit))
  // 只在要未读时带参数:后端 unreadOnly !== 'true' 一律当 false,不传即全部
  if (opts.unreadOnly) params.set('unreadOnly', 'true')
  const qs = params.toString()
  return request<{ items: InappNotificationDTO[]; nextCursor: string | null }>('GET', `/api/inapp-notify${qs ? `?${qs}` : ''}`)
}
export async function apiMarkInappNotificationRead(id: string) {
  return request<{ ok: true }>('PATCH', `/api/inapp-notify/${id}/read`)
}
export async function apiMarkAllInappNotificationsRead() {
  return request<{ updated: number }>('PATCH', '/api/inapp-notify/read-all')
}

// ── 移动推送:设备令牌登记(只在 App 壳里调用,浏览器不涉及)──
export async function apiRegisterPushDevice(input: {
  token: string
  platform: 'ios' | 'android'
  // ★与 modules/push/model.ts 的 PUSH_PROVIDERS 一一对应(7 项)。只抄两值的那一版意味着
  //   壳回传厂商通道时前端类型不合法 —— 而厂商发送器早已就绪,输入却永远进不来。
  provider?: 'apns' | 'fcm' | 'huawei' | 'honor' | 'xiaomi' | 'oppo' | 'vivo'
  appVersion?: string
}) {
  return request<{ ok: true }>('POST', '/api/push/register', { json: input })
}
export async function apiUnregisterPushDevice(token: string) {
  return request<{ ok: true }>('POST', '/api/push/unregister', { json: { token } })
}
/** 给自己发一条测试推送。三个返回值合起来定位断在哪一段(见 modules/push/api.ts 的说明)。 */
export async function apiTestPush() {
  return request<{ configured: boolean; devices: number; sent: number; unsupportedDevices: number }>('POST', '/api/push/test')
}

// ── PCB CAM 工程自动化(modules/pcb-cam)──
export type PcbCamStage = 'intake' | 'order_spec' | 'align' | 'drill' | 'inner' | 'outer' | 'mask' | 'silk' | 'net_compare' | 'panel' | 'output' | 'gatekeeper'
export type PcbCamJobStatus = 'pending' | 'running' | 'needs_review' | 'blocked' | 'done' | 'failed' | 'cancelled'
export type PcbCamStageRunStatus = 'running' | 'ok' | 'needs_review' | 'blocked' | 'failed'
export type PcbCamEqDecision = 'pending' | 'accept_fix' | 'ignore' | 'manual' | 'ask_customer'
export type PcbCamProjectDTO = {
  id: string
  name: string
  customerName: string | null
  factoryProfileId: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}
export type PcbCamStageRunSummary = {
  id: string
  stage: PcbCamStage
  attempt: number
  status: PcbCamStageRunStatus
  summary: string
  itemCount: number
  errorCount: number
  warnCount: number
  decisionCount: number
  appliedCount: number
  nativeOps: number
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
}
export type PcbCamJobDTO = {
  id: string
  projectId: string
  projectName: string
  status: PcbCamJobStatus
  currentStage: PcbCamStage | null
  reviewReason: string | null
  inputKeys: string[]
  layerMap: Record<string, unknown> | null
  layerMapConfirmedAt: string | null
  orderSpecCandidate: Record<string, unknown> | null
  orderSpec: Record<string, unknown> | null
  retryCount: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  stages: PcbCamStageRunSummary[]
  eqPending: number
  eqTotal: number
  releasedAt: string | null
}
export type PcbCamJobListItem = Omit<PcbCamJobDTO, 'stages' | 'eqTotal'> & { customerName: string | null; eqPending: number }
export type PcbCamJobStats = { mine: { jobs: number; decisions: number; oldestWaitingAt: string | null }; running: number; doneToday: number; releasedToday: number; done: number }
export type PcbCamReportItem = {
  id: string
  kind: string
  severity: 'error' | 'warn' | 'info'
  layer: string | null
  location: { x: number; y: number; bbox?: [number, number, number, number] } | null
  measured: number | string | null
  threshold: number | string | null
  message: string
  fix: { type: string; op?: string | null; params: Record<string, unknown>; auto_fixable: boolean; applied: boolean; genesis_script?: string | null } | null
  eq_question: string | null
}
export type PcbCamStageReport = {
  stage: PcbCamStage
  status: 'ok' | 'needs_review' | 'blocked' | 'failed'
  summary: string
  items: PcbCamReportItem[]
  artifacts: { kind: string; path: string; filename?: string; size?: number; content_type?: string }[]
}
export type PcbCamEqItemDTO = {
  id: string
  stage: PcbCamStage
  itemId: string
  severity: 'error' | 'warn' | 'info'
  message: string
  suggestedFix: Record<string, unknown> | null
  decision: PcbCamEqDecision
  decidedBy: string | null
  decidedAt: string | null
  note: string | null
  kind: string
  customerReply: string | null
  customerReplyAt: string | null
}
export type PcbCamEqSuggestion = { id: string; itemId: string; kind: string; suggestion: { decision: PcbCamEqDecision; by: string | null; byName: string | null; at: string | null; note: string | null; count: number; sameCustomer: boolean } | null }
export type PcbCamEqSuggestions = { items: PcbCamEqSuggestion[]; repeated: Array<{ kind: string; decision: PcbCamEqDecision; count: number }> }
export type PcbCamProgressLine = { n: number; ts: number; stage: string; event: string; message: string; call?: number; op?: string; layer?: string | null; ms?: number; added?: number; deleted?: number; modified?: number; status?: string; errors?: number; warns?: number; decisions?: number }
export type PcbCamHistoryFrame = { stage: string; layers: string[]; ops: Array<{ n: number; op: string; layer: string | null; kind: string; key: string; added: number; deleted: number; modified: number; ms?: number | null }>; panel?: boolean }
export type PcbCamHistory = { frames: PcbCamHistoryFrame[]; by_layer: Record<string, string[]> }
export type PcbCamQueryHit = { layer: string; kind: string; x: number; y: number; bbox: [number, number, number, number]; measured: number | null; symbol?: string | null; net?: string | null; op?: string; stage?: string; note?: string }
export type PcbCamAskResult = { ok: boolean; via?: 'rules' | 'llm'; answer: string; query: Record<string, unknown> | null; result: { what: 'features' | 'changes'; total: number; by_layer: Record<string, number>; by_op?: Record<string, number>; hits: PcbCamQueryHit[]; truncated: number } | null }
export type PcbCamArtifactDTO = {
  id: string
  stageRunId: string | null
  /** 出这个文件的 stage;钻孔阶段的过程钻带和输出阶段的厂规钻带 kind 都是 drill,靠它分组 */
  stage: string | null
  kind: string
  storageKey: string
  filename: string
  size: number
  contentType: string | null
  createdAt: string
  /** 带票据的私有下载地址(短时效;出站中间件签的) */
  url: string
}
export type PcbCamFactoryProfileDTO = { id: string; name: string; schemaVersion: string; isDefault: boolean; updatedAt: string; yaml?: string }

function pcbCamAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}
export async function apiPcbCamListProjects(query: { limit?: number; cursor?: string; status?: 'active' | 'archived' } = {}) {
  return request<{ items: PcbCamProjectDTO[]; nextCursor: string | null }>('GET', '/api/pcb-cam/projects', { query })
}
export async function apiPcbCamCreateProject(body: { name: string; customerName?: string | null; factoryProfileId?: string | null }) {
  return request<PcbCamProjectDTO>('POST', '/api/pcb-cam/projects', { json: body })
}
/** 上传资料包 + 附件并建 job:走 multipart,单独 fetch(request() 只发 JSON)。复用 API_BASE + 登录 token。 */
export async function apiPcbCamUploadJob(projectId: string, files: File[], idempotencyKey?: string): Promise<PcbCamJobDTO> {
  const url = new URL(`/api/pcb-cam/projects/${projectId}/jobs`, API_BASE)
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const headers = pcbCamAuthHeaders()
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const res = await fetch(url.toString(), { method: 'POST', headers, body: form })
  return read<PcbCamJobDTO>(res)
}
/** status 可传多个(逗号拼接):列表页「需要我处理」= needs_review,blocked;q = 项目名 / 客户名 / 任务 id 前缀 */
export async function apiPcbCamJobStats() {
  return request<PcbCamJobStats>('GET', '/api/pcb-cam/jobs/stats')
}
export async function apiPcbCamListJobs(query: { limit?: number; cursor?: string; projectId?: string; status?: PcbCamJobStatus | PcbCamJobStatus[]; q?: string; sort?: 'queue' | 'newest' } = {}) {
  const status = Array.isArray(query.status) ? query.status.join(',') : query.status
  return request<{ items: PcbCamJobListItem[]; nextCursor: string | null }>('GET', '/api/pcb-cam/jobs', { query: { ...query, status } })
}
export async function apiPcbCamGetJob(id: string) {
  return request<PcbCamJobDTO>('GET', `/api/pcb-cam/jobs/${id}`)
}
export async function apiPcbCamConfirmLayers(id: string, layerMap: Record<string, unknown>) {
  return request<PcbCamJobDTO>('POST', `/api/pcb-cam/jobs/${id}/layers/confirm`, { json: layerMap })
}
export async function apiPcbCamConfirmOrderSpec(id: string, orderSpec: Record<string, unknown>) {
  return request<PcbCamJobDTO>('POST', `/api/pcb-cam/jobs/${id}/order-spec/confirm`, { json: orderSpec })
}
export async function apiPcbCamStageReport(id: string, stage: PcbCamStage) {
  return request<{ run: PcbCamStageRunSummary | null; report: PcbCamStageReport | null }>('GET', `/api/pcb-cam/jobs/${id}/stages/${stage}/report`)
}
/** 层预览 SVG:<img> 带不了 Authorization 头 → 取文本后内联渲染 */
export async function apiPcbCamLayerSvg(id: string, layer: string, frame?: 'board', rev?: 'orig' | PcbCamStage, step?: 'panel'): Promise<string> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/layers/${encodeURIComponent(layer)}.svg`, API_BASE)
  if (frame) url.searchParams.set('frame', frame)
  if (rev) url.searchParams.set('rev', rev) // 原稿(客户文件),不看本地引擎的 edit 副本
  if (step) url.searchParams.set('step', step) // 工作板副本(拼板后的层)
  const res = await fetch(url.toString(), { headers: pcbCamAuthHeaders() })
  if (!res.ok) throw new Error(`层预览获取失败(${res.status})`)
  return res.text()
}
// ── 终稿对比:系统输出 vs 人工终稿(工程师改好的成品),逐层分档、标差异 ──
export type PcbCamCompareBand = { noise: number; size: number; shape: number }
export type PcbCamCompareCluster = { id: number; direction: 'missing' | 'extra' | 'changed'; pieces: number; area_mm2: number; area_missing_mm2?: number | null; area_extra_mm2?: number | null; bbox: [number, number, number, number]; size_mm: [number, number]; at: [number, number] }
export type PcbCamCompareLayer = {
  suffix: string; output: string; golden: string; type: string
  gold_area_mm2: number; ours_area_mm2: number; xor_pct: number; shape_pct: number
  bands: { missing: PcbCamCompareBand; extra: PcbCamCompareBand }
  n_clusters: number; n_missing: number; n_extra: number; n_changed: number; clusters: PcbCamCompareCluster[]; note: string | null
}
export type PcbCamCompareDrill = { output: string; golden: string; n_sizes_ours: number; n_sizes_golden: number; holes_ours: number; holes_golden: number; n_mismatch: number; rows: Array<{ dia_mm: number; kind: 'hole' | 'slot'; ours: number; golden: number; same: boolean }> }
export type PcbCamCompareDTO = {
  has_golden: boolean; has_output: boolean; golden_files: string[]
  unmatched_output: Array<{ suffix: string; output: string; type: string }>; unmatched_golden: string[]
  layers: PcbCamCompareLayer[]; drill: PcbCamCompareDrill | null
  summary: { n_layers: number; n_clusters: number; worst: string | null }
}
export type PcbCamGoldenManifestDTO = { has_golden: boolean; has_output: boolean; golden_files: string[]; layers: Array<{ suffix: string; output: string; type: string; golden: string | null }>; unmatched_output: Array<{ suffix: string; output: string; type: string }>; unmatched_golden: string[]; errors: string[] }
export async function apiPcbCamUploadGolden(id: string, files: File[]): Promise<PcbCamGoldenManifestDTO> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/golden`, API_BASE)
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const res = await fetch(url.toString(), { method: 'POST', headers: pcbCamAuthHeaders(), body: form })
  return read<PcbCamGoldenManifestDTO>(res)
}
export async function apiPcbCamCompare(id: string, force = false) {
  return request<PcbCamCompareDTO>('GET', `/api/pcb-cam/jobs/${id}/compare`, { query: force ? { force: 'true' } : {} })
}
export async function apiPcbCamCompareSvg(id: string, suffix: string): Promise<string> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/compare/${encodeURIComponent(suffix.replace(/^\./, ''))}.svg`, API_BASE)
  const res = await fetch(url.toString(), { headers: pcbCamAuthHeaders() })
  if (!res.ok) throw new Error(`对比图获取失败(${res.status})`)
  return res.text()
}
export async function apiPcbCamListEq(id: string) {
  return request<{ items: PcbCamEqItemDTO[] }>('GET', `/api/pcb-cam/jobs/${id}/eq`)
}
export async function apiPcbCamDecideEq(id: string, itemId: string, body: { decision: Exclude<PcbCamEqDecision, 'pending'>; note?: string | null }) {
  return request<{ items: PcbCamEqItemDTO[] }>('POST', `/api/pcb-cam/jobs/${id}/eq/${itemId}/decide`, { json: body })
}
export async function apiPcbCamDecideEqBatch(id: string, body: { itemIds: string[]; decision: Exclude<PcbCamEqDecision, 'pending'>; note?: string | null }) {
  return request<{ items: PcbCamEqItemDTO[]; changed: number }>('POST', `/api/pcb-cam/jobs/${id}/eq/decide-batch`, { json: body })
}
export async function apiPcbCamEqSuggestions(id: string) {
  return request<PcbCamEqSuggestions>('GET', `/api/pcb-cam/jobs/${id}/eq/suggestions`)
}
export async function apiPcbCamProgress(id: string, after = 0) {
  return request<{ lines: PcbCamProgressLine[]; running: boolean; unavailable?: boolean }>('GET', `/api/pcb-cam/jobs/${id}/progress`, { query: { after: String(after) } })
}
export async function apiPcbCamHistory(id: string) {
  return request<PcbCamHistory>('GET', `/api/pcb-cam/jobs/${id}/history`)
}
export async function apiPcbCamAsk(id: string, question: string) {
  return request<PcbCamAskResult>('POST', `/api/pcb-cam/jobs/${id}/ask`, { json: { question } })
}
/** 一键「放行并下发」:服务端打包(成果物 + 流程单 + 问单 + 决策记录),浏览器直接下载 */
export async function apiPcbCamRelease(id: string, filename: string): Promise<void> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/release`, API_BASE)
  const res = await fetch(url.toString(), { method: 'POST', headers: pcbCamAuthHeaders() })
  if (!res.ok) {
    let msg = `下发失败(${res.status})`
    try {
      const body = (await res.json()) as { error?: { message?: string; hint?: string } }
      msg = body.error?.hint ?? body.error?.message ?? msg
    } catch {
      // 非 JSON 错误体,用默认文案
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  URL.revokeObjectURL(href)
}
export function apiPcbCamEqSheetUrl(id: string): string {
  return new URL(`/api/pcb-cam/jobs/${id}/eq-sheet.html`, API_BASE).toString()
}
export async function apiPcbCamSubmitEq(id: string) {
  return request<PcbCamJobDTO>('POST', `/api/pcb-cam/jobs/${id}/eq/submit`)
}
export async function apiPcbCamRetryStage(id: string, stage: PcbCamStage) {
  return request<PcbCamJobDTO>('POST', `/api/pcb-cam/jobs/${id}/stages/${stage}/retry`)
}
export async function apiPcbCamCancelJob(id: string) {
  return request<PcbCamJobDTO>('POST', `/api/pcb-cam/jobs/${id}/cancel`)
}
export async function apiPcbCamListArtifacts(id: string) {
  return request<{ items: PcbCamArtifactDTO[] }>('GET', `/api/pcb-cam/jobs/${id}/artifacts`)
}
/**
 * 订阅一个任务的状态推送(SSE,后端 3s 轮询 DB、变了才发、15s 心跳)。返回退订函数。
 * ★不用 EventSource:它带不了 Authorization 头,而这个路由在 requireAuth 之后。
 * 调用方仍应保留轮询兜底 —— 反向代理缓冲 SSE 时这条流可能一直不吐数据。
 */
export function apiPcbCamSubscribeJob(id: string, onJob: (job: PcbCamJobDTO) => void, onClosed?: (err?: unknown) => void): () => void {
  const ac = new AbortController()
  void (async () => {
    try {
      const res = await fetch(new URL(`/api/pcb-cam/jobs/${id}/events`, API_BASE).toString(), { headers: pcbCamAuthHeaders(), signal: ac.signal })
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        // SSE 帧以空行分隔;只认 event: job 的帧,心跳(": ping")直接跳过
        let sep = buf.indexOf('\n\n')
        while (sep >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const isJob = frame.split('\n').some((ln) => ln.startsWith('event: job'))
          const data = frame
            .split('\n')
            .filter((ln) => ln.startsWith('data:'))
            .map((ln) => ln.slice(5).trim())
            .join('')
          if (isJob && data) {
            try {
              onJob(JSON.parse(data) as PcbCamJobDTO)
            } catch {
              // 半截帧/非 JSON:丢掉这一帧,轮询兜底
            }
          }
          sep = buf.indexOf('\n\n')
        }
      }
      onClosed?.()
    } catch (err) {
      if (!ac.signal.aborted) onClosed?.(err)
    }
  })()
  return () => ac.abort()
}

/** 取一个成果物的 JSON 正文(操作序列等)。url 来自 artifacts 列表,是带票据的相对地址 —— 必须按
 *  API_BASE 解析,否则直连后端部署(VITE_API_BASE_URL 指到别的域)时会打到 SPA 自己的域上。 */
export async function apiPcbCamArtifactJson<T>(url: string): Promise<T> {
  const res = await fetch(new URL(url, API_BASE).toString(), { headers: pcbCamAuthHeaders() })
  if (!res.ok) throw new Error(`成果物获取失败(${res.status})`)
  return (await res.json()) as T
}
export type PcbCamMiSheetDTO = {
  flowId: string
  boardType: string
  category: string
  sourcePage: number
  steps: string[]
  requirements: string[]
  note: string | null
  facts: { copperLayers: number | null; hasBlindBuried: boolean; blindSpans: string[]; polarity: 'positive' | 'negative'; special: string[]; surfaceFinish: string | null; viaPlugging: string | null }
  reasons: string[]
  warnings: string[]
  impedance: {
    rows: Array<{ layer: string; type: 'single' | 'differential' | 'coplanar'; targetOhm: number | null; w1Mil: number | null; w2Mil: number | null; s1Mil: number | null; t1Um: number; t1Note: string; model: string; soldermask: string }>
    soldermask: { c1Um: number; c2Um: number; c3Um: number; cer: number; note: string }
    notes: string[]
  } | null
}
export async function apiPcbCamMiSheet(id: string) {
  return request<PcbCamMiSheetDTO>('GET', `/api/pcb-cam/jobs/${id}/mi-sheet`)
}
/** 叠层结构示意 SVG(服务端生成) */
export async function apiPcbCamStackupSvg(id: string): Promise<string> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/stackup.svg`, API_BASE)
  const res = await fetch(url.toString(), { headers: pcbCamAuthHeaders() })
  if (!res.ok) throw new Error(`叠层图获取失败(${res.status})`)
  return res.text()
}
/** 流程单 HTML 下载:带 token 的 fetch → Blob → 触发浏览器保存 */
export async function apiPcbCamDownloadMiSheet(id: string, filename: string): Promise<void> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/mi-sheet`, API_BASE)
  url.searchParams.set('format', 'html')
  const res = await fetch(url.toString(), { headers: pcbCamAuthHeaders() })
  if (!res.ok) throw new Error(`流程单下载失败(${res.status})`)
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  URL.revokeObjectURL(href)
}
/** 成果物一键打包:服务端出 zip,前端拿 blob 触发保存(<a href> 带不了 Authorization) */
export async function apiPcbCamDownloadArtifactsZip(id: string, group: 'deliverables' | 'all', filename: string): Promise<void> {
  const url = new URL(`/api/pcb-cam/jobs/${id}/artifacts.zip`, API_BASE)
  url.searchParams.set('group', group)
  const res = await fetch(url.toString(), { headers: pcbCamAuthHeaders() })
  if (!res.ok) {
    let msg = `打包下载失败(${res.status})`
    try {
      const body = (await res.json()) as { error?: { message?: string; hint?: string } }
      msg = body.error?.hint ?? body.error?.message ?? msg
    } catch {
      // 非 JSON 错误体,用默认文案
    }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  URL.revokeObjectURL(href)
}
export type PcbCamProfileField = { key: string; value: unknown; default: unknown; type: string; doc: string; overridden: boolean }
export type PcbCamProfileValidation = { ok: boolean; errors: string[]; fields: PcbCamProfileField[] }
export async function apiPcbCamDefaultFactoryProfile() {
  return request<{ yaml: string; fields: PcbCamProfileField[] }>('GET', '/api/pcb-cam/factory-profiles/default')
}
export async function apiPcbCamValidateFactoryProfile(yaml: string) {
  return request<PcbCamProfileValidation>('POST', '/api/pcb-cam/factory-profiles/validate', { json: { yaml } })
}
export async function apiPcbCamListFactoryProfiles() {
  return request<{ items: PcbCamFactoryProfileDTO[] }>('GET', '/api/pcb-cam/factory-profiles')
}
export async function apiPcbCamGetFactoryProfile(id: string) {
  return request<Required<PcbCamFactoryProfileDTO>>('GET', `/api/pcb-cam/factory-profiles/${id}`)
}
export async function apiPcbCamSaveFactoryProfile(body: { id?: string; name: string; yaml: string; schemaVersion?: string; isDefault?: boolean }) {
  return body.id
    ? request<Required<PcbCamFactoryProfileDTO>>('PUT', `/api/pcb-cam/factory-profiles/${body.id}`, { json: body })
    : request<Required<PcbCamFactoryProfileDTO>>('POST', '/api/pcb-cam/factory-profiles', { json: body })
}
export async function apiPcbCamWorkerHealth() {
  return request<{ ok: boolean; detail?: string }>('GET', '/api/pcb-cam/worker/health')
}
