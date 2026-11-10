<script setup lang="ts">
// core/org/ui/RolePermissions.vue
// 角色与权限:角色列表 → 权限矩阵抽屉(按模块分组,每个权限点可勾选 + 选数据范围)。
// 功能权限(能不能做)与数据权限(能看到谁的)正交:数据范围挂在 action 类权限上(见 data-scope.ts)。
import { computed, reactive, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Plus, ShieldCheck, Trash2 } from '@lucide/vue'
import AsyncState from '../../ui-kit/AsyncState.vue'
import ConfirmButton from '../../ui-kit/ConfirmButton.vue'
import FormField from '../../ui-kit/FormField.vue'
import {
  API_CLIENT_VERSION,
  apiCreateRole,
  apiDeleteRole,
  apiGetRolePermissions,
  apiGrantPermission,
  apiListFeatureToggles,
  apiListPermissionCatalog,
  apiListRoles,
  apiRevokePermission,
  type DataScope,
  type PermissionDefDTO,
  type RoleDTO,
  errorMessage,
  fieldErrors,
  isForbidden,
} from '../../../src/api/client'
import { NAV_CATALOG, flattenNavItems } from '../../../src/nav-catalog'

type GrantState = { granted: boolean; dataScope: DataScope }

// 模块 → 中文名:覆盖全部权限模块,缺名时面板会回退显示原始模块码。
// ★护栏 core/org/tests/permission-grouping.test.ts 保证这份表覆盖 ALL_PERMISSION_DEFS 里的每个模块 ——
//   漏一个的后果不是报错,是权限抽屉里冒出一个写着 `lead-intake-email` 的英文面板,
//   配权限的人根本不知道那是什么(2026-08-08 巡检时有 10 个模块处于这个状态)。
const MODULE_LABEL: Record<string, string> = {
  'pcb-cam': 'PCB CAM',
  org: '组织及账号管理 / 角色',
  notify: '通知配置',
  'app-settings': '系统设置',
  audit: '审计日志',
}
/**
 * 模块 → 菜单组,**由 `src/nav-catalog.ts` 派生**,不再手抄一份。
 *
 * ★为什么改成派生:手抄那份从 2026-07-30 导航改版起就没跟上 —— 组名还叫「超级个体」
 *   (导航里早已是「企业智能体」),而 aiagent / askai / digitalemployee / knowledge /
 *   website / visit-stats / seal-ledger / payment-voucher / im-connect / company-lookup
 *   十个模块一个都不在,全部掉进兜底的「其他」。配权限的人在「其他」里看到十个英文码,
 *   等于这一页对新功能失去了组织能力。导航是唯一说得清「这个功能在哪个组」的地方,直接读它。
 * ★一个模块出现在多个菜单里时取**第一次**出现的组(如 partner 同时挂在 业务→供应商管理
 *   与 销售CRM→客户管理,归「业务」)—— 权限点是按模块发的,只能落一个组。
 */
const NAV_MODULE_GROUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const g of NAV_CATALOG) {
    for (const item of flattenNavItems(g.items)) {
      if (item.module && !m.has(item.module)) m.set(item.module, g.label)
    }
  }
  return m
})()
/**
 * 没有自己菜单页、但有权限点的模块,手工指一个组。
 * 这四个都是「挂在别人页面里的能力」,导航里查不到,只能在这里声明。
 * 护栏会保证「既不在导航里、也不在这份表里」的模块被判红,而不是默默掉进「其他」。
 */
const EXTRA_MODULE_GROUP: Record<string, string> = {}
const MENU_GROUPS: Array<{ label: string; modules: string[] }> = (() => {
  const byLabel = new Map<string, string[]>()
  // 组顺序跟着导航走 —— 权限抽屉与左侧导航同序,配权限时不用重新找位置
  for (const g of NAV_CATALOG) byLabel.set(g.label, [])
  const push = (label: string, mod: string) => {
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label)!.push(mod)
  }
  for (const [mod, label] of NAV_MODULE_GROUP) push(label, mod)
  for (const [mod, label] of Object.entries(EXTRA_MODULE_GROUP)) {
    if (!NAV_MODULE_GROUP.has(mod)) push(label, mod)
  }
  return [...byLabel].filter(([, mods]) => mods.length > 0).map(([label, modules]) => ({ label, modules }))
})()
const SCOPE_OPTIONS: Array<{ value: DataScope; label: string }> = [
  { value: 'ALL', label: '全部数据' },
  { value: 'DEPT_AND_SUB', label: '本部门及下级' },
  { value: 'DEPT', label: '本部门' },
  { value: 'SELF', label: '仅本人' },
]

