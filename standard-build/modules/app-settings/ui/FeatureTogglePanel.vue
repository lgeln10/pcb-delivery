<script setup lang="ts">
// modules/app-settings/ui/FeatureTogglePanel.vue
// 功能开关(系统设置内的一个 tab):列出所有菜单组 / 菜单 / 功能,checkbox 开关。
// ★前端口径:关闭的菜单组/菜单从导航消失、功能从权限配置页消失,对所有用户生效(超管的功能按钮仍显示,但后端未拦)。
// ★防自锁:核心入口(系统设置/账号/角色权限/系统管理组)checkbox 置灰,服务端也硬拒。
import { computed } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import AsyncState from '../../../core/ui-kit/AsyncState.vue'
import { NAV_CATALOG, isNavFolder } from '../../../src/nav-catalog'
import {
  apiListFeatureToggles,
  apiListPermissionCatalog,
  apiMyPermissions,
  apiSetFeatureToggle,
  errorMessage,
  isForbidden,
  type PermissionDefDTO,
} from '../../../src/api/client'

const queryClient = useQueryClient()

const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canManage = computed(() => {
  const c = myPermsQuery.data.value?.codes
  return c === null || (Array.isArray(c) && c.includes('feature-toggle:manage'))
})

const togglesQuery = useQuery({ queryKey: ['feature-toggles'], queryFn: apiListFeatureToggles })
const catalogQuery = useQuery({ queryKey: ['org', 'permission-catalog'], queryFn: apiListPermissionCatalog })

const disabledSet = computed(() => new Set(togglesQuery.data.value?.disabledKeys ?? []))
const isEnabled = (key: string) => !disabledSet.value.has(key)

// 防自锁保护码(镜像后端 modules/feature-toggle/logic.ts 的 PROTECTED_KEYS;服务端也会硬拒)。
const PROTECTED = new Set<string>([
  'group:sys',
  'menu:app-settings',
  'menu:org',
  'menu:roles',
  'perm:app-settings:manage',
  'perm:org:view',
  'perm:org:manage',
  'perm:feature-toggle:manage',
])
const isProtected = (key: string) => PROTECTED.has(key)

// 功能(权限码)按模块分组;模块中文名(缺失回落模块码)。
const MODULE_LABEL: Record<string, string> = {
  org: '组织与账号', 'app-settings': '系统设置', audit: '审计', feedback: '需求管理', notify: '通知',
  document: '审批', 'general-request': '通用审批单', partner: '客户/供应商', inventory: '进销存', reimbursement: '费用报销',
  'crm-dashboard': 'CRM驾驶舱', 'crm-todo': 'CRM待办', lead: '线索', opportunity: '商机', contract: '合同', catalog: '标的库',
  'lead-intake-email': '线索邮件', 'crm-assistant': 'CRM助手', finance: '财务', 'hr-core': '人事', attendance: '考勤', payroll: '薪酬',
  superindividual: '企业智能体', news: '行业资讯', digitalemployee: '数字员工', knowledge: '知识库',
}
const functionModules = computed(() => {
  const map = new Map<string, PermissionDefDTO[]>()
  for (const p of catalogQuery.data.value?.items ?? []) {
    if (!map.has(p.module)) map.set(p.module, [])
    map.get(p.module)!.push(p)
  }
  return [...map.entries()].map(([module, perms]) => ({ module, label: MODULE_LABEL[module] ?? module, perms }))
})

const setMutation = useMutation({
  mutationFn: (input: { key: string; enabled: boolean }) => apiSetFeatureToggle(input),
  onSuccess: async () => {
    // 导航(App.vue)/权限页/按钮门控都读这两个缓存,立即失效重取
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['feature-toggles'] }),
      queryClient.invalidateQueries({ queryKey: ['me', 'permissions'] }),
    ])
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

function toggle(key: string, enabled: boolean) {
  if (isProtected(key) && !enabled) {
    ElMessage.warning('核心入口不能关闭')
    return
  }
  setMutation.mutate({ key, enabled })
}

const loading = computed(() => togglesQuery.isLoading.value || catalogQuery.isLoading.value)
const errorObj = computed(() => togglesQuery.error.value || catalogQuery.error.value)
</script>

