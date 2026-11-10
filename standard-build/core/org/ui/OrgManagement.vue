<script setup lang="ts">
// core/org/ui/OrgManagement.vue
// 组织/员工:主从布局——左部门树(选中即筛选,节点内联管理动作),右选中部门的员工列表。
// 设计见 docs/UI_SPEC.md:数据视图包 AsyncState;破坏性动作用 ConfirmButton(禁用带原因);空态带引导。
// ★移动端口径(2026-08-27 UI 盘点第四批 #9):本页是**管理员纯配置页**,明确接受桌面降级 ——
//   手机上能看、能应急改一两个开关就够,不做表格转卡片/触控优化的逐项适配。
//   判据:使用者是管理员、频次低、多在桌面办公环境操作;逐项适配的成本买不来使用量。
import { computed, reactive, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Link2, MoreHorizontal, Pencil, Plus, Search, ShieldCheck, Upload, UserPlus } from '@lucide/vue'
import AsyncState from '../../ui-kit/AsyncState.vue'
import ConfirmButton from '../../ui-kit/ConfirmButton.vue'
import FormField from '../../ui-kit/FormField.vue'
import {
  API_CLIENT_VERSION,
  apiAssignRoles,
  apiCreateDepartment,
  apiCreateEmployee,
  apiDeleteDepartment,
  apiDeleteEmployee,
  apiDownloadEmployeeImportTemplate,
  apiGetDefaultEmployeePassword,
  apiSetDefaultEmployeePassword,
  apiGetEmployeeRoles,
  apiImportEmployees,
  apiListDepartments,
  apiListEmployees,
  apiListRoles,
  apiMarkEmployeeLeft,
  apiReinstateEmployee,
  apiMoveDepartment,
  apiResetEmployeePassword,
  apiRevokeRole,
  apiSetDepartmentStatus,
  apiSetDepartmentHead,
  apiSetDepartmentAccountingEntity,
  apiBootstrapFinanceEntity,
  apiFinanceEntityHasBooks,
  apiUpdateDepartment,
  apiUpdateEmployee,
  // 岗位以人事(hr-core)为权威:org 只在前端组合调用 hr 接口,后端不跨模块依赖。
  apiListPositions,
  apiListRoster,
  apiUpsertProfile,
  apiCreateEmploymentRecord,
  // 绑定IM用户:前端组合调用 im-connect 的绑定接口(同 hr 模式,后端不跨模块依赖)
  apiMyPermissions,
  apiGetImConfig,
  apiListImBindings,
  apiAddImBinding,
  apiRemoveImBinding,
  apiResolveOneImBinding,
  apiResolveImBindings,
  type ImPlatform,
  type ImConfigDTO,
  type ImBindingDTO,
  type DepartmentDTO,
  type EmployeeDTO,
  type EmployeeImportResultDTO,
  ApiError,
  errorMessage,
  fieldErrors,
  isForbidden,
} from '../../../src/api/client'
import { useAccountingEntity } from '../../../src/composables/useAccountingEntity'

type DepartmentNode = DepartmentDTO & { children: DepartmentNode[] }

const queryClient = useQueryClient()
const selectedDepartmentId = ref('')
const deptDialogVisible = ref(false)
const employeeDialogVisible = ref(false)
const editDialogVisible = ref(false)
const importResultVisible = ref(false)
const importFileInput = ref<HTMLInputElement | null>(null)
const importResult = ref<EmployeeImportResultDTO | null>(null)
const deptErrors = ref<Record<string, string>>({})
const employeeErrors = ref<Record<string, string>>({})
const editErrors = ref<Record<string, string>>({})
const editId = ref('')

// 员工列表搜索:输入即时回显,300ms 防抖后落到 empSearchKw 触发查询(按姓名/手机号模糊)
const empSearchInput = ref('')
const empSearchKw = ref('')
let empSearchTimer: ReturnType<typeof setTimeout> | undefined
watch(empSearchInput, (v) => {
  clearTimeout(empSearchTimer)
  empSearchTimer = setTimeout(() => (empSearchKw.value = v.trim()), 300)
})

// 部门树搜索 + 编辑部门弹窗
const deptSearch = ref('')
const treeRef = ref<{ filter: (v: string) => void } | null>(null)
const deptEditDialogVisible = ref(false)
const deptEditId = ref('')
const deptEditErrors = ref<Record<string, string>>({})
const deptEditForm = reactive({ name: '', parentId: '', sort: 0, status: 'active' as 'active' | 'disabled', isAccountingEntity: false })

const deptForm = reactive({ name: '', parentId: '', sort: 0, isAccountingEntity: false })
const { setActiveEntity } = useAccountingEntity()
const deptById = computed(() => new Map(departments.value.map((d) => [d.id, d])))
// 选中的父链(除根外)是否已有独立核算节点 → 此处不允许再嵌套独立核算(与后端约束一致)
const parentChainHasEntity = computed(() => {
  let cur = deptForm.parentId ? deptById.value.get(deptForm.parentId) : undefined
  while (cur) {
    if (cur.parentId !== null && cur.isAccountingEntity) return true // 非根祖先已是实体
    cur = cur.parentId ? deptById.value.get(cur.parentId) : undefined
  }
  return false
})
// 编辑中部门:其(已落库的)父链上除根外是否已有独立核算节点 → 不允许此节点再设独立核算(与后端约束一致)
const deptEditParentChainHasEntity = computed(() => {
  const target = deptEditTarget.value
  let cur = target?.parentId ? deptById.value.get(target.parentId) : undefined
  while (cur) {
    if (cur.parentId !== null && cur.isAccountingEntity) return true // 非根祖先已是实体
    cur = cur.parentId ? deptById.value.get(cur.parentId) : undefined
  }
  return false
})
// 岗位改选 hr 岗位(positionId);岗位文本仅作展示降级,不再手填
// useDefaultPassword=true(默认开):用租户默认密码开通登录;关掉且密码留空才不开通登录。
const employeeForm = reactive({ name: '', empNo: '', phone: '', positionId: '', departmentId: '', leaderId: '', password: '', email: '', useDefaultPassword: true })
const DEFAULT_RESET_PASSWORD = 'changeMe@6am'
// 租户默认员工密码(建员工页展示+可改)。查询回来后写入 defaultPassword,建员工时若被改过则先落库再用。
const defaultPassword = ref(DEFAULT_RESET_PASSWORD)
const defaultPasswordQuery = useQuery({
  queryKey: ['org', 'default-employee-password', API_CLIENT_VERSION],
  queryFn: apiGetDefaultEmployeePassword,
})
watch(
  () => defaultPasswordQuery.data.value?.password,
  (p) => { if (p) defaultPassword.value = p },
  { immediate: true },
)
// 编辑只管身份/账号;岗位是只读展示(调岗走人事异动单),positionDisplay 仅供展示
const editForm = reactive({ name: '', empNo: '', phone: '', positionDisplay: '', email: '', departmentId: '', resetPassword: false, newPassword: DEFAULT_RESET_PASSWORD })

const departmentsQuery = useQuery({
  queryKey: ['org', 'departments', API_CLIENT_VERSION],
  queryFn: apiListDepartments,
})
// 员工列表分页:游标翻页 + total(对齐标准列表页 recipe——每页数量选择 + 上/下一页 + 铺满高度)
const empPageSize = ref(20)
const empPageIndex = ref(0)
const empPageCursors = ref<(string | undefined)[]>([undefined])
function resetEmpPage() {
  empPageCursors.value = [undefined]
  empPageIndex.value = 0
}
// 换部门 / 改搜索 / 改每页数量都回到第一页
watch([selectedDepartmentId, empSearchKw, empPageSize], resetEmpPage)

const employeesQuery = useQuery({
  queryKey: ['org', 'employees', selectedDepartmentId, empSearchKw, empPageIndex, empPageSize, API_CLIENT_VERSION],
  queryFn: () =>
    apiListEmployees({
      departmentId: selectedDepartmentId.value || undefined,
      q: empSearchKw.value || undefined,
      cursor: empPageCursors.value[empPageIndex.value],
      limit: empPageSize.value,
    }),
})

