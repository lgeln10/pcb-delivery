<script setup lang="ts">
// modules/app-settings/ui/AppSettings.vue
// 系统设置:自定义系统名称 + 企业 logo,替换左上角品牌区与浏览器标签页标题。
// 套 UI_SPEC 设置页 recipe:AsyncState 五态、FormField 字段错误定位、ConfirmButton(此页无破坏性动作)。
import { computed, reactive, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Building2, ImageUp, Trash2 } from '@lucide/vue'
import AsyncState from '../../../core/ui-kit/AsyncState.vue'
import FormField from '../../../core/ui-kit/FormField.vue'
import FeatureTogglePanel from './FeatureTogglePanel.vue'
import MenuOrderPanel from './MenuOrderPanel.vue'
import LlmConfig from './LlmConfig.vue'
import StorageConfig from './StorageConfig.vue'
import {
  apiGetAppSettings,
  apiMyPermissions,
  apiUpdateAppSettings,
  apiUploadAppLogo,
  type AppSettingsDTO,
  errorMessage,
  fieldErrors,
  isForbidden,
} from '../../../src/api/client'

const queryClient = useQueryClient()

const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canManage = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('app-settings:manage')) })
// 功能开关 tab:需 feature-toggle:manage 才可见
const canManageToggles = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('feature-toggle:manage')) })
// 菜单排序 tab:需 menu-order:manage 才可见
const canManageMenuOrder = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('menu-order:manage')) })
const activeTab = ref('brand')

const query = useQuery({
  queryKey: ['app-settings'],
  queryFn: apiGetAppSettings,
})

const draft = reactive<{ systemName: string; logoUrl: string | null; timezone: string; invoiceTitle: string; invoiceTaxNo: string }>({ systemName: '', logoUrl: null, timezone: 'Asia/Shanghai', invoiceTitle: '', invoiceTaxNo: '' })
// 时区候选:优先用运行时自带的完整 IANA 列表(可搜索);老浏览器没有该 API 时退回常用几个。
const TIMEZONE_FALLBACK = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC']
const timezoneOptions = computed<string[]>(() => {
  const all = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone')
  return all && all.length ? all : TIMEZONE_FALLBACK
})
// 当前时区此刻是几点:让管理员一眼确认选对了(选错时区 = 所有提醒偏几个小时,且很难自查)
const timezonePreview = computed(() => {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: draft.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date())
  } catch {
    return '—'
  }
})
const errors = ref<Record<string, string>>({})
const logoInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

watch(
  () => query.data.value,
  (v) => {
    if (!v) return
    draft.systemName = v.systemName
    draft.logoUrl = v.logoUrl
    draft.timezone = v.timezone
    draft.invoiceTitle = v.invoiceTitle ?? ''
    draft.invoiceTaxNo = v.invoiceTaxNo ?? ''
  },
  { immediate: true },
)

const saveMutation = useMutation({
  mutationFn: () =>
    apiUpdateAppSettings({
      systemName: draft.systemName.trim(),
      logoUrl: draft.logoUrl,
      timezone: draft.timezone,
      invoiceTitle: draft.invoiceTitle.trim() || null,
      invoiceTaxNo: draft.invoiceTaxNo.trim() || null,
    }),
  onSuccess: async (data: AppSettingsDTO) => {
    ElMessage.success('系统设置已保存')
    // 直接写缓存,App 壳层(品牌区/标签页标题)即时更新
    queryClient.setQueryData(['app-settings'], data)
  },
  onError: (e) => {
    errors.value = fieldErrors(e)
    ElMessage.error(errorMessage(e))
  },
})

function submit() {
  errors.value = {}
  if (draft.systemName.trim().length > 60) {
    errors.value.systemName = '系统名称不能超过 60 个字符'
    return
  }
  const taxNo = draft.invoiceTaxNo.trim().toUpperCase()
  if (taxNo && !/^[0-9A-Z]{15,20}$/.test(taxNo)) {
    errors.value.invoiceTaxNo = '税号应为 15-20 位数字/大写字母(统一社会信用代码)'
    return
  }
  saveMutation.mutate()
}

function pickLogo() {
  logoInput.value?.click()
}

async function onLogoChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploading.value = true
  try {
    const { url } = await apiUploadAppLogo(file)
    draft.logoUrl = url
    ElMessage.success('logo 已上传,记得点保存生效')
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    uploading.value = false
  }
}

function clearLogo() {
  draft.logoUrl = null
}
</script>