<template>
  <section class="module-surface">
    <div class="module-toolbar">
      <p class="t-caption">
        关闭的功能:菜单组/菜单从左侧导航消失、功能从「角色与权限」页消失,对所有用户生效。
        核心入口(系统设置 / 账号管理 / 角色与权限 / 系统管理组)不可关闭。
      </p>
    </div>

    <AsyncState
      :loading="loading"
      :error="errorObj && !isForbidden(errorObj) ? errorMessage(errorObj) : null"
      :forbidden="isForbidden(errorObj)"
      :empty="false"
      @retry="() => { togglesQuery.refetch(); catalogQuery.refetch() }"
    >
      <!-- 菜单组与菜单 -->
      <section class="panel ft-panel">
        <div class="panel-toolbar"><h2 class="panel-title">菜单组与菜单</h2></div>
        <div v-for="group in NAV_CATALOG" :key="group.key" class="ft-group">
          <el-checkbox
            :model-value="isEnabled('group:' + group.key)"
            :disabled="!canManage || isProtected('group:' + group.key) || setMutation.isPending.value"
            @change="(v: boolean) => toggle('group:' + group.key, v)"
          >
            <strong>{{ group.label }}</strong>
            <span v-if="isProtected('group:' + group.key)" class="t-caption muted">(核心,不可关闭)</span>
          </el-checkbox>
          <div class="ft-menus">
            <template v-for="entry in group.items" :key="entry.key">
              <!-- 二级文件夹:自己也能整个关掉(不做外币的客户一勾就把「资金往来」收干净),
                   下面再列它的子菜单可单独关。 -->
              <template v-if="isNavFolder(entry)">
                <el-checkbox
                  class="ft-folder"
                  :model-value="isEnabled('menu:' + entry.key)"
                  :disabled="!canManage || !isEnabled('group:' + group.key) || setMutation.isPending.value"
                  @change="(v: boolean) => toggle('menu:' + entry.key, v)"
                >
                  <strong>{{ entry.label }}</strong>
                </el-checkbox>
                <el-checkbox
                  v-for="item in entry.children"
                  :key="item.key"
                  class="ft-folder-child"
                  :model-value="isEnabled('menu:' + item.key)"
                  :disabled="!canManage || isProtected('menu:' + item.key) || !isEnabled('group:' + group.key) || !isEnabled('menu:' + entry.key) || setMutation.isPending.value"
                  @change="(v: boolean) => toggle('menu:' + item.key, v)"
                >
                  {{ item.label }}
                </el-checkbox>
              </template>
              <el-checkbox
                v-else
                :model-value="isEnabled('menu:' + entry.key)"
                :disabled="!canManage || isProtected('menu:' + entry.key) || !isEnabled('group:' + group.key) || setMutation.isPending.value"
                @change="(v: boolean) => toggle('menu:' + entry.key, v)"
              >
                {{ entry.label }}
              </el-checkbox>
            </template>
          </div>
        </div>
      </section>

      <!-- 功能(权限码) -->
      <section class="panel ft-panel">
        <div class="panel-toolbar"><h2 class="panel-title">功能</h2></div>
        <p class="t-caption muted">按模块列出所有功能点。关闭后该功能从权限配置页消失,普通用户的对应按钮隐藏。</p>
        <div v-for="mod in functionModules" :key="mod.module" class="ft-group">
          <div class="ft-mod-label">{{ mod.label }}</div>
          <div class="ft-menus">
            <el-checkbox
              v-for="p in mod.perms"
              :key="p.code"
              :model-value="isEnabled('perm:' + p.code)"
              :disabled="!canManage || isProtected('perm:' + p.code) || setMutation.isPending.value"
              @change="(v: boolean) => toggle('perm:' + p.code, v)"
            >
              {{ p.name }}
            </el-checkbox>
          </div>
        </div>
      </section>
    </AsyncState>
  </section>
</template>

<style scoped>
.ft-panel {
  margin-bottom: var(--sb-space-4);
}
.ft-group {
  padding: var(--sb-space-2) 0;
  border-bottom: 1px solid var(--sb-border);
}
.ft-group:last-child {
  border-bottom: none;
}
.ft-menus {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sb-space-2) var(--sb-space-5);
  padding: var(--sb-space-2) 0 0 var(--sb-space-5);
}
/* 二级文件夹另起一行,子项再缩进一档 —— 否则和一级菜单混排,看不出谁属于谁。 */
.ft-folder {
  flex-basis: 100%;
}
.ft-folder-child {
  margin-left: var(--sb-space-4);
}
.ft-mod-label {
  font-weight: 600;
  color: var(--sb-text-secondary);
}
.muted {
  color: var(--sb-text-secondary);
  margin-left: var(--sb-space-2);
}
</style>
