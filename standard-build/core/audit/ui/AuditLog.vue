<script setup lang="ts">
// core/audit/ui/AuditLog.vue
// 系统审计日志:谁/何时/对什么/做了什么/结果。只读(append-only),仅 audit:view 可见。
// 套 UI_SPEC 列表页 recipe + 混合筛选(结果即时,动作/时间走查询)。
import { computed, reactive, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import AsyncState from '../../ui-kit/AsyncState.vue'
import FilterBar from '../../ui-kit/FilterBar.vue'
import { API_CLIENT_VERSION, apiListAudit, type AuditLogDTO, errorMessage, isForbidden } from '../../../src/api/client'

const applied = reactive({ action: '', result: '' as '' | 'success' | 'failed', from: '', to: '' })
const draft = reactive({ action: '', range: [] as string[] })
const detailOpen = ref(false)
const selected = ref<AuditLogDTO | null>(null)

const pageSize = ref(20)
const pageCursors = ref<(string | undefined)[]>([undefined])
const pageIndex = ref(0)
function resetPage() { pageCursors.value = [undefined]; pageIndex.value = 0 }
watch(applied, resetPage)
watch(pageSize, resetPage)
const query = useQuery({
  queryKey: ['audit', 'list', applied, pageIndex, pageSize, API_CLIENT_VERSION],
  queryFn: () =>
    apiListAudit({
      action: applied.action || undefined,
      result: applied.result || undefined,
      from: applied.from || undefined,
      to: applied.to || undefined,
      cursor: pageCursors.value[pageIndex.value],
      limit: pageSize.value,
    }),
})
const rows = computed(() => query.data.value?.items ?? [])
const total = computed(() => query.data.value?.total ?? 0)
function onPageChange(p: number) {
  if (p > pageIndex.value + 1) { const nc = query.data.value?.nextCursor; if (!nc) return; if (pageIndex.value + 1 >= pageCursors.value.length) pageCursors.value.push(nc); pageIndex.value++ }
  else if (p < pageIndex.value + 1 && pageIndex.value > 0) pageIndex.value--
}

function runSearch() {
  applied.action = draft.action.trim()
  applied.from = draft.range[0] ?? ''
  applied.to = draft.range[1] ?? ''
}
function resetSearch() {
  draft.action = ''
  draft.range = []
  applied.action = ''
  applied.result = ''
  applied.from = ''
  applied.to = ''
}
function openDetail(row: AuditLogDTO) {
  selected.value = row
  detailOpen.value = true
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}
// 手机上筛选条件收进抽屉后就看不见了 —— 把当前生效的报给 FilterBar,由它渲染成可点掉的 chips。
// (为什么不让组件自己去数:见 core/ui-kit/FilterBar.vue 里 active 那段注释)
// ★读 applied 不读 draft:输入框里敲了还没点「查询」的内容并没有在筛列表。
const AUDIT_RESULT_LABEL: Record<string, string> = { success: '成功', failed: '失败' }
const activeFilters = computed(() => [
  applied.result && { label: `结果:${AUDIT_RESULT_LABEL[applied.result]}`, clear: () => { applied.result = '' } },
  applied.action && { label: `动作含:${applied.action}`, clear: () => { draft.action = ''; applied.action = '' } },
  applied.from && { label: '时间范围已限定', clear: () => { draft.range = []; applied.from = ''; applied.to = '' } },
])

</script>

<template>
  <section class="module-surface module-surface--fill">
    <div class="module-toolbar">
      <p class="t-caption">系统操作流水:append-only 不可篡改,记录每个写操作的人/动作/目标/结果。</p>
    </div>

    <FilterBar :active="activeFilters">
      <div class="filter-bar__field">
        <span class="t-label">结果</span>
        <el-select v-model="applied.result" clearable placeholder="全部">
          <el-option v-for="(label, key) in AUDIT_RESULT_LABEL" :key="key" :label="label" :value="key" />
        </el-select>
      </div>
      <div class="filter-bar__field">
        <span class="t-label">动作含</span>
        <el-input v-model="draft.action" placeholder="如 partners / vouchers" @keyup.enter="runSearch" />
      </div>
      <div class="filter-bar__field" style="min-width: 360px">
        <span class="t-label">时间范围</span>
        <el-date-picker
          v-model="draft.range"
          type="datetimerange"
          value-format="YYYY-MM-DDTHH:mm:ss.SSS[Z]"
          start-placeholder="起"
          end-placeholder="止"
        />
      </div>
      <div class="filter-bar__actions">
        <el-button text @click="resetSearch">重置</el-button>
        <el-button type="primary" @click="runSearch">查询</el-button>
      </div>
    </FilterBar>

    <div class="list-fill">
    <AsyncState
      :loading="query.isLoading.value"
      :error="query.error.value && !isForbidden(query.error.value) ? errorMessage(query.error.value) : null"
      :forbidden="isForbidden(query.error.value)"
      :empty="rows.length === 0"
      empty-title="暂无审计记录"
      empty-hint="对系统做任何写操作后,会在此自动留痕"
      @retry="query.refetch"
    >
      <section class="panel panel--flush">
        <el-table :data="rows" stripe height="100%" class="clickable-rows" @row-click="openDetail">
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作人" min-width="120">
            <template #default="{ row }">{{ row.actorName ?? '—' }}</template>
          </el-table-column>
          <el-table-column prop="action" label="动作" min-width="240" show-overflow-tooltip />
          <el-table-column label="目标" min-width="120">
            <template #default="{ row }">{{ row.targetId ? row.targetId.slice(0, 8) : '—' }}</template>
          </el-table-column>
          <el-table-column label="来源" width="90">
            <template #default="{ row }">{{ { http: 'HTTP', login: '登录', system: '系统' }[row.source] }}</template>
          </el-table-column>
          <el-table-column label="结果" width="90">
            <template #default="{ row }">
              <el-tag :type="row.result === 'success' ? 'success' : 'danger'" effect="light" round size="small">
                {{ row.result === 'success' ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </AsyncState>
    </div>

    <div v-if="total > 0" class="list-pager">
      <el-pagination :current-page="pageIndex + 1" v-model:page-size="pageSize" :page-sizes="[10, 20, 50]" :total="total" layout="total, sizes, prev, pager, next" background @current-change="onPageChange" />
    </div>

    <el-drawer v-model="detailOpen" title="审计详情" size="var(--sb-drawer-list)" direction="rtl" destroy-on-close>
      <div v-if="selected" class="drawer-stack">
        <dl class="dl">
          <div class="dl__i"><dt class="dl__k">时间</dt><dd class="dl__v">{{ fmtTime(selected.createdAt) }}</dd></div>
          <div class="dl__i"><dt class="dl__k">操作人</dt><dd class="dl__v">{{ selected.actorName ?? '—' }}</dd></div>
          <div class="dl__i dl__i--wide"><dt class="dl__k">动作</dt><dd class="dl__v">{{ selected.action }}</dd></div>
          <div class="dl__i"><dt class="dl__k">目标类型</dt><dd class="dl__v">{{ selected.targetType ?? '—' }}</dd></div>
          <div class="dl__i"><dt class="dl__k">目标 ID</dt><dd class="dl__v">{{ selected.targetId ?? '—' }}</dd></div>
          <div class="dl__i"><dt class="dl__k">来源</dt><dd class="dl__v">{{ selected.source }}</dd></div>
          <div class="dl__i"><dt class="dl__k">结果</dt><dd class="dl__v">{{ selected.result }}</dd></div>
          <div class="dl__i dl__i--wide"><dt class="dl__k">IP</dt><dd class="dl__v">{{ selected.ip ?? '—' }}</dd></div>
          <div v-if="selected.summary" class="dl__i dl__i--wide"><dt class="dl__k">摘要</dt><dd class="dl__v">{{ selected.summary }}</dd></div>
        </dl>
        <section class="panel">
          <h3 class="panel-title">入参(已脱敏)</h3>
          <pre class="audit-detail">{{ JSON.stringify(selected.detail, null, 2) }}</pre>
        </section>
      </div>
    </el-drawer>
  </section>
</template>

<style scoped>
.audit-detail {
  margin: 0;
  padding: var(--sb-space-3);
  background: var(--sb-bg-sunken);
  border-radius: var(--sb-radius-md);
  font-family: ui-monospace, monospace;
  font-size: var(--sb-font-xs);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--sb-text-primary);
}
</style>