<template>
  <section class="module-surface">
    <el-tabs v-model="activeTab" class="settings-tabs">
    <el-tab-pane label="品牌设置" name="brand" lazy>
    <div class="module-toolbar">
      <p class="t-caption">
        自定义系统名称与企业 logo——保存后替换左上角品牌区、浏览器标签页标题。留空则使用默认名称与图标。
      </p>
    </div>

    <AsyncState
      :loading="query.isLoading.value"
      :error="query.error.value && !isForbidden(query.error.value) ? errorMessage(query.error.value) : null"
      :forbidden="isForbidden(query.error.value)"
      :empty="false"
      @retry="query.refetch"
    >
      <section class="panel settings-panel">
        <div class="panel-toolbar">
          <h2 class="panel-title">品牌设置</h2>
        </div>

        <FormField label="系统名称" :error="errors.systemName">
          <el-input
            v-model="draft.systemName"
            maxlength="60"
            show-word-limit
            placeholder="如 企业AI操作系统(留空用默认名称)"
            @keyup.enter="submit"
          />
        </FormField>

        <FormField label="企业 logo">
          <div class="logo-row">
            <div class="logo-preview" :class="{ 'logo-preview--empty': !draft.logoUrl }">
              <img v-if="draft.logoUrl" :src="draft.logoUrl" alt="logo 预览" />
              <Building2 v-else :size="28" />
            </div>
            <div class="logo-actions">
              <el-button v-if="canManage" :icon="ImageUp" :loading="uploading" @click="pickLogo">
                {{ draft.logoUrl ? '更换 logo' : '上传 logo' }}
              </el-button>
              <el-button v-if="canManage && draft.logoUrl" text :icon="Trash2" @click="clearLogo">移除</el-button>
              <input
                ref="logoInput"
                class="sr-only-file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                @change="onLogoChange"
              />
            </div>
          </div>
          <p class="t-caption muted">支持 PNG/JPG/WEBP/SVG/GIF,不超过 2MB。建议正方形或横向透明底图。</p>
        </FormField>

        <FormField label="系统时区" :error="errors.timezone">
          <el-select
            v-model="draft.timezone"
            :disabled="!canManage"
            filterable
            placeholder="选择时区"
            style="max-width: 320px"
          >
            <el-option v-for="tz in timezoneOptions" :key="tz" :label="tz" :value="tz" />
          </el-select>
          <p class="t-caption muted">
            当前时区此刻:{{ timezonePreview }}。定时任务按它计算。默认东八区北京时间。
          </p>
        </FormField>

        <div class="panel-toolbar">
          <h2 class="panel-title">开票信息</h2>
        </div>

        <FormField label="开票抬头(公司全称)" :error="errors.invoiceTitle">
          <el-input
            v-model="draft.invoiceTitle"
            :disabled="!canManage"
            maxlength="100"
            placeholder="与营业执照一致的公司全称(留空则不启用抬头核对)"
            style="max-width: 480px"
          />
        </FormField>

        <FormField label="税号(统一社会信用代码)" :error="errors.invoiceTaxNo">
          <el-input
            v-model="draft.invoiceTaxNo"
            :disabled="!canManage"
            maxlength="20"
            placeholder="如 91330100XXXXXXXXXX"
            style="max-width: 480px"
          />
          <p class="t-caption muted">
            公司开票资料。留空则不使用。
          </p>
        </FormField>

        <div class="form-actions">
          <el-button v-if="canManage" type="primary" :loading="saveMutation.isPending.value" @click="submit">保存</el-button>
        </div>
      </section>
    </AsyncState>
    </el-tab-pane>

    <el-tab-pane v-if="canManageToggles" label="功能开关" name="features" lazy>
      <FeatureTogglePanel />
    </el-tab-pane>

    <!-- 菜单排序:拖拽调整一级/二级菜单顺序,全系统统一生效。需 menu-order:manage。 -->
    <el-tab-pane v-if="canManageMenuOrder" label="菜单排序" name="menu-order" lazy>
      <MenuOrderPanel />
    </el-tab-pane>

    <!-- AI 大模型:平台级 LLM 配置(独立数据源,自带 AsyncState/五态)。配置 API 需 app-settings:manage。 -->
    <el-tab-pane v-if="canManage" label="AI 大模型" name="llm" lazy>
      <LlmConfig />
    </el-tab-pane>

    <!-- 文件存储:平台级对象存储配置(本地 / 阿里云 OSS / 火山引擎 TOS)。配置 API 需 app-settings:manage。 -->
    <el-tab-pane v-if="canManage" label="文件存储" name="storage" lazy>
      <StorageConfig />
    </el-tab-pane>
    </el-tabs>
  </section>
</template>

<style scoped>
.settings-panel {
  max-width: 640px;
}
.logo-row {
  display: flex;
  align-items: center;
  gap: var(--sb-space-4);
}
.logo-preview {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-sm);
  background: var(--sb-bg-card);
  color: var(--sb-text-secondary);
  overflow: hidden;
}
.logo-preview img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.logo-preview--empty {
  border-style: dashed;
}
.logo-actions {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
}
.sr-only-file {
  display: none;
}
.form-actions {
  margin-top: var(--sb-space-5);
}
</style>