const departments = computed(() => departmentsQuery.data.value?.items ?? [])
const employees = computed(() => employeesQuery.data.value?.items ?? [])
const empTotal = computed(() => employeesQuery.data.value?.total ?? 0)
// 翻页:前进用后端 nextCursor 压栈,后退回退 index(游标栈式分页,与审计日志一致)
function onEmpPageChange(p: number) {
  if (p > empPageIndex.value + 1) {
    const nc = employeesQuery.data.value?.nextCursor
    if (!nc) return
    if (empPageIndex.value + 1 >= empPageCursors.value.length) empPageCursors.value.push(nc)
    empPageIndex.value++
  } else if (p < empPageIndex.value + 1 && empPageIndex.value > 0) {
    empPageIndex.value--
  }
}
const departmentNameById = computed(() => new Map(departments.value.map((d) => [d.id, d.name])))
const selectedDeptName = computed(() => departmentNameById.value.get(selectedDepartmentId.value) ?? '')
// 部门负责人:选中部门的 head + 名称(名称从当前页员工解析,翻页外取不到则回退 '—')
const selectedDept = computed(() => departments.value.find((d) => d.id === selectedDepartmentId.value) ?? null)
const selectedDeptHeadId = computed(() => selectedDept.value?.headEmployeeId ?? null)
const employeeNameById = computed(() => new Map(employees.value.map((e) => [e.id, e.name])))
const selectedDeptHeadName = computed(() => (selectedDeptHeadId.value ? (employeeNameById.value.get(selectedDeptHeadId.value) ?? '—') : ''))

// ── 岗位以人事(hr-core)为权威 ────────────────────────────────────────────────
// 岗位字典来自 hr;员工「当前岗位」来自花名册的 current_position_id(=最新生效任职记录)。
// 缺人事权限/数据范围外时这些查询会失败,retry:false 静默降级到 employees.position 文本。
const positionsQuery = useQuery({
  queryKey: ['hr', 'positions', API_CLIENT_VERSION],
  queryFn: apiListPositions,
  retry: false,
})
const rosterQuery = useQuery({
  queryKey: ['hr', 'roster', selectedDepartmentId, API_CLIENT_VERSION],
  queryFn: () => apiListRoster({ departmentId: selectedDepartmentId.value || undefined, limit: 50 }),
  retry: false,
})
const hrPositions = computed(() => positionsQuery.data.value?.items ?? [])
const activePositions = computed(() => hrPositions.value.filter((p) => p.status === 'active'))
const positionById = computed(() => new Map(hrPositions.value.map((p) => [p.id, p])))
const rosterPositionByEmp = computed(
  () => new Map((rosterQuery.data.value?.items ?? []).map((r) => [r.employeeId, r.currentPositionId])),
)
// 当前岗位名:优先 hr 权威(花名册当前岗位),取不到则回退员工表岗位文本
function employeePositionName(emp: EmployeeDTO): string {
  const pid = rosterPositionByEmp.value.get(emp.id)
  if (pid) return positionById.value.get(pid)?.name ?? emp.position
  return emp.position
}
const today = () => new Date().toISOString().slice(0, 10)

const deptLoading = computed(() => departmentsQuery.isLoading.value)
const deptForbidden = computed(() => isForbidden(departmentsQuery.error.value))
const deptError = computed(() =>
  departmentsQuery.error.value && !deptForbidden.value ? errorMessage(departmentsQuery.error.value) : null,
)
const empLoading = computed(() => employeesQuery.isLoading.value)
const empForbidden = computed(() => isForbidden(employeesQuery.error.value))
const empError = computed(() =>
  employeesQuery.error.value && !empForbidden.value ? errorMessage(employeesQuery.error.value) : null,
)