const queryClient = useQueryClient()
const createOpen = ref(false)
const matrixOpen = ref(false)
const activeRole = ref<RoleDTO | null>(null)
const roleErrors = ref<Record<string, string>>({})
const roleForm = reactive({ name: '', code: '' })
const grants = ref<Record<string, GrantState>>({})

const rolesQuery = useQuery({ queryKey: ['org', 'roles', API_CLIENT_VERSION], queryFn: apiListRoles })
const catalogQuery = useQuery({ queryKey: ['org', 'permission-catalog', API_CLIENT_VERSION], queryFn: apiListPermissionCatalog })
const rolePermsQuery = useQuery({
  queryKey: ['org', 'role-perms', computed(() => activeRole.value?.id ?? ''), API_CLIENT_VERSION],
  queryFn: () => apiGetRolePermissions(activeRole.value!.id),
  enabled: computed(() => Boolean(activeRole.value)),
})

// 功能开关:关闭的功能(perm:)从权限配置目录里剔除 → 关闭的功能不可授权、不可见。
const featureTogglesQuery = useQuery({ queryKey: ['feature-toggles', API_CLIENT_VERSION], queryFn: apiListFeatureToggles })
const disabledPerms = computed(
  () => new Set((featureTogglesQuery.data.value?.disabledKeys ?? []).filter((k) => k.startsWith('perm:')).map((k) => k.slice(5))),
)

const roles = computed(() => rolesQuery.data.value?.items ?? [])
const catalog = computed(() => (catalogQuery.data.value?.items ?? []).filter((p) => !disabledPerms.value.has(p.code)))
const grouped = computed(() => {
  const map = new Map<string, PermissionDefDTO[]>()
  for (const p of catalog.value) {
    if (!map.has(p.module)) map.set(p.module, [])
    map.get(p.module)!.push(p)
  }
  // 模块内排序:菜单(可见性)在前,操作按钮在后,各自按 code 稳定排列——对齐菜单的认知顺序
  for (const perms of map.values()) {
    perms.sort((a, b) => (a.type === b.type ? a.code.localeCompare(b.code) : a.type === 'menu' ? -1 : 1))
  }
  return [...map.entries()].map(([module, perms]) => ({ module, label: MODULE_LABEL[module] ?? module, perms }))
})
type ModuleGroup = { module: string; label: string; perms: PermissionDefDTO[] }
// 把按模块的面板再聚成菜单组,供「全选本组」用;未归类模块兜底进「其他」
const menuGrouped = computed(() => {
  const byModule = new Map(grouped.value.map((g) => [g.module, g]))
  const used = new Set<string>()
  const out: Array<{ label: string; modules: ModuleGroup[] }> = []
  for (const mg of MENU_GROUPS) {
    const mods = mg.modules.map((m) => byModule.get(m)).filter((g): g is ModuleGroup => Boolean(g))
    for (const g of mods) used.add(g.module)
    if (mods.length > 0) out.push({ label: mg.label, modules: mods })
  }
  const rest = grouped.value.filter((g) => !used.has(g.module))
  if (rest.length > 0) out.push({ label: '其他', modules: rest })
  return out
})
const groupPerms = (modules: ModuleGroup[]): PermissionDefDTO[] => modules.flatMap((m) => m.perms)

const listForbidden = computed(() => isForbidden(rolesQuery.error.value) || isForbidden(catalogQuery.error.value))
const listError = computed(() => {
  const e = rolesQuery.error.value ?? catalogQuery.error.value
  return e && !isForbidden(e) ? errorMessage(e) : null
})

// 进入矩阵:用目录铺底(全 false),再叠加该角色已有授权
watch([() => rolePermsQuery.data.value, catalog], () => {
  if (!activeRole.value) return
  const base: Record<string, GrantState> = {}
  for (const p of catalog.value) base[p.code] = { granted: false, dataScope: p.type === 'menu' ? 'ALL' : 'SELF' }
  for (const g of rolePermsQuery.data.value?.items ?? []) {
    base[g.permCode] = { granted: true, dataScope: g.dataScope }
  }
  grants.value = base
})

