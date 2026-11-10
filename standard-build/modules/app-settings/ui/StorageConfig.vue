<script setup lang="ts">
// modules/app-settings/ui/StorageConfig.vue
// 系统设置 → 文件存储:平台级对象存储 provider(本地磁盘 / 阿里云 OSS / 火山引擎 TOS)。
// 打开某云存储的开关 → 全系统上传/下载都改走它;都关 = 本地磁盘。secret 加密入库,只回「是否已保存」。
import { computed, reactive, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Cloud } from '@lucide/vue'
import ConfirmButton from '../../../core/ui-kit/ConfirmButton.vue'
import FormField from '../../../core/ui-kit/FormField.vue'
import {
  apiGetStorageConfig, apiMyPermissions, apiSetActiveStorageProvider,
  apiRepairPublicAcl, apiSaveStorageProvider, apiDeleteStorageProvider, apiTestStorageProvider, apiMigrateStorageToCloud,
  type StorageConfigDTO, type StorageProviderView, type StorageProviderPatch, type PublicAclRepairSummary, type StorageMigrationSummary, errorMessage,
} from '../../../src/api/client'

const queryClient = useQueryClient()
const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canManage = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('app-settings:manage')) })

const query = useQuery({ queryKey: ['storage', 'config'], queryFn: apiGetStorageConfig })
const cfg = computed(() => query.data.value)

// 子标签:每个存储 provider 一张卡片;默认选中当前生效的云存储,否则第一个
const activeStorageTab = ref('')

type Draft = { region: string; bucket: string; endpoint: string; publicBase: string; accessKeyId: string; accessKeySecret: string }
const drafts = reactive<Record<string, Draft>>({})
watch(cfg, (v) => {
  if (!v) return
  for (const p of v.providers) {
    drafts[p.id] = {
      region: p.values.region,
      bucket: p.values.bucket,
      endpoint: p.values.endpoint,
      publicBase: p.values.publicBase,
      accessKeyId: p.values.accessKeyId,
      accessKeySecret: '', // 已保存的 secret 不回显;留空=不改
    }
  }
  if (!v.providers.some((p) => p.id === activeStorageTab.value)) {
    activeStorageTab.value = v.providers.find((p) => p.id === v.activeProvider)?.id ?? v.providers[0]?.id ?? ''
  }
}, { immediate: true })

const activeLabel = computed(() => {
  const v = cfg.value
  if (!v) return ''
  if (v.activeProvider === 'local') return v.legacyEnvOss ? '本地磁盘(检测到环境变量 OSS，实际走 OSS)' : '本地磁盘'
  return v.providers.find((p) => p.id === v.activeProvider)?.label ?? v.activeProvider
})

function statusOf(p: StorageProviderView): { label: string; type: 'success' | 'info' | 'warning' } {
  if (cfg.value?.activeProvider === p.id) return { label: '已启用', type: 'success' }
  if (p.configured && p.secretSaved) return { label: '已配置未启用', type: 'info' }
  return { label: '未配置', type: 'warning' }
}

function patchOf(id: string): StorageProviderPatch {
  const d = drafts[id]!
  const patch: StorageProviderPatch = {
    region: d.region, bucket: d.bucket, endpoint: d.endpoint, publicBase: d.publicBase, accessKeyId: d.accessKeyId,
  }
  if (d.accessKeySecret.trim()) patch.accessKeySecret = d.accessKeySecret.trim() // 留空则不改原密文
  return patch
}