const departmentTree = computed<DepartmentNode[]>(() => {
  const map = new Map<string, DepartmentNode>()
  const roots: DepartmentNode[] = []
  for (const dept of departments.value) map.set(dept.id, { ...dept, children: [] })
  for (const node of map.values()) {
    const parent = node.parentId ? map.get(node.parentId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
})

const createDepartmentMutation = useMutation({
  mutationFn: apiCreateDepartment,
  onSuccess: async (dept) => {
    ElMessage.success('部门已创建')
    deptDialogVisible.value = false
    await queryClient.invalidateQueries({ queryKey: ['org'] })
    await queryClient.invalidateQueries({ queryKey: ['accounting-entities'] })
    if (dept.isAccountingEntity) await activateAndBootstrap(dept.id) // 新账套立即建账并切入
  },
  onError: (error) => {
    deptErrors.value = fieldErrors(error)
    ElMessage.error(errorMessage(error))
  },
})
// 开启/关闭部门「财务独立核算」
const setEntityMutation = useMutation({
  mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiSetDepartmentAccountingEntity(id, enabled),
  onSuccess: async (_r, vars) => {
    await queryClient.invalidateQueries({ queryKey: ['org'] })
    await queryClient.invalidateQueries({ queryKey: ['accounting-entities'] })
    if (vars.enabled) {
      ElMessage.success('已设为独立核算')
      await activateAndBootstrap(vars.id)
    } else {
      ElMessage.success('已取消独立核算')
      await queryClient.invalidateQueries()
    }
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
async function enableEntity(id: string) {
  setEntityMutation.mutate({ id, enabled: true })
}
async function disableEntity(id: string) {
  try {
    const { hasBooks } = await apiFinanceEntityHasBooks(id)
    if (hasBooks) {
      ElMessage.warning('该账套已有账务数据,不能取消独立核算')
      return
    }
  } catch (error) {
    ElMessage.error(errorMessage(error))
    return
  }
  setEntityMutation.mutate({ id, enabled: false })
}
const createEmployeeMutation = useMutation({
  // 入职 = org 建员工(身份/账号) + hr 落首条任职记录(定岗,写 current_position_id)。
  // 后端不跨模块,故在前端按序组合;hr 段失败不回滚员工(已建成),降级为提示去人事补岗位。
  mutationFn: async () => {
    const pos = employeeForm.positionId ? positionById.value.get(employeeForm.positionId) : null
    // 密码:开「使用默认密码」→ 用租户默认密码(若在页面上被改过,先落库,后续新建/导入都用它);
    // 关掉 → 填了用填的、留空则不开通登录。
    let password: string | undefined
    if (employeeForm.useDefaultPassword) {
      const pwd = defaultPassword.value.trim()
      const stored = defaultPasswordQuery.data.value?.password
      if (stored !== undefined && pwd !== stored) {
        const saved = await apiSetDefaultEmployeePassword(pwd)
        defaultPassword.value = saved.password
        await queryClient.invalidateQueries({ queryKey: ['org', 'default-employee-password'] })
      }
      password = pwd
    } else {
      password = employeeForm.password || undefined
    }
    const emp = await apiCreateEmployee({
      name: employeeForm.name.trim(),
      empNo: employeeForm.empNo.trim() || undefined, // 留空 → 后端自动生成
      phone: employeeForm.phone.trim(),
      position: pos?.name ?? '', // 文本仅作展示降级(无人事权限/范围外时回退)
      departmentId: employeeForm.departmentId,
      leaderId: employeeForm.leaderId || null,
      password,
      email: employeeForm.email || null,
    })
    let hrFailed = false
    if (employeeForm.positionId) {
      try {
        await apiUpsertProfile(emp.id, {}) // 确保 1:1 档案存在,current_* 才能同步
        await apiCreateEmploymentRecord(emp.id, {
          changeType: 'hire',
          positionId: employeeForm.positionId,
          gradeId: pos?.defaultGradeId ?? undefined, // 带出岗位默认职级
          departmentId: employeeForm.departmentId,
          effectiveDate: today(),
        })
      } catch {
        hrFailed = true
      }
    }
    // 新增员工自动绑定IM(按手机号在各已启用平台通讯录匹配);逐平台尝试,未启用的平台静默跳过,
    // 匹配不到/绑定出错则收集提醒(不阻断建员工本身)。
    const imWarnings: string[] = []
    if (emp.phone && canBindIm.value) {
      for (const p of IM_PLATFORMS) {
        try {
          const r = await apiResolveOneImBinding({ platform: p, employeeId: emp.id })
          if (!r.bound) imWarnings.push(`${IM_PLATFORM_LABEL[p]}:未匹配到账号(手机号未加入该平台通讯录)`)
        } catch (error) {
          if (error instanceof ApiError && error.code === 'NOT_CONFIGURED') continue // 该平台未启用,跳过
          imWarnings.push(`${IM_PLATFORM_LABEL[p]}:${errorMessage(error)}`)
        }
      }
    }
    return { hrFailed, imWarnings }
  },
  onSuccess: async ({ hrFailed, imWarnings }) => {
    employeeDialogVisible.value = false
    if (hrFailed) {
      ElMessage.warning('员工已创建;岗位没能保存,可稍后在员工资料里补。')
    } else {
      ElMessage.success('员工已创建')
    }
    if (imWarnings.length > 0) {
      ElMessage.warning(`IM自动绑定未完全成功——${imWarnings.join('；')}`)
    }
    await queryClient.invalidateQueries({ queryKey: ['org', 'employees'] })
    await queryClient.invalidateQueries({ queryKey: ['hr', 'roster'] })
    await refreshImBindings()
  },
  onError: (error) => {
    employeeErrors.value = fieldErrors(error)
    ElMessage.error(errorMessage(error))
  },
})
const importEmployeesMutation = useMutation({
  mutationFn: apiImportEmployees,
  onSuccess: async (result) => {
    importResult.value = result
    importResultVisible.value = true
    ElMessage.success(`导入完成:成功 ${result.success} 行,失败 ${result.failed} 行`)
    await queryClient.invalidateQueries({ queryKey: ['org', 'employees'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const markLeftMutation = useMutation({
  mutationFn: (employeeId: string) => apiMarkEmployeeLeft(employeeId),
  onSuccess: async () => {
    ElMessage.success('员工已标记离职')
    await queryClient.invalidateQueries({ queryKey: ['org', 'employees'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const reinstateMutation = useMutation({
  mutationFn: (employeeId: string) => apiReinstateEmployee(employeeId),
  onSuccess: async () => {
    ElMessage.success('员工已复职')
    await queryClient.invalidateQueries({ queryKey: ['org', 'employees'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const updateEmployeeMutation = useMutation({
  mutationFn: async () => {
    // 岗位不在此处改(调岗走人事异动单),只更新身份/账号/部门
    await apiUpdateEmployee(editId.value, {
      name: editForm.name.trim(),
      empNo: editForm.empNo.trim(),
      phone: editForm.phone.trim(),
      email: editForm.email || null,
      departmentId: editForm.departmentId,
    })
    if (editForm.resetPassword) await apiResetEmployeePassword(editId.value, editForm.newPassword.trim())
  },
  onSuccess: async () => {
    ElMessage.success(editForm.resetPassword ? '员工已更新,密码已重置' : '员工已更新')
    editDialogVisible.value = false
    await queryClient.invalidateQueries({ queryKey: ['org', 'employees'] })
  },
  onError: (error) => {
    editErrors.value = fieldErrors(error)
    ElMessage.error(errorMessage(error))
  },
})
const deleteEmployeeMutation = useMutation({
  mutationFn: (employeeId: string) => apiDeleteEmployee(employeeId),
  onSuccess: async () => {
    ElMessage.success('员工已删除')
    await queryClient.invalidateQueries({ queryKey: ['org', 'employees'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const deptStatusMutation = useMutation({
  mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) => apiSetDepartmentStatus(id, status),
  onSuccess: async () => {
    ElMessage.success('部门状态已更新')
    await queryClient.invalidateQueries({ queryKey: ['org', 'departments'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
// 设/清部门负责人:成功后同时刷新部门(head 指针)与员工(成员上级已改指)。
const setHeadMutation = useMutation({
  mutationFn: ({ deptId, headEmployeeId }: { deptId: string; headEmployeeId: string | null }) =>
    apiSetDepartmentHead(deptId, headEmployeeId),
  onSuccess: async (_r, vars) => {
    ElMessage.success(vars.headEmployeeId ? '已设为部门负责人,成员上级已更新' : '已取消部门负责人')
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['org', 'departments'] }),
      queryClient.invalidateQueries({ queryKey: ['org', 'employees'] }),
    ])
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const deleteDeptMutation = useMutation({
  mutationFn: apiDeleteDepartment,
  onSuccess: async () => {
    ElMessage.success('部门已删除')
    selectedDepartmentId.value = ''
    deptEditDialogVisible.value = false
    await queryClient.invalidateQueries({ queryKey: ['org'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})

// ── 部门树搜索:el-tree 标准过滤(匹配名称,子串不区分大小写)──────────────────
function filterNode(value: string, data: DepartmentDTO) {
  if (!value) return true
  return data.name.toLowerCase().includes(value.toLowerCase())
}
watch(deptSearch, (v) => treeRef.value?.filter(v))

// ── 编辑部门详情:名称/排序/上级 + 内联独立核算/启停/删除 ──────────────────────
// 候选上级:排除自身及其子树(防环;后端 move 也会再校验一次)
const deptEditParentOptions = computed(() => {
  if (!deptEditId.value) return departments.value
  const self = deptById.value.get(deptEditId.value)
  if (!self) return departments.value
  return departments.value.filter((d) => d.id !== self.id && !d.path.startsWith(self.path))
})
const deptEditTarget = computed(() => deptById.value.get(deptEditId.value) ?? null)
const saveDeptEditMutation = useMutation({
  mutationFn: async () => {
    const original = deptById.value.get(deptEditId.value)
    const nextParent = deptEditForm.parentId || null
    // 上级变了 → 先 move(含防环/路径级联),再更新名称/排序
    if (original && (original.parentId ?? null) !== nextParent) {
      await apiMoveDepartment(deptEditId.value, nextParent)
    }
    await apiUpdateDepartment(deptEditId.value, { name: deptEditForm.name.trim(), sort: Number(deptEditForm.sort) || 0 })
  },
  onSuccess: async () => {
    ElMessage.success('部门已更新')
    deptEditDialogVisible.value = false
    await queryClient.invalidateQueries({ queryKey: ['org'] })
    await queryClient.invalidateQueries({ queryKey: ['accounting-entities'] })
  },
  onError: (error) => {
    deptEditErrors.value = fieldErrors(error)
    ElMessage.error(errorMessage(error))
  },
})
function openDeptEditDialog(dept: DepartmentDTO) {
  deptEditErrors.value = {}
  deptEditId.value = dept.id
  Object.assign(deptEditForm, {
    name: dept.name,
    parentId: dept.parentId ?? '',
    sort: dept.sort,
    status: dept.status,
    isAccountingEntity: dept.isAccountingEntity,
  })
  deptEditDialogVisible.value = true
}
function submitDeptEdit() {
  deptEditErrors.value = {}
  if (!deptEditForm.name.trim()) deptEditErrors.value.name = '请输入部门名称'
  if (Object.keys(deptEditErrors.value).length > 0) return
  saveDeptEditMutation.mutate()
}

// ── 给员工分配角色 ──
const roleDialogVisible = ref(false)
const roleEmployee = ref<EmployeeDTO | null>(null)
const selectedRoleIds = ref<string[]>([])
const rolesListQuery = useQuery({ queryKey: ['org', 'roles', API_CLIENT_VERSION], queryFn: apiListRoles })
const empRolesQuery = useQuery({
  queryKey: ['org', 'employee-roles', computed(() => roleEmployee.value?.id ?? ''), API_CLIENT_VERSION],
  queryFn: () => apiGetEmployeeRoles(roleEmployee.value!.id),
  enabled: computed(() => Boolean(roleEmployee.value)),
})
const allRoles = computed(() => rolesListQuery.data.value?.items ?? [])
watch(
  () => empRolesQuery.data.value,
  (data) => {
    if (data) selectedRoleIds.value = [...data.ids]
  },
)
// 即选即存:多选框每次变化立即把差异(新增/移除)落库,无需「保存」按钮。
const rolesSaving = ref(false)
async function onRolesChange(newIds: string[]) {
  const emp = roleEmployee.value
  if (!emp) return
  const original = new Set(empRolesQuery.data.value?.ids ?? [])
  const next = new Set(newIds)
  const toAdd = [...next].filter((id) => !original.has(id))
  const toRemove = [...original].filter((id) => !next.has(id))
  if (toAdd.length === 0 && toRemove.length === 0) return
  rolesSaving.value = true
  try {
    if (toAdd.length > 0) await apiAssignRoles(emp.id, toAdd)
    for (const id of toRemove) await apiRevokeRole(emp.id, id)
    ElMessage.success('角色已保存')
    await empRolesQuery.refetch() // 刷新基线,供下次差异比对
    await queryClient.invalidateQueries({ queryKey: ['org'] }) // 刷新列表「角色」列
  } catch (error) {
    ElMessage.error(errorMessage(error))
    selectedRoleIds.value = [...(empRolesQuery.data.value?.ids ?? [])] // 失败回滚到服务器状态
  } finally {
    rolesSaving.value = false
  }
}
function openRoleDialog(emp: EmployeeDTO) {
  roleEmployee.value = emp
  selectedRoleIds.value = []
  roleDialogVisible.value = true
}

// ── 批量设置角色 ──
const selectedEmployees = ref<EmployeeDTO[]>([])
function onEmpSelectionChange(rows: EmployeeDTO[]) {
  selectedEmployees.value = rows
}
const batchRoleDialogVisible = ref(false)
const batchRoleIds = ref<string[]>([])
const batchMode = ref<'append' | 'replace'>('append')
const batchSubmitting = ref(false)
function openBatchRoleDialog() {
  if (selectedEmployees.value.length === 0) return
  batchRoleIds.value = []
  batchMode.value = 'append'
  batchRoleDialogVisible.value = true
}
async function submitBatchRoles() {
  if (batchRoleIds.value.length === 0) {
    ElMessage.warning('请先选择要设置的角色')
    return
  }
  batchSubmitting.value = true
  try {
    for (const emp of selectedEmployees.value) {
      if (batchMode.value === 'append') {
        await apiAssignRoles(emp.id, batchRoleIds.value)
      } else {
        const current = await apiGetEmployeeRoles(emp.id)
        const original = new Set(current.ids)
        const next = new Set(batchRoleIds.value)
        const toAdd = [...next].filter((id) => !original.has(id))
        const toRemove = [...original].filter((id) => !next.has(id))
        if (toAdd.length > 0) await apiAssignRoles(emp.id, toAdd)
        for (const id of toRemove) await apiRevokeRole(emp.id, id)
      }
    }
    ElMessage.success(`已为 ${selectedEmployees.value.length} 名员工设置角色`)
    batchRoleDialogVisible.value = false
    await queryClient.invalidateQueries({ queryKey: ['org'] })
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    batchSubmitting.value = false
  }
}

// ── 按钮级权限门控 ──────────────────────────────────────────────────────────────
// 导航入口按 org:view 放行(允许只读查看组织),页内所有写操作按钮按 org:manage 显示;
// 后端写路由全部 requirePermission('org:manage'),这里保证 view-only 用户不会看到点了必 403 的按钮。
const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canManage = computed(() => {
  const c = myPermsQuery.data.value?.codes
  return c === null || (Array.isArray(c) && c.includes('org:manage'))
})
// 绑定IM用户(复用 im-connect 的绑定接口,免去跑「系统设置 → 企业IM接入」):
// 入口按钮与弹窗仅对有 im-connect:config 权限者可见/可用(与配置页同一权限,同一操作换个入口)。
const canBindIm = computed(() => {
  const c = myPermsQuery.data.value?.codes
  return c === null || (Array.isArray(c) && c.includes('im-connect:config'))
})
const IM_PLATFORMS: ImPlatform[] = ['wecom', 'dingtalk', 'feishu']
const IM_PLATFORM_LABEL: Record<ImPlatform, string> = { wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }
const imDialogVisible = ref(false)
const imEmployee = ref<EmployeeDTO | null>(null)
const imManualDraft = reactive<Record<ImPlatform, string>>({ wecom: '', dingtalk: '', feishu: '' })

// 三平台启用状态(决定每行是「可绑定」还是「引导去配置」);仅弹窗打开时拉取
const imConfigsQuery = useQuery({
  queryKey: ['im-connect', 'configs-summary', API_CLIENT_VERSION],
  queryFn: async () => {
    const [wecom, dingtalk, feishu] = await Promise.all([
      apiGetImConfig('wecom'),
      apiGetImConfig('dingtalk'),
      apiGetImConfig('feishu'),
    ])
    return { wecom, dingtalk, feishu } as Record<ImPlatform, ImConfigDTO>
  },
  enabled: computed(() => imDialogVisible.value && canBindIm.value),
  retry: false,
})
const imConfigs = computed(() => imConfigsQuery.data.value)
// 绑定列表与配置页共用 queryKey,两边增删互相可见;员工列表「IM绑定」列也要用,不只在弹窗打开时拉取
const imBindingsQuery = useQuery({
  queryKey: ['im-connect', 'bindings'],
  queryFn: apiListImBindings,
  enabled: computed(() => canBindIm.value),
})
const imEmpBindings = computed(() => {
  const m = new Map<ImPlatform, ImBindingDTO>()
  const emp = imEmployee.value
  if (!emp) return m
  for (const b of imBindingsQuery.data.value?.items ?? []) {
    if (b.employeeId === emp.id) m.set(b.platform, b)
  }
  return m
})
// 员工列表「IM绑定」列:某员工已绑定的渠道列表(单次查询按 employeeId 分组,非 N+1)
function empImBindings(employeeId: string): ImBindingDTO[] {
  return (imBindingsQuery.data.value?.items ?? []).filter((b) => b.employeeId === employeeId)
}
// 顶部「全量绑定IM」:对每个已启用平台跑一遍按手机号批量解析(未启用平台 NOT_CONFIGURED 静默跳过)
const bulkBindImMutation = useMutation({
  mutationFn: async () => {
    let resolved = 0
    let attempted = 0
    for (const p of IM_PLATFORMS) {
      try {
        const r = await apiResolveImBindings(p)
        resolved += r.resolved
        attempted += 1
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'NOT_CONFIGURED')) throw error
      }
    }
    return { resolved, attempted }
  },
  onSuccess: async (r) => {
    await refreshImBindings()
    if (r.attempted === 0) {
      ElMessage.warning('未启用任何IM平台,请先在「系统设置 → 企业IM接入」完成配置')
    } else {
      ElMessage.success(`全量绑定完成:新增 ${r.resolved} 条绑定`)
    }
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const imDialogLoading = computed(() => imConfigsQuery.isLoading.value || imBindingsQuery.isLoading.value)
const imDialogForbidden = computed(() => isForbidden(imConfigsQuery.error.value) || isForbidden(imBindingsQuery.error.value))
const imDialogError = computed(() => {
  const e = imConfigsQuery.error.value ?? imBindingsQuery.error.value
  return e && !imDialogForbidden.value ? errorMessage(e) : null
})

/** 「更多」下拉的分发器。破坏性动作在这里二次确认(替代原来的 ConfirmButton 浮层)。 */
async function onEmpAction(cmd: string, row: EmployeeDTO) {
  const confirm = (msg: string) =>
    ElMessageBox.confirm(msg, '确认操作', { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' })
  try {
    if (cmd === 'bindIm') return openImDialog(row)
    if (cmd === 'setHead' && selectedDepartmentId.value) {
      await confirm(`确认将「${row.name}」设为「${selectedDeptName.value}」负责人?该部门其余成员的上级将改为 ta。`)
      return setHeadMutation.mutate({ deptId: selectedDepartmentId.value, headEmployeeId: row.id })
    }
    if (cmd === 'unsetHead' && selectedDepartmentId.value) {
      return setHeadMutation.mutate({ deptId: selectedDepartmentId.value, headEmployeeId: null })
    }
    if (cmd === 'markLeft') {
      await confirm('确认将该员工标记为离职?其下属会改挂到其上级。')
      return markLeftMutation.mutate(row.id)
    }
    if (cmd === 'reinstate') {
      await confirm('确认让该员工复职?恢复为在职状态;直属上级需在「编辑」里重新设置。')
      return reinstateMutation.mutate(row.id)
    }
    if (cmd === 'delete') {
      await confirm('确认删除该员工?仅限从未登录的误建记录,删除后不可恢复。有业务数据的请改用离职。')
      return deleteEmployeeMutation.mutate(row.id)
    }
  } catch {
    /* 点了取消 —— 什么都不做 */
  }
}

function openImDialog(emp: EmployeeDTO) {
  imEmployee.value = emp
  imManualDraft.wecom = ''
  imManualDraft.dingtalk = ''
  imManualDraft.feishu = ''
  imDialogVisible.value = true
}
async function refreshImBindings() {
  await queryClient.invalidateQueries({ queryKey: ['im-connect', 'bindings'] })
}
const imAutoMutation = useMutation({
  mutationFn: (platform: ImPlatform) => apiResolveOneImBinding({ platform, employeeId: imEmployee.value!.id }),
  onSuccess: async (r, platform) => {
    await refreshImBindings()
    if (r.bound) {
      ElMessage.success(`已按手机号在${IM_PLATFORM_LABEL[platform]}通讯录匹配到账号并绑定`)
    } else {
      ElMessage.warning('未匹配到:请确认该员工手机号已加入该平台企业通讯录,或在右侧手动填写外部账号 ID')
    }
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const imAddMutation = useMutation({
  mutationFn: (platform: ImPlatform) =>
    apiAddImBinding({ platform, employeeId: imEmployee.value!.id, externalUserId: imManualDraft[platform].trim() }),
  onSuccess: async (_r, platform) => {
    imManualDraft[platform] = ''
    ElMessage.success('绑定已添加')
    await refreshImBindings()
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const imRemoveMutation = useMutation({
  mutationFn: (id: string) => apiRemoveImBinding(id),
  onSuccess: async () => {
    ElMessage.success('绑定已解除')
    await refreshImBindings()
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})

function openDeptDialog(parentId = '') {
  deptErrors.value = {}
  Object.assign(deptForm, { name: '', parentId, sort: 0, isAccountingEntity: false })
  deptDialogVisible.value = true
}

// 新建/开启独立核算后:切到该账套 + 幂等建账(播标准科目 + 开当前期间),刷新切换器与财务数据
async function activateAndBootstrap(entityId: string) {
  setActiveEntity(entityId)
  try {
    await apiBootstrapFinanceEntity()
  } catch (error) {
    ElMessage.error(`账套建账失败:${errorMessage(error)}`)
  }
  await queryClient.invalidateQueries()
}
function openEmployeeDialog() {
  employeeErrors.value = {}
  Object.assign(employeeForm, {
    name: '',
    empNo: '',
    phone: '',
    positionId: '',
    departmentId: selectedDepartmentId.value || departments.value[0]?.id || '',
    leaderId: '',
    password: '',
    email: '',
    useDefaultPassword: true,
  })
  employeeDialogVisible.value = true
}

function submitDepartment() {
  deptErrors.value = {}
  if (!deptForm.name.trim()) deptErrors.value.name = '请输入部门名称'
  if (Object.keys(deptErrors.value).length > 0) return
  createDepartmentMutation.mutate({
    name: deptForm.name.trim(),
    parentId: deptForm.parentId || null,
    sort: Number(deptForm.sort) || 0,
    isAccountingEntity: deptForm.isAccountingEntity,
  })
}
function openEditDialog(emp: EmployeeDTO) {
  editErrors.value = {}
  editId.value = emp.id
  Object.assign(editForm, {
    name: emp.name,
    empNo: emp.empNo,
    phone: emp.phone,
    positionDisplay: employeePositionName(emp) || '未定岗',
    email: emp.email ?? '',
    departmentId: emp.departmentId,
    resetPassword: false,
    newPassword: DEFAULT_RESET_PASSWORD,
  })
  editDialogVisible.value = true
}
function submitEdit() {
  editErrors.value = {}
  if (!editForm.name.trim()) editErrors.value.name = '请输入姓名'
  if (!editForm.empNo.trim()) editErrors.value.empNo = '请输入工号'
  if (!editForm.phone.trim()) editErrors.value.phone = '请输入手机号'
  if (!editForm.departmentId) editErrors.value.departmentId = '请选择部门'
  if (editForm.resetPassword && editForm.newPassword.trim().length < 8) editErrors.value.newPassword = '密码至少 8 位'
  if (Object.keys(editErrors.value).length > 0) return
  updateEmployeeMutation.mutate()
}
function submitEmployee() {
  employeeErrors.value = {}
  if (!employeeForm.name.trim()) employeeErrors.value.name = '请输入姓名'
  // 工号选填:留空由后端按 No.00001 规则生成
  if (!employeeForm.phone.trim()) employeeErrors.value.phone = '请输入手机号'
  if (!employeeForm.departmentId) employeeErrors.value.departmentId = '请选择部门'
  if (employeeForm.useDefaultPassword) {
    if (defaultPassword.value.trim().length < 8) employeeErrors.value.password = '默认密码至少 8 位'
  } else if (employeeForm.password && employeeForm.password.length < 8) {
    employeeErrors.value.password = '密码至少 8 位'
  }
  if (Object.keys(employeeErrors.value).length > 0) return
  createEmployeeMutation.mutate()
}

async function downloadImportTemplate() {
  try {
    const blob = await apiDownloadEmployeeImportTemplate()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '员工导入模板.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    ElMessage.error(errorMessage(error))
  }
}

function openImportPicker() {
  importFileInput.value?.click()
}

function onImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importEmployeesMutation.mutate(file)
}

function statusType(status: EmployeeDTO['status'] | DepartmentDTO['status']) {
  return status === 'active' ? 'success' : 'info'
}
</script>

<template>
  <section class="module-surface module-surface--fill">
    <div class="module-toolbar">
      <p class="t-caption">在部门树中选择节点可筛选员工;部门的启用/停用/删除在节点上直接操作。批量导入前请先下载模板并基于模板填写:标题带 * 的列必填,工号和岗位选填,工号留空时系统按 No.00001 递增生成(新建员工同理);模板第 2 行是示例数据,可直接覆盖,不改也不会被导入;部门按「一级部门 / 二级部门 / 三级部门」多列从左到右填。</p>
      <div v-if="canManage" class="table-actions">
        <el-button :icon="Plus" @click="openDeptDialog()">新建部门</el-button>
        <el-button :icon="Download" @click="downloadImportTemplate">下载导入模板</el-button>
        <el-button :icon="Upload" :loading="importEmployeesMutation.isPending.value" @click="openImportPicker">导入 Excel</el-button>
        <el-button type="primary" :icon="UserPlus" @click="openEmployeeDialog">新建员工</el-button>
        <input
          ref="importFileInput"
          class="sr-only-file"
          type="file"
          accept=".xlsx,.xls"
          @change="onImportFileChange"
        />
      </div>
    </div>

    <div class="grid-two org-grid-fill">
      <!-- 部门树 -->
      <section class="panel">
        <div class="panel-toolbar">
          <h2 class="panel-title">部门树</h2>
          <el-button
            v-if="selectedDepartmentId"
            text
            type="primary"
            size="small"
            @click="selectedDepartmentId = ''"
          >
            查看全部
          </el-button>
        </div>
        <AsyncState
          :loading="deptLoading"
          :error="deptError"
          :forbidden="deptForbidden"
          :empty="departments.length === 0"
          empty-title="还没有部门"
          empty-hint="先建第一个部门,再往里添加员工"
        >
          <template #empty-action>
            <el-button v-if="canManage" type="primary" :icon="Plus" @click="openDeptDialog()">新建部门</el-button>
          </template>
          <el-input
            v-model="deptSearch"
            :prefix-icon="Search"
            clearable
            size="small"
            placeholder="搜索部门名称快速定位"
            class="dept-search"
          />
          <div class="dept-tree-scroll">
          <el-tree
            ref="treeRef"
            :data="departmentTree"
            node-key="id"
            default-expand-all
            highlight-current
            :expand-on-click-node="false"
            :filter-node-method="filterNode"
            :current-node-key="selectedDepartmentId"
            :props="{ label: 'name', children: 'children' }"
            @node-click="(data: DepartmentDTO) => (selectedDepartmentId = data.id)"
          >
            <template #default="{ data }">
              <span class="dept-node">
                <span class="dept-node__name">
                  {{ data.name }}
                  <el-tag v-if="data.status !== 'active'" size="small" type="info" effect="plain" round>停用</el-tag>
                  <el-tag v-if="data.isAccountingEntity" size="small" type="success" effect="plain" round>独立核算</el-tag>
                </span>
                <span v-if="canManage" class="dept-node__actions" @click.stop>
                  <button class="icon-button icon-button--sm" title="新建子部门" @click="openDeptDialog(data.id)">
                    <Plus :size="14" />
                  </button>
                  <button class="icon-button icon-button--sm" title="编辑部门" @click="openDeptEditDialog(data)">
                    <Pencil :size="14" />
                  </button>
                </span>
              </span>
            </template>
          </el-tree>
          </div>
        </AsyncState>
      </section>

      <!-- 员工列表 -->
      <section class="panel">
        <div class="panel-toolbar">
          <div class="emp-scope">
            <h2 class="panel-title">员工</h2>
            <el-tag v-if="selectedDepartmentId" type="primary" effect="light" closable @close="selectedDepartmentId = ''">
              {{ selectedDeptName }}
            </el-tag>
            <span v-else class="t-caption">全部部门</span>
            <el-tag v-if="selectedDepartmentId && selectedDeptHeadId" type="success" effect="light" round>
              负责人:{{ selectedDeptHeadName }}
            </el-tag>
          </div>
          <el-button
            v-if="canManage"
            size="small"
            :icon="ShieldCheck"
            :disabled="selectedEmployees.length === 0"
            @click="openBatchRoleDialog"
          >批量设置角色{{ selectedEmployees.length ? `(${selectedEmployees.length})` : '' }}</el-button>
          <el-button
            v-if="canBindIm"
            size="small"
            :icon="Link2"
            :loading="bulkBindImMutation.isPending.value"
            @click="bulkBindImMutation.mutate()"
          >全量绑定IM</el-button>
          <span class="muted">共 {{ empTotal }} 人</span>
        </div>
        <el-input
          v-model="empSearchInput"
          :prefix-icon="Search"
          clearable
          size="small"
          placeholder="按姓名 / 手机号快速定位"
          class="emp-search"
        />
        <div class="list-fill">
        <AsyncState
          :loading="empLoading"
          :error="empError"
          :forbidden="empForbidden"
          :empty="employees.length === 0"
          :empty-title="empSearchKw ? '没有匹配的员工' : selectedDepartmentId ? '该部门暂无在职员工' : '还没有员工'"
          :empty-hint="empSearchKw ? '换个关键词,或清空搜索' : '新建员工或更换筛选部门'"
        >
          <template #empty-action>
            <el-button v-if="canManage" type="primary" :icon="UserPlus" @click="openEmployeeDialog">新建员工</el-button>
          </template>
          <el-table :data="employees" stripe height="100%" @selection-change="onEmpSelectionChange">
            <!-- 勾选列只服务于「批量设置角色」,随之按 org:manage 门控 -->
            <el-table-column v-if="canManage" type="selection" width="42" />
            <el-table-column label="姓名" min-width="140">
              <template #default="{ row }">
                <span>{{ row.name }}</span>
                <el-tag v-if="row.id === selectedDeptHeadId" type="success" effect="dark" size="small" round class="head-badge">负责人</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="empNo" label="工号" min-width="100" />
            <el-table-column prop="phone" label="手机号" min-width="130" />
            <el-table-column label="角色" min-width="160">
              <template #default="{ row }">
                <template v-if="row.roleNames && row.roleNames.length">
                  <el-tag v-for="rn in row.roleNames" :key="rn" size="small" effect="light" round style="margin: 2px 4px 2px 0">{{ rn }}</el-tag>
                </template>
                <span v-else class="t-caption">未分配</span>
              </template>
            </el-table-column>
            <el-table-column label="部门" min-width="130">
              <template #default="{ row }">{{ departmentNameById.get(row.departmentId) ?? '-' }}</template>
            </el-table-column>
            <el-table-column v-if="canBindIm" label="IM绑定" min-width="150">
              <template #default="{ row }">
                <template v-if="empImBindings(row.id).length">
                  <el-tag v-for="b in empImBindings(row.id)" :key="b.platform" size="small" effect="light" round style="margin: 2px 4px 2px 0">
                    {{ IM_PLATFORM_LABEL[b.platform] }}
                  </el-tag>
                </template>
                <span v-else class="t-caption">未绑定</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="statusType(row.status)" effect="light" round>
                  {{ row.status === 'active' ? '在职' : '离职' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column v-if="canManage || canBindIm" label="操作" width="170" fixed="right">
              <template #default="{ row }">
                <!-- ★每行只留两个高频动作(编辑/角色),其余收进「更多」——
                     原来一行 6 个操作、340px 宽,还包括每行一个红色「离职」:
                     低频而有破坏性的动作常驻在每一行上,既费宽度又招误点。
                     下拉里的破坏性动作用 ElMessageBox.confirm 二次确认(onEmpAction),
                     语义与原 ConfirmButton 相同 —— popover 形态的 ConfirmButton
                     放不进 dropdown-item(菜单一点就收,浮层没了落点)。 -->
                <div class="table-actions">
                  <el-button v-if="canManage" text type="primary" :icon="Pencil" title="编辑" @click="openEditDialog(row)" />
                  <el-button v-if="canManage" text type="primary" :icon="ShieldCheck" @click="openRoleDialog(row)">角色</el-button>
                  <el-dropdown v-if="canManage || canBindIm" trigger="click" @command="(cmd: string) => onEmpAction(cmd, row)">
                    <el-button text type="primary" :icon="MoreHorizontal" title="更多" />
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-if="canBindIm" command="bindIm">绑定IM</el-dropdown-item>
                        <el-dropdown-item
                          v-if="canManage && selectedDepartmentId && row.status === 'active' && row.id !== selectedDeptHeadId"
                          command="setHead"
                        >设为负责人</el-dropdown-item>
                        <el-dropdown-item
                          v-else-if="canManage && selectedDepartmentId && row.id === selectedDeptHeadId"
                          command="unsetHead"
                        >取消负责人</el-dropdown-item>
                        <el-dropdown-item v-if="canManage && row.status === 'active'" command="markLeft" divided>离职</el-dropdown-item>
                        <el-dropdown-item v-else-if="canManage" command="reinstate" divided>复职</el-dropdown-item>
                        <el-dropdown-item v-if="canManage" command="delete" :disabled="row.hasLogin">
                          删除{{ row.hasLogin ? '(已开通登录,请改用离职)' : '' }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </AsyncState>
        </div>
        <div v-if="empTotal > 0" class="list-pager">
          <el-pagination
            :current-page="empPageIndex + 1"
            v-model:page-size="empPageSize"
            :page-sizes="[10, 20, 50]"
            :total="empTotal"
            layout="total, sizes, prev, pager, next"
            background
            @current-change="onEmpPageChange"
          />
        </div>
      </section>
    </div>

    <!-- 给员工分配角色 -->
    <el-dialog v-model="roleDialogVisible" :title="roleEmployee ? `分配角色:${roleEmployee.name}` : '分配角色'" width="520px" destroy-on-close>
      <AsyncState
        :loading="empRolesQuery.isLoading.value || rolesListQuery.isLoading.value"
        :error="rolesListQuery.error.value && !isForbidden(rolesListQuery.error.value) ? errorMessage(rolesListQuery.error.value) : null"
        :forbidden="isForbidden(rolesListQuery.error.value)"
        :empty="allRoles.length === 0"
        empty-title="还没有角色"
        empty-hint="先在「角色与权限」里建角色"
      >
        <FormField label="角色(可多选)">
          <el-select v-model="selectedRoleIds" multiple filterable placeholder="选择角色" style="width: 100%" :loading="rolesSaving" @change="onRolesChange">
            <el-option v-for="role in allRoles" :key="role.id" :label="role.name" :value="role.id" />
          </el-select>
        </FormField>
        <p class="t-caption">选择/取消角色即时保存;多角色取最宽数据范围,具体权限点在「角色与权限」里配置。</p>
      </AsyncState>
      <template #footer>
        <el-button @click="roleDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 批量设置角色 -->
    <el-dialog v-model="batchRoleDialogVisible" :title="`批量设置角色(已选 ${selectedEmployees.length} 人)`" width="520px" destroy-on-close>
      <FormField label="角色(可多选)">
        <el-select v-model="batchRoleIds" multiple filterable placeholder="选择角色" style="width: 100%">
          <el-option v-for="role in allRoles" :key="role.id" :label="role.name" :value="role.id" />
        </el-select>
      </FormField>
      <FormField label="方式">
        <el-radio-group v-model="batchMode">
          <el-radio value="append">追加(保留原有角色)</el-radio>
          <el-radio value="replace">覆盖(替换为所选角色)</el-radio>
        </el-radio-group>
      </FormField>
      <p class="t-caption">将对以下 {{ selectedEmployees.length }} 名员工生效:{{ selectedEmployees.map((e) => e.name).join('、') }}</p>
      <template #footer>
        <el-button @click="batchRoleDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchSubmitting" @click="submitBatchRoles">确定</el-button>
      </template>
    </el-dialog>

    <!-- 绑定IM用户:复用「企业IM接入」的绑定接口,在员工行直接完成关联,免去跑配置页 -->
    <el-dialog
      v-model="imDialogVisible"
      :title="imEmployee ? `绑定IM用户:${imEmployee.name}` : '绑定IM用户'"
      width="680px"
      destroy-on-close
    >
      <p class="t-caption">
        绑定后,审批、跟进到期等系统提醒会直接推送到该员工的 IM 个人账号。优先「按手机号自动匹配」
        (按员工手机号 <b>{{ imEmployee?.phone || '—' }}</b> 在平台通讯录查找);匹配不到再手动填写外部账号 ID。
      </p>
      <AsyncState :loading="imDialogLoading" :error="imDialogError" :forbidden="imDialogForbidden" :empty="false">
        <div class="im-bind-rows">
          <div v-for="p in IM_PLATFORMS" :key="p" class="im-bind-row">
            <span class="im-bind-row__name">{{ IM_PLATFORM_LABEL[p] }}</span>
            <template v-if="!imConfigs?.[p]?.enabled || !imConfigs?.[p]?.configured">
              <el-tag type="info" effect="plain" round>未启用</el-tag>
              <span class="t-caption">在「系统设置 → 企业IM接入」配置并启用后即可绑定</span>
            </template>
            <template v-else-if="imEmpBindings.get(p)">
              <el-tag type="success" effect="light" round>已绑定</el-tag>
              <span class="im-bind-row__ext" :title="imEmpBindings.get(p)!.externalUserId">{{ imEmpBindings.get(p)!.externalUserId }}</span>
              <el-tag size="small" effect="plain" round>{{ imEmpBindings.get(p)!.boundBy === 'phone' ? '手机号自动' : '手动' }}</el-tag>
              <ConfirmButton
                text
                label="解绑"
                confirm-text="确认解除该平台绑定?解除后该员工将不再通过此平台收到提醒(可重新匹配/绑定)。"
                :disabled="imRemoveMutation.isPending.value"
                disabled-reason="处理中…"
                @confirm="imRemoveMutation.mutate(imEmpBindings.get(p)!.id)"
              />
            </template>
            <template v-else>
              <el-button
                size="small"
                type="primary"
                plain
                :loading="imAutoMutation.isPending.value && imAutoMutation.variables.value === p"
                :disabled="!imEmployee?.phone || imAutoMutation.isPending.value"
                :title="imEmployee?.phone ? '' : '该员工没有手机号,无法自动匹配'"
                @click="imAutoMutation.mutate(p)"
              >
                按手机号自动匹配
              </el-button>
              <el-input
                v-model="imManualDraft[p]"
                size="small"
                class="im-bind-row__input"
                placeholder="外部账号 ID(企微 UserID / 钉钉 userid / 飞书 user_id)"
              />
              <el-button
                size="small"
                :loading="imAddMutation.isPending.value && imAddMutation.variables.value === p"
                :disabled="!imManualDraft[p].trim() || imAddMutation.isPending.value"
                @click="imAddMutation.mutate(p)"
              >
                绑定
              </el-button>
            </template>
          </div>
        </div>
      </AsyncState>
      <template #footer>
        <el-button @click="imDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 新建部门 -->
    <el-dialog v-model="deptDialogVisible" title="新建部门" width="520px" destroy-on-close>
      <FormField label="部门名称" required :error="deptErrors.name">
        <el-input v-model="deptForm.name" placeholder="如 工程部" autofocus @keyup.enter="submitDepartment" />
      </FormField>
      <FormField label="上级部门" :error="deptErrors.parentId">
        <el-select v-model="deptForm.parentId" clearable filterable placeholder="不选则作为根部门">
          <el-option v-for="dept in departments" :key="dept.id" :label="dept.name" :value="dept.id" />
        </el-select>
      </FormField>
      <FormField label="排序" :error="deptErrors.sort">
        <el-input-number v-model="deptForm.sort" :min="0" />
      </FormField>
      <FormField label="独立核算">
        <el-checkbox v-model="deptForm.isAccountingEntity" :disabled="parentChainHasEntity">
          作为独立组织(可在标题栏切换)
        </el-checkbox>
        <p v-if="parentChainHasEntity" class="t-caption muted" style="margin-top: 4px">
          上级部门已是独立核算,不可再嵌套
        </p>
      </FormField>
      <template #footer>
        <el-button @click="deptDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="createDepartmentMutation.isPending.value" @click="submitDepartment">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 编辑部门:名称/上级/排序 + 内联独立核算/启停/删除 -->
    <el-dialog v-model="deptEditDialogVisible" title="编辑部门" width="520px" destroy-on-close>
      <FormField label="部门名称" required :error="deptEditErrors.name">
        <el-input v-model="deptEditForm.name" autofocus @keyup.enter="submitDeptEdit" />
      </FormField>
      <FormField label="上级部门" :error="deptEditErrors.parentId">
        <el-select v-model="deptEditForm.parentId" clearable filterable placeholder="不选则作为根部门">
          <el-option v-for="dept in deptEditParentOptions" :key="dept.id" :label="dept.name" :value="dept.id" />
        </el-select>
      </FormField>
      <FormField label="排序" :error="deptEditErrors.sort">
        <el-input-number v-model="deptEditForm.sort" :min="0" />
      </FormField>

      <div v-if="deptEditTarget" class="dept-edit-ops">
        <p class="t-caption muted">其他操作</p>
        <div class="dept-edit-op-row">
          <span>独立核算</span>
          <el-button
            v-if="!deptEditTarget.isAccountingEntity"
            size="small"
            :disabled="deptEditParentChainHasEntity"
            @click="enableEntity(deptEditTarget.id)"
          >
            设为独立核算
          </el-button>
          <ConfirmButton
            v-else-if="deptEditTarget.parentId !== null"
            label="撤销独立核算"
            confirm-text="取消该部门的独立核算?"
            @confirm="disableEntity(deptEditTarget.id)"
          />
          <el-tag v-else type="success" effect="plain" round>根账套</el-tag>
        </div>
        <p
          v-if="!deptEditTarget.isAccountingEntity && deptEditParentChainHasEntity"
          class="t-caption muted"
          style="margin-top: 4px"
        >
          上级部门已是独立核算,不可再嵌套
        </p>
        <div class="dept-edit-op-row">
          <span>部门状态</span>
          <el-button
            size="small"
            @click="deptStatusMutation.mutate({ id: deptEditTarget.id, status: deptEditTarget.status === 'active' ? 'disabled' : 'active' })"
          >
            {{ deptEditTarget.status === 'active' ? '停用部门' : '启用部门' }}
          </el-button>
        </div>
        <div class="dept-edit-op-row">
          <span>删除部门</span>
          <ConfirmButton
            label="删除部门"
            confirm-text="确认删除该部门?(后端会校验子部门和在职员工)"
            @confirm="deleteDeptMutation.mutate(deptEditTarget.id)"
          />
        </div>
      </div>

      <template #footer>
        <el-button @click="deptEditDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saveDeptEditMutation.isPending.value" @click="submitDeptEdit">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 新建员工 -->
    <!-- 新建员工:两列 8 字段的复杂表单,按 UI_SPEC §5 走抽屉而不是 760px 的 dialog -->
    <el-drawer v-model="employeeDialogVisible" title="新建员工" size="var(--sb-drawer-list)" direction="rtl" destroy-on-close>
      <div v-drawer-autofocus class="form-grid">
        <FormField label="姓名" required :error="employeeErrors.name">
          <el-input v-model="employeeForm.name" autofocus />
        </FormField>
        <FormField label="工号" :error="employeeErrors.empNo">
          <el-input v-model="employeeForm.empNo" placeholder="留空由系统自动生成(No.00001 递增)" />
        </FormField>
        <FormField label="手机号" required :error="employeeErrors.phone">
          <el-input v-model="employeeForm.phone" />
        </FormField>
        <FormField label="岗位" :error="employeeErrors.positionId">
          <el-select v-model="employeeForm.positionId" clearable filterable placeholder="选择岗位" style="width: 100%">
            <el-option v-for="pos in activePositions" :key="pos.id" :label="pos.name" :value="pos.id" />
          </el-select>
          <p v-if="activePositions.length === 0" class="t-caption muted" style="margin-top: 4px">
            还没有岗位,可先留空,稍后在员工资料里补。
          </p>
        </FormField>
        <FormField label="部门" required :error="employeeErrors.departmentId">
          <el-select v-model="employeeForm.departmentId" filterable placeholder="选择部门">
            <el-option v-for="dept in departments" :key="dept.id" :label="dept.name" :value="dept.id" />
          </el-select>
        </FormField>
        <FormField label="直属上级" :error="employeeErrors.leaderId">
          <el-select v-model="employeeForm.leaderId" clearable filterable placeholder="可选">
            <el-option v-for="employee in employees" :key="employee.id" :label="employee.name" :value="employee.id" />
          </el-select>
        </FormField>
        <FormField label="邮箱" :error="employeeErrors.email">
          <el-input v-model="employeeForm.email" />
        </FormField>
        <FormField label="登录密码" :error="employeeErrors.password" class="full">
          <div class="default-pwd-row">
            <el-switch v-model="employeeForm.useDefaultPassword" active-text="使用默认密码" />
          </div>
          <template v-if="employeeForm.useDefaultPassword">
            <el-input v-model="defaultPassword" placeholder="默认登录密码" class="default-pwd-input">
              <template #prepend>默认密码</template>
            </el-input>
            <p class="t-caption muted">新员工用此密码开通登录;在这里修改后,后续新建/导入的员工都用这个密码(建议员工首次登录后自行修改)。</p>
          </template>
          <template v-else>
            <el-input v-model="employeeForm.password" type="password" show-password placeholder="不填则不开通登录" />
          </template>
        </FormField>
      </div>
      <template #footer>
        <div class="drawer-footer">
          <el-button type="primary" :loading="createEmployeeMutation.isPending.value" @click="submitEmployee">保存</el-button>
          <el-button @click="employeeDialogVisible = false">取消</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 编辑员工。
         ★这两份字段清单**故意不一样**,不是漏抄:岗位在编辑态是只读的(调岗/晋升走人事异动单),
           「直属上级」只在新建时给,密码一边是「开通登录用的默认密码」、一边是「重置密码」。
           但「故意不一样」和「不小心长歪了」在代码里长得一模一样 —— 所以哪些字段该共有、
           哪些该各有一份,由 core/org/tests/employee-form-fields-guard.test.ts 钉住。 -->
    <el-drawer v-model="editDialogVisible" title="编辑员工" size="var(--sb-drawer-list)" direction="rtl" destroy-on-close>
      <div v-drawer-autofocus class="form-grid">
        <FormField label="姓名" required :error="editErrors.name">
          <el-input v-model="editForm.name" autofocus />
        </FormField>
        <FormField label="工号" required :error="editErrors.empNo">
          <el-input v-model="editForm.empNo" />
        </FormField>
        <FormField label="手机号" required :error="editErrors.phone">
          <el-input v-model="editForm.phone" />
        </FormField>
        <FormField label="岗位">
          <el-input :model-value="editForm.positionDisplay" disabled />
          <p class="t-caption muted" style="margin-top: 4px">岗位只作展示;要改岗位,编辑员工资料即可。</p>
        </FormField>
        <FormField label="部门" required :error="editErrors.departmentId">
          <el-select v-model="editForm.departmentId" filterable placeholder="选择部门">
            <el-option v-for="dept in departments" :key="dept.id" :label="dept.name" :value="dept.id" />
          </el-select>
        </FormField>
        <FormField label="邮箱" :error="editErrors.email" class="full">
          <el-input v-model="editForm.email" />
        </FormField>
        <FormField label="重置密码" class="full">
          <el-switch v-model="editForm.resetPassword" active-text="重置该员工登录密码" />
        </FormField>
        <FormField v-if="editForm.resetPassword" label="新密码" required :error="editErrors.newPassword" class="full">
          <el-input v-model="editForm.newPassword" type="password" show-password placeholder="默认 changeMe@6am,可自定义" />
        </FormField>
      </div>
      <p v-if="editForm.resetPassword" class="t-caption">默认重置为 changeMe@6am,可改为自定义密码(至少 8 位);员工下次用新密码登录。</p>
      <template #footer>
        <div class="drawer-footer">
          <el-button type="primary" :loading="updateEmployeeMutation.isPending.value" @click="submitEdit">保存</el-button>
          <el-button @click="editDialogVisible = false">取消</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 员工导入结果 -->
    <!-- 导入结果是「一张宽表 + 一句汇总」的只读视图,不是极简确认 —— 按 UI_SPEC §5 决策表归到抽屉。
         900px 的 dialog 在 1280 屏上左右各压掉 190px,而这张表有 8 列。 -->
    <el-drawer v-model="importResultVisible" title="员工导入结果" size="var(--sb-drawer-wide)" direction="rtl" destroy-on-close>
      <div v-if="importResult" class="import-summary">
        <el-tag type="info" effect="light">共 {{ importResult.total }} 行</el-tag>
        <el-tag type="success" effect="light">成功 {{ importResult.success }} 行</el-tag>
        <el-tag type="danger" effect="light">失败 {{ importResult.failed }} 行</el-tag>
      </div>
      <el-table v-if="importResult" :data="importResult.rows" stripe max-height="460">
        <el-table-column prop="rowNumber" label="行号" width="76" />
        <el-table-column prop="name" label="姓名" min-width="100" />
        <el-table-column prop="phone" label="手机号" min-width="130" />
        <el-table-column prop="department" label="部门" min-width="120" />
        <el-table-column prop="position" label="岗位" min-width="120" />
        <el-table-column prop="email" label="邮箱" min-width="180" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'success' ? 'success' : 'danger'" effect="light">
              {{ row.status === 'success' ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="180" />
      </el-table>
      <template #footer>
        <div class="drawer-footer">
          <el-button type="primary" @click="importResultVisible = false">关闭</el-button>
        </div>
      </template>
    </el-drawer>
  </section>
</template>

<style scoped>
/* 建员工:默认密码开关与输入的间距 */
.default-pwd-row {
  margin-bottom: 8px;
}
.default-pwd-input {
  margin-bottom: 4px;
}
/* 部门负责人徽标:跟在姓名后 */
.head-badge {
  margin-left: 6px;
}
/* 铺满布局:两栏撑满可用高度,左部门树 / 右员工列表各自内部滚动,分页贴底(对齐标准列表页 recipe)*/
.org-grid-fill {
  flex: 1;
  min-height: 0;
  align-items: stretch;
}
.org-grid-fill > .panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* 加载/空/无权限态也撑满,避免半高留白 */
.org-grid-fill :deep(.sb-state) {
  flex: 1;
  min-height: 0;
}
/* 部门树:标题栏/搜索框自然高,树区域伸展并内部滚动 */
.dept-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.dept-node {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sb-space-2);
  padding-right: var(--sb-space-2);
}
.dept-node__name {
  display: inline-flex;
  align-items: center;
  gap: var(--sb-space-2);
}
.dept-node__actions {
  display: inline-flex;
  align-items: center;
  gap: var(--sb-space-1);
  opacity: 0;
  transition: opacity 0.12s ease;
}
.el-tree-node__content:hover .dept-node__actions,
.el-tree-node.is-current > .el-tree-node__content .dept-node__actions {
  opacity: 1;
}
.icon-button--sm {
  width: 24px;
  height: 24px;
  font-size: var(--sb-font-xs);
}
/* 部门树节点里的「删」与小图标按钮(24px)对齐 */
.dept-node__actions :deep(.sb-confirm__trigger) {
  height: 24px;
  padding: 0 var(--sb-space-2);
  font-size: var(--sb-font-xs);
}
.emp-scope {
  display: inline-flex;
  align-items: center;
  gap: var(--sb-space-2);
}
.sr-only-file {
  display: none;
}
.import-summary {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
  margin-bottom: var(--sb-space-3);
}
.dept-search {
  margin-bottom: var(--sb-space-3);
}
.emp-search {
  margin-bottom: var(--sb-space-3);
}
/* 绑定IM用户弹窗:每平台一行(状态标签 + 自动匹配/手动绑定/解绑)*/
.im-bind-rows {
  display: grid;
  gap: var(--sb-space-3);
}
.im-bind-row {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
  flex-wrap: wrap;
}
.im-bind-row__name {
  flex: none;
  width: 64px;
  color: var(--sb-text-secondary);
  font-size: var(--sb-font-sm);
}
.im-bind-row__ext {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--sb-font-sm);
}
.im-bind-row__input {
  flex: 1;
  min-width: 240px;
}
/* 编辑部门弹窗:内联「其他操作」区(独立核算/启停/删除)*/
.dept-edit-ops {
  margin-top: var(--sb-space-3);
  padding-top: var(--sb-space-3);
  border-top: 1px solid var(--sb-border);
  display: grid;
  gap: var(--sb-space-2);
}
.dept-edit-op-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sb-space-3);
}
.dept-edit-op-row > span {
  color: var(--sb-text-secondary);
  font-size: var(--sb-font-sm);
}
</style>