const createRoleMutation = useMutation({
  mutationFn: apiCreateRole,
  onSuccess: async () => {
    ElMessage.success('角色已创建')
    createOpen.value = false
    await queryClient.invalidateQueries({ queryKey: ['org', 'roles'] })
  },
  onError: (error) => {
    roleErrors.value = fieldErrors(error)
    ElMessage.error(errorMessage(error))
  },
})
const deleteRoleMutation = useMutation({
  mutationFn: apiDeleteRole,
  onSuccess: async () => {
    ElMessage.success('角色已删除')
    await queryClient.invalidateQueries({ queryKey: ['org', 'roles'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})
const saveGrantsMutation = useMutation({
  mutationFn: async () => {
    const role = activeRole.value!
    const original = new Map((rolePermsQuery.data.value?.items ?? []).map((g) => [g.permCode, g.dataScope]))
    for (const [code, state] of Object.entries(grants.value)) {
      const had = original.has(code)
      if (state.granted && (!had || original.get(code) !== state.dataScope)) {
        await apiGrantPermission(role.id, code, state.dataScope)
      } else if (!state.granted && had) {
        await apiRevokePermission(role.id, code)
      }
    }
  },
  onSuccess: async () => {
    ElMessage.success('权限已保存')
    matrixOpen.value = false
    await queryClient.invalidateQueries({ queryKey: ['org'] })
  },
  onError: (error) => ElMessage.error(errorMessage(error)),
})

function openCreate() {
  roleErrors.value = {}
  roleForm.name = ''
  roleForm.code = ''
  createOpen.value = true
}
function submitRole() {
  roleErrors.value = {}
  if (!roleForm.name.trim()) roleErrors.value.name = '请输入角色名称'
  if (!/^[a-z][a-z0-9_]*$/.test(roleForm.code)) roleErrors.value.code = '编码为小写字母/数字/下划线,字母开头'
  if (Object.keys(roleErrors.value).length > 0) return
  createRoleMutation.mutate({ name: roleForm.name.trim(), code: roleForm.code.trim() })
}
function openMatrix(role: RoleDTO) {
  activeRole.value = role
  matrixOpen.value = true
}
const grantedCount = computed(() => Object.values(grants.value).filter((g) => g.granted).length)

// ── 批量操作 ──────────────────────────────────────────────────────────────
// 模块级:整模块勾选/取消、整模块统一数据范围(action 类权限)
function modAllGranted(perms: PermissionDefDTO[]): boolean {
  return perms.length > 0 && perms.every((p) => grants.value[p.code]?.granted)
}
function modSomeGranted(perms: PermissionDefDTO[]): boolean {
  return perms.some((p) => grants.value[p.code]?.granted)
}
function toggleModule(perms: PermissionDefDTO[], checked: boolean) {
  for (const p of perms) {
    const g = grants.value[p.code]
    if (g) g.granted = checked
  }
}
function hasActions(perms: PermissionDefDTO[]): boolean {
  return perms.some((p) => p.type === 'action')
}
function setModuleScope(perms: PermissionDefDTO[], scope: DataScope) {
  for (const p of perms) {
    const g = grants.value[p.code]
    if (p.type === 'action' && g) g.dataScope = scope
  }
}
// 模块内 action 权限的数据范围是否一致:一致返回该值,否则 ''(下拉显示占位)
function moduleScope(perms: PermissionDefDTO[]): DataScope | '' {
  const actions = perms.filter((p) => p.type === 'action')
  const [firstAction] = actions
  if (!firstAction) return ''
  const first = grants.value[firstAction.code]?.dataScope
  return actions.every((p) => grants.value[p.code]?.dataScope === first) ? (first ?? '') : ''
}

// 全局:一键全选/清空、把所有 action 权限的数据范围统一设为某值
const allGranted = computed(() => catalog.value.length > 0 && catalog.value.every((p) => grants.value[p.code]?.granted))
const someGranted = computed(() => catalog.value.some((p) => grants.value[p.code]?.granted))
function toggleAll(checked: boolean) {
  for (const g of Object.values(grants.value)) g.granted = checked
}
function setAllScope(scope: DataScope) {
  for (const p of catalog.value) {
    const g = grants.value[p.code]
    if (p.type === 'action' && g) g.dataScope = scope
  }
}

// 模板里要写 `grants[perm.code].granted`,而 grants 是 Record —— 在 noUncheckedIndexedAccess 下
// 每次索引都是「可能 undefined」。这里把权限和它的授权行配好再交给模板,模板就不必再索引一次。
// (运行时本来就一定有:grants 是拿同一份 catalog 铺底建的。这么写是让类型也能看出来。)
function permRows(perms: PermissionDefDTO[]): { perm: PermissionDefDTO; grant: GrantState }[] {
  return perms.flatMap((perm) => {
    const grant = grants.value[perm.code]
    return grant ? [{ perm, grant }] : []
  })
}
</script>

<template>
  <section class="module-surface">
    <div class="module-toolbar">
      <p class="t-caption">角色 = 一组权限点 + 每项的数据范围;在「组织及账号管理」里把角色分配给员工。</p>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建角色</el-button>
    </div>

    <AsyncState
      :loading="rolesQuery.isLoading.value || catalogQuery.isLoading.value"
      :error="listError"
      :forbidden="listForbidden"
      :empty="roles.length === 0"
      empty-title="还没有角色"
      empty-hint="新建角色后,勾选权限点并设定数据范围"
      @retry="rolesQuery.refetch"
    >
      <template #empty-action>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建角色</el-button>
      </template>
      <section class="panel panel--flush">
        <el-table :data="roles" stripe class="clickable-rows" @row-click="openMatrix">
          <el-table-column label="角色" min-width="200">
            <template #default="{ row }">
              <div class="role-name">
                <span>{{ row.name }}</span>
                <span class="t-caption">{{ row.code }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="权限点数" width="110" align="right">
            <template #default="{ row }">{{ row.permissionCount }}</template>
          </el-table-column>
          <el-table-column label="成员数" width="100" align="right">
            <template #default="{ row }">{{ row.memberCount }}</template>
          </el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="{ row }">
              <el-tag :type="row.isBuiltin ? 'warning' : 'info'" effect="light" round size="small">
                {{ row.isBuiltin ? '内置' : '自定义' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <div class="table-actions" @click.stop>
                <el-button text type="primary" :icon="ShieldCheck" @click="openMatrix(row)">编辑权限</el-button>
                <ConfirmButton
                  label="删除"
                  :icon="Trash2"
                  confirm-text="确认删除该角色?已分配的员工会失去这组权限。"
                  :disabled="row.isBuiltin"
                  disabled-reason="内置角色不可删除"
                  @confirm="deleteRoleMutation.mutate(row.id)"
                />
              </div>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </AsyncState>

    <!-- 权限矩阵抽屉 -->
    <el-drawer v-model="matrixOpen" size="var(--sb-drawer-list)" direction="rtl" :title="activeRole ? `权限:${activeRole.name}` : '权限'" destroy-on-close>
      <AsyncState
        :loading="rolePermsQuery.isLoading.value"
        :error="rolePermsQuery.error.value && !isForbidden(rolePermsQuery.error.value) ? errorMessage(rolePermsQuery.error.value) : null"
        :forbidden="isForbidden(rolePermsQuery.error.value)"
        :empty="false"
        @retry="rolePermsQuery.refetch"
      >
        <el-alert
          v-if="activeRole?.code === 'superadmin'"
          type="info"
          :closable="false"
          show-icon
          title="超级管理员为内置超管,数据范围恒为全部,这里的勾选对它不生效。"
          style="margin-bottom: var(--sb-space-4)"
        />
        <!-- 全局批量操作:一键全选/清空 + 所有功能统一数据范围 -->
        <div v-if="activeRole?.code !== 'superadmin' && grouped.length > 0" class="perm-bulkbar">
          <el-checkbox
            :model-value="allGranted"
            :indeterminate="someGranted && !allGranted"
            @change="toggleAll(($event as boolean))"
          >
            全选所有权限
          </el-checkbox>
          <div class="perm-bulkbar__scope">
            <span class="t-caption">所有功能统一数据范围</span>
            <el-select size="small" placeholder="批量设置" style="width: 150px" @change="setAllScope(($event as DataScope))">
              <el-option v-for="opt in SCOPE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
            </el-select>
          </div>
        </div>

        <div class="perm-groups">
          <section v-for="mg in menuGrouped" :key="mg.label" class="menu-group">
            <!-- 菜单组标题行:一键全选本组下所有页面 + 所有操作按钮 -->
            <div class="menu-group__head">
              <el-checkbox
                class="menu-group__check"
                :model-value="modAllGranted(groupPerms(mg.modules))"
                :indeterminate="modSomeGranted(groupPerms(mg.modules)) && !modAllGranted(groupPerms(mg.modules))"
                @change="toggleModule(groupPerms(mg.modules), ($event as boolean))"
              >
                {{ mg.label }}
              </el-checkbox>
              <span class="t-caption">全选本组(所有页面 + 操作按钮)</span>
            </div>
            <section v-for="group in mg.modules" :key="group.module" class="panel">
            <!-- 模块标题行:整模块全选 + 本模块统一数据范围 -->
            <div class="perm-group__head">
              <el-checkbox
                class="panel-title"
                :model-value="modAllGranted(group.perms)"
                :indeterminate="modSomeGranted(group.perms) && !modAllGranted(group.perms)"
                @change="toggleModule(group.perms, ($event as boolean))"
              >
                {{ group.label }}
              </el-checkbox>
              <div v-if="hasActions(group.perms)" class="perm-group__bulk">
                <span class="t-caption">本模块数据范围</span>
                <el-select
                  :model-value="moduleScope(group.perms)"
                  size="small"
                  placeholder="统一设置"
                  style="width: 150px"
                  @change="setModuleScope(group.perms, ($event as DataScope))"
                >
                  <el-option v-for="opt in SCOPE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
                </el-select>
              </div>
            </div>
            <div class="perm-rows">
              <div v-for="{ perm, grant } in permRows(group.perms)" :key="perm.code" class="perm-row">
                <el-checkbox v-model="grant.granted" :label="perm.name" />
                <span class="t-caption perm-code">{{ perm.code }}</span>
                <el-select
                  v-if="perm.type === 'action'"
                  v-model="grant.dataScope"
                  size="small"
                  :disabled="!grant.granted"
                  style="width: 150px"
                >
                  <el-option v-for="opt in SCOPE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
                </el-select>
                <el-tag v-else size="small" type="info" effect="plain">菜单</el-tag>
              </div>
            </div>
            </section>
          </section>
        </div>
      </AsyncState>
      <template #footer>
        <div class="drawer-footer">
          <span class="muted drawer-footer__danger">已选 {{ grantedCount }} 项</span>
          <el-button @click="matrixOpen = false">取消</el-button>
          <el-button type="primary" :loading="saveGrantsMutation.isPending.value" @click="saveGrantsMutation.mutate()">
            保存权限
          </el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 新建角色 -->
    <el-dialog v-model="createOpen" title="新建角色" width="520px" destroy-on-close>
      <FormField label="角色名称" required :error="roleErrors.name">
        <el-input v-model="roleForm.name" placeholder="如 销售主管" autofocus @keyup.enter="submitRole" />
      </FormField>
      <FormField label="角色编码" required :error="roleErrors.code">
        <el-input v-model="roleForm.code" placeholder="如 sales_lead(建后不可改)" />
      </FormField>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="createRoleMutation.isPending.value" @click="submitRole">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.role-name {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}
.perm-bulkbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--sb-space-3);
  margin-bottom: var(--sb-space-4);
  padding: var(--sb-space-3) var(--sb-space-4);
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-md);
  background: var(--sb-bg-subtle);
}
.perm-bulkbar__scope,
.perm-group__bulk {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
}
.perm-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--sb-space-2);
  margin-bottom: var(--sb-space-3);
}
/* 让模块标题复选框的文字保持标题样式 */
.perm-group__head .panel-title {
  margin: 0;
  height: auto;
}
.perm-group__head .panel-title :deep(.el-checkbox__label) {
  font-size: var(--sb-font-md);
  font-weight: 600;
  color: var(--sb-text-primary);
}
.perm-groups {
  display: grid;
  gap: var(--sb-gap-block);
}
.menu-group {
  display: grid;
  gap: var(--sb-space-3);
}
.menu-group__head {
  display: flex;
  align-items: center;
  gap: var(--sb-space-3);
  padding: var(--sb-space-2) var(--sb-space-3);
  border-left: 3px solid var(--sb-color-primary);
  background: var(--sb-bg-subtle);
  border-radius: var(--sb-radius-sm);
}
.menu-group__check :deep(.el-checkbox__label) {
  font-size: var(--sb-font-lg);
  font-weight: 700;
  color: var(--sb-text-primary);
}
.perm-rows {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--sb-space-3) var(--sb-space-6);
}
.perm-row {
  display: flex;
  align-items: center;
  gap: var(--sb-space-3);
}
.perm-row .perm-code {
  flex: 1;
  font-family: ui-monospace, monospace;
}
</style>