const saveMutation = useMutation({
  mutationFn: (id: string) => apiSaveStorageProvider(id, patchOf(id)),
  onSuccess: async (data: StorageConfigDTO, id) => {
    ElMessage.success('参数已保存')
    if (drafts[id]) drafts[id]!.accessKeySecret = ''
    await queryClient.setQueryData(['storage', 'config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const testMutation = useMutation({
  mutationFn: (id: string) => apiTestStorageProvider(id),
  onSuccess: () => ElMessage.success('连接成功'),
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const activeMutation = useMutation({
  mutationFn: (provider: 'local' | 'oss' | 'tos') => apiSetActiveStorageProvider(provider),
  onSuccess: async (data: StorageConfigDTO) => {
    ElMessage.success(data.activeProvider === 'local' ? '已切回本地磁盘' : '已启用云存储')
    await queryClient.setQueryData(['storage', 'config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const deleteMutation = useMutation({
  mutationFn: (id: string) => apiDeleteStorageProvider(id),
  onSuccess: async (data: StorageConfigDTO) => {
    ElMessage.success('已清除该存储配置')
    await queryClient.setQueryData(['storage', 'config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const pending = computed(() => saveMutation.isPending.value || activeMutation.isPending.value || deleteMutation.isPending.value)

// ── 本地→云 一键迁移:当前生效为云存储(oss/tos)时才可迁;成功后展示汇总 ──
const canMigrate = computed(() => cfg.value?.activeProvider === 'oss' || cfg.value?.activeProvider === 'tos')
const migrateResult = ref<StorageMigrationSummary | null>(null)
const migrateMutation = useMutation({
  mutationFn: () => apiMigrateStorageToCloud(),
  onSuccess: (data: StorageMigrationSummary) => {
    migrateResult.value = data
    ElMessage.success(`迁移完成:已上传 ${data.filesMigrated} 个文件,更新 ${data.rowsUpdated} 条数据指向`)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 修复公开文件权限:系统 logo / 官网图片必须匿名可读(登录页未登录就要显示 logo,官网访客要看图);
//    私有桶启用前上传的这些对象没打过 public-read,一键重打。私有文件不在此列(它们走票据下载)。──
const repairResult = ref<PublicAclRepairSummary | null>(null)
const repairMutation = useMutation({
  mutationFn: () => apiRepairPublicAcl(),
  onSuccess: (data: PublicAclRepairSummary) => {
    repairResult.value = data
    ElMessage.success(`已修复 ${data.objectsFixed} 个公开文件的访问权限`)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// 开关:打开→启用该 provider;关闭→切回本地。互斥由后端单值 active_provider 保证。
function onToggle(id: 'oss' | 'tos', on: boolean) {
  activeMutation.mutate(on ? id : 'local')
}
</script>

<template>
  <section class="panel settings-panel storage-panel">
    <div class="panel-toolbar">
      <h2 class="panel-title"><Cloud :size="16" /> 文件存储</h2>
    </div>
    <p class="t-caption muted" style="margin-bottom: var(--sb-space-4)">
      平台级基础设施:全系统的文件上传/下载统一走这里生效的存储。当前生效：<strong>{{ activeLabel }}</strong>。
      打开某云存储开关即用它上传下载；都不开则用服务器本地磁盘。
    </p>
    <p v-if="cfg && !cfg.keyStoreReady" class="t-caption storage-warn">
      未配置 AUTH_SECRET / CONFIG_ENC_KEY，无法安全保存 AccessKey Secret；请先在部署 .env 配置后再来保存。
    </p>

    <!-- 每个存储 provider 一张子标签卡片,点标签切换,避免多家平铺 -->
    <el-tabs v-if="cfg?.providers?.length" v-model="activeStorageTab" type="border-card" class="storage-tabs">
      <el-tab-pane v-for="p in cfg.providers" :key="p.id" :name="p.id" lazy>
        <template #label>
          <span class="storage-tab-label">
            {{ p.label }}
            <el-tag :type="statusOf(p).type" effect="light" round size="small">{{ statusOf(p).label }}</el-tag>
          </span>
        </template>

        <div class="storage-provider__head">
          <div class="storage-provider__switch">
            <span class="t-caption muted">启用该存储</span>
            <el-switch
              :model-value="cfg?.activeProvider === p.id"
              :disabled="!canManage || (!(p.configured && p.secretSaved) && cfg?.activeProvider !== p.id) || pending"
              @update:model-value="(val: boolean) => onToggle(p.id, val)"
            />
          </div>
        </div>

        <el-form v-if="drafts[p.id]" label-position="top" class="config-form">
          <el-row :gutter="16">
            <el-col v-for="f in p.fields" :key="f.key" :span="12">
              <FormField :label="f.label">
                <el-input
                  v-if="f.secret"
                  v-model="drafts[p.id]!.accessKeySecret"
                  type="password"
                  show-password
                  :placeholder="p.secretSaved ? '已保存，输入新值可替换' : (f.placeholder || '输入 AccessKey Secret')"
                />
                <el-input v-else v-model="(drafts[p.id]! as any)[f.key]" :placeholder="f.placeholder" />
              </FormField>
            </el-col>
          </el-row>
          <div class="storage-provider__actions" v-if="canManage">
            <el-button type="primary" :loading="saveMutation.isPending.value" @click="saveMutation.mutate(p.id)">保存参数</el-button>
            <el-button :disabled="!(p.configured && p.secretSaved)" :loading="testMutation.isPending.value" @click="testMutation.mutate(p.id)">测试连接</el-button>
            <ConfirmButton
              v-if="p.configured || p.secretSaved"
              label="清除"
              confirm-text="清除该存储的全部参数？若正在启用会自动切回本地磁盘。"
              :disabled="deleteMutation.isPending.value"
              @confirm="deleteMutation.mutate(p.id)"
            />
          </div>
        </el-form>
      </el-tab-pane>
    </el-tabs>

    <!-- 本地文件迁移:把历史存在服务器本地磁盘的文件统一上传到当前启用的云存储,并改写所有数据指向 -->
    <div v-if="canManage" class="migrate-box">
      <h3 class="panel-title"><Cloud :size="15" /> 本地文件迁移</h3>
      <p class="t-caption muted" style="margin: var(--sb-space-2) 0">
        把此前存在<strong>服务器本地磁盘</strong>(<code>/uploads</code>)的文件,统一上传到当前启用的云存储,并自动改写系统里所有引用这些文件的数据指向。
        本地文件会<strong>保留做备份</strong>(不删除),迁移可重复运行(已迁走的不会重复处理)。
      </p>
      <p v-if="!canMigrate" class="t-caption storage-warn">
        当前生效存储是本地磁盘,无法迁移。请先在上方启用一个云存储(阿里云 OSS / 火山引擎 TOS)。
      </p>
      <ConfirmButton
        label="一键迁移本地文件到云存储"
        :disabled="!canMigrate || migrateMutation.isPending.value"
        :loading="migrateMutation.isPending.value"
        confirm-text="将把本地 /uploads 里被引用的文件上传到当前启用的云存储,并改写所有数据指向。本地文件保留做备份。确认开始?"
        @confirm="migrateMutation.mutate()"
      />
      <div v-if="migrateResult" class="migrate-result">
        <p class="t-caption">
          目标存储:<strong>{{ migrateResult.provider.toUpperCase() }}</strong> ·
          已上传文件 <strong>{{ migrateResult.filesMigrated }}</strong> 个 ·
          更新数据 <strong>{{ migrateResult.rowsUpdated }}</strong> 条
          <span v-if="migrateResult.filesSkipped.length"> · 跳过 <strong>{{ migrateResult.filesSkipped.length }}</strong> 个</span>
        </p>
        <el-collapse v-if="migrateResult.filesSkipped.length" class="migrate-skipped">
          <el-collapse-item :title="`查看跳过的 ${migrateResult.filesSkipped.length} 个文件`">
            <ul class="skip-list">
              <li v-for="(s, i) in migrateResult.filesSkipped" :key="i"><code>{{ s.key }}</code> — {{ s.reason }}</li>
            </ul>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>

    <!-- 公开文件权限修复:云存储桶保持私有,但 logo 与官网图必须匿名可读 -->
    <div v-if="canManage" class="migrate-box">
      <h3 class="panel-title"><Cloud :size="15" /> 公开文件权限修复</h3>
      <p class="t-caption muted" style="margin: var(--sb-space-2) 0">
        存储桶保持<strong>私有</strong>:合同、发票、报销、人事档案等内部文件只能通过系统带签名下载,链接有时效。
        但<strong>系统 Logo 与官网图片</strong>必须任何人可读(登录页未登录时就要显示 Logo,官网访客要看图)。
        若这些图片打不开,点此给它们重新设置公开读权限。可重复运行。
      </p>
      <p v-if="!canMigrate" class="t-caption storage-warn">当前生效存储是本地磁盘,无需修复对象权限。</p>
      <el-button
        :disabled="!canMigrate || repairMutation.isPending.value"
        :loading="repairMutation.isPending.value"
        @click="repairMutation.mutate()"
      >修复公开文件访问权限</el-button>
      <div v-if="repairResult" class="migrate-result">
        <p class="t-caption">
          已修复 <strong>{{ repairResult.objectsFixed }}</strong> 个对象
          <span v-if="repairResult.failed.length"> · 失败 <strong>{{ repairResult.failed.length }}</strong> 个</span>
        </p>
        <ul v-if="repairResult.failed.length" class="skip-list">
          <li v-for="(f, i) in repairResult.failed" :key="i"><code>{{ f.key }}</code> — {{ f.reason }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.storage-panel { max-width: 720px; margin-top: var(--sb-space-5); }
.storage-warn { color: var(--sb-color-warning); margin-bottom: var(--sb-space-3); }
.config-form { padding-top: 0; }
.storage-tab-label { display: inline-flex; align-items: center; gap: 6px; }
.storage-provider__head { display: flex; align-items: center; gap: 8px; margin-bottom: var(--sb-space-3); }
.storage-provider__switch { display: flex; align-items: center; gap: 6px; }
.storage-provider__actions { display: flex; gap: 8px; align-items: center; margin-top: var(--sb-space-2); }
.migrate-box { margin-top: var(--sb-space-5); padding-top: var(--sb-space-4); border-top: 1px solid var(--sb-border); }
.migrate-result { margin-top: var(--sb-space-3); }
.migrate-skipped { margin-top: var(--sb-space-2); }
.skip-list { margin: 0; padding-left: var(--sb-space-4); display: flex; flex-direction: column; gap: 4px; }
.skip-list code { font-size: var(--sb-font-xs); }
</style>
