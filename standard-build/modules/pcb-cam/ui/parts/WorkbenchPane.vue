<script setup lang="ts">
// modules/pcb-cam/ui/parts/WorkbenchPane.vue
// 工位:左边板图、右边决策流,同一屏。问题点按「步骤 + 类型」归组,一组一判(例外单独挑出来);
// 判过的收起,永远只剩没判的顶在眼前;键盘连打 j/k 上下、y/n/m/a 判、空格定位、Enter 放行;
// 决策记忆把上次的判法当默认值(同客户优先),一键套用;同判法重复 ≥3 次提示写进工厂标准;
// 图上框一块,流里只剩这一块的发现。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import {
  API_CLIENT_VERSION,
  apiPcbCamDecideEq,
  apiPcbCamDecideEqBatch,
  apiPcbCamEqSuggestions,
  apiPcbCamLayerSvg,
  apiPcbCamListEq,
  apiPcbCamStageReport,
  apiPcbCamSubmitEq,
  errorMessage,
  type PcbCamEqDecision,
  type PcbCamEqItemDTO,
  type PcbCamStage,
} from '../../../../src/api/client'
import { kindLabel, severityLabel } from '../labels'
import { clientToMm, viewBoxOf, withBoxes, zoomViewBox } from './svg-geo'
import { useSfx } from './useSfx'

const props = defineProps<{
  jobId: string
  status: string
  eqTotal: number
  canApprove: boolean
  isMobile: boolean
  stageLabel: (s: string) => string
  layerFiles: string[]
  layerColor: (file: string) => string
}>()
const emit = defineEmits<{ (e: 'changed'): void; (e: 'open-profile', kind: string): void }>()
const queryClient = useQueryClient()
const { sfx } = useSfx()

type Decision = Exclude<PcbCamEqDecision, 'pending'>
const DECISIONS: Array<{ value: Decision; label: string; key: string }> = [
  { value: 'accept_fix', label: '接受修复', key: 'y' },
  { value: 'ignore', label: '接受现状', key: 'n' },
  { value: 'manual', label: '人工处理', key: 'm' },
  { value: 'ask_customer', label: '问客户', key: 'a' },
]
const dLabel = (d: string) => DECISIONS.find((x) => x.value === d)?.label ?? d

// ── 数据 ──
const eqQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'eq', props.jobId, props.eqTotal, API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamListEq(props.jobId),
  enabled: computed(() => props.eqTotal > 0),
})
const items = computed(() => eqQuery.data.value?.items ?? [])
const sugQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'eq-suggest', props.jobId, items.value.filter((i) => i.decision === 'pending').length, API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamEqSuggestions(props.jobId),
  enabled: computed(() => items.value.some((i) => i.decision === 'pending')),
  staleTime: 30_000,
})
const suggestions = computed(() => new Map((sugQuery.data.value?.items ?? []).map((s) => [s.id, s.suggestion])))
const repeated = computed(() => sugQuery.data.value?.repeated ?? [])
// 报告里的位置/层:问题点的 itemId 就是那一步报告里的条目 id
type Loc = { layer: string | null; location: { x: number; y: number; bbox?: [number, number, number, number] } | null; fix: { auto_fixable: boolean; applied: boolean } | null }
const stagesNeeded = computed(() => [...new Set(items.value.map((i) => i.stage))])
const locQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'eq-loc', props.jobId, stagesNeeded.value.join('|'), API_CLIENT_VERSION]),
  queryFn: async () => {
    const out = new Map<string, Loc>()
    await Promise.all(stagesNeeded.value.map(async (st) => {
      const r = await apiPcbCamStageReport(props.jobId, st as PcbCamStage)
      for (const it of r.report?.items ?? []) out.set(`${st}|${it.id}`, { layer: it.layer, location: it.location, fix: it.fix })
    }))
    return out
  },
  enabled: computed(() => stagesNeeded.value.length > 0),
  staleTime: 60_000,
})
const locOf = (it: PcbCamEqItemDTO): Loc => locQuery.data.value?.get(`${it.stage}|${it.itemId}`) ?? { layer: null, location: null, fix: null }

// ── 分组 + 框选过滤 ──
const filterBox = ref<[number, number, number, number] | null>(null)
const inBox = (it: PcbCamEqItemDTO) => {
  if (!filterBox.value) return true
  const l = locOf(it).location
  if (!l) return false
  const [x0, y0, x1, y1] = filterBox.value
  return l.x >= x0 && l.x <= x1 && l.y >= y0 && l.y <= y1
}
type Group = { key: string; stage: string; kind: string; label: string; pending: PcbCamEqItemDTO[]; done: PcbCamEqItemDTO[]; severity: string }
const groups = computed<Group[]>(() => {
  const m = new Map<string, Group>()
  for (const it of items.value) {
    if (!inBox(it)) continue
    const key = `${it.stage}|${it.kind}`
    const g = m.get(key) ?? { key, stage: it.stage, kind: it.kind, label: `${props.stageLabel(it.stage)} · ${kindLabel(it.kind)}`, pending: [], done: [], severity: it.severity }
    ;(it.decision === 'pending' ? g.pending : g.done).push(it)
    if (it.severity === 'error') g.severity = 'error'
    m.set(key, g)
  }
  // 还有待判的组在前;同档按错误优先
  return [...m.values()].sort((a, b) => Number(b.pending.length > 0) - Number(a.pending.length > 0) || Number(b.severity === 'error') - Number(a.severity === 'error'))
})
const pendingFlat = computed(() => groups.value.flatMap((g) => g.pending))
const pendingCount = computed(() => items.value.filter((i) => i.decision === 'pending').length)
const doneCount = computed(() => items.value.length - pendingCount.value)
const openGroups = ref<Set<string>>(new Set())
function toggleDone(key: string) {
  const s = new Set(openGroups.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  openGroups.value = s
}

// ── 焦点 + 板图 ──
const focusId = ref<string | null>(null)
const focused = computed(() => items.value.find((i) => i.id === focusId.value) ?? null)
watch(pendingFlat, (list) => {
  if (!focusId.value || !list.some((i) => i.id === focusId.value)) focusId.value = list[0]?.id ?? items.value[0]?.id ?? null
}, { immediate: true })
const layer = ref('')
const follow = ref(true)
watch(focused, (f) => {
  const l = f ? locOf(f).layer : null
  if (l && props.layerFiles.includes(l)) layer.value = l
  else if (!layer.value && props.layerFiles[0]) layer.value = props.layerFiles[0]
}, { immediate: true })
watch(() => locQuery.data.value, () => {
  const l = focused.value ? locOf(focused.value).layer : null
  if (l && props.layerFiles.includes(l)) layer.value = l
})
const svgQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'svg', props.jobId, layer.value, API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamLayerSvg(props.jobId, layer.value, 'board'),
  enabled: computed(() => Boolean(layer.value)),
  staleTime: 5 * 60_000,
})
// 本层的问题点 + 画不出来的层(钻带 / 未识别)上的问题点:位置是板坐标、各层同一画框,借当前层的图看
const renderable = (l: string | null) => Boolean(l && props.layerFiles.includes(l))
const onLayer = computed(() => items.value.filter((i) => locOf(i).location?.bbox && (locOf(i).layer === layer.value || !renderable(locOf(i).layer))))
const svg = computed(() => {
  const base = svgQuery.data.value
  if (!base) return ''
  const boxes = onLayer.value.map((i) => ({
    id: i.id,
    bbox: locOf(i).location!.bbox!,
    cls: `pcb-hit pcb-hit--${i.severity}${i.decision !== 'pending' ? ' pcb-hit--done' : ''}${i.id === focusId.value ? ' pcb-hit--selected' : ''}${renderable(locOf(i).layer) ? '' : ' pcb-hit--other'}`,
    title: `${kindLabel(i.kind)}:${i.message}`,
  }))
  let out = withBoxes(base, boxes)
  const fb = focused.value ? locOf(focused.value).location?.bbox : null
  if (follow.value && fb && (locOf(focused.value!).layer === layer.value || !renderable(locOf(focused.value!).layer))) out = zoomViewBox(out, fb, 2.5)
  if (filterBox.value) out = withBoxes(out, [{ bbox: filterBox.value, cls: 'pcb-sel' }])
  return out
})
const stage = ref<HTMLElement | null>(null)
function onStageClick(e: MouseEvent) {
  const t = e.target as Element
  const rect = t.closest?.('rect[data-id]') as SVGRectElement | null
  if (rect?.dataset.id) {
    focusId.value = rect.dataset.id
    follow.value = false
  }
}
// 框选:按住 Shift 拖(或点「框选」按钮进入模式)
const boxMode = ref(false)
let drag: { x: number; y: number } | null = null
const rubber = ref<{ l: number; t: number; w: number; h: number } | null>(null)
function svgEl(): SVGSVGElement | null {
  return stage.value?.querySelector('svg') ?? null
}
function onDown(e: PointerEvent) {
  if (!(boxMode.value || e.shiftKey)) return
  e.preventDefault()
  drag = { x: e.clientX, y: e.clientY }
  rubber.value = null
}
function onMove(e: PointerEvent) {
  if (!drag || !stage.value) return
  const r = stage.value.getBoundingClientRect()
  rubber.value = { l: Math.min(drag.x, e.clientX) - r.left, t: Math.min(drag.y, e.clientY) - r.top, w: Math.abs(e.clientX - drag.x), h: Math.abs(e.clientY - drag.y) }
}
function onUp(e: PointerEvent) {
  if (!drag) return
  const el = svgEl()
  const a = el && clientToMm(el, drag.x, drag.y)
  const b = el && clientToMm(el, e.clientX, e.clientY)
  drag = null
  rubber.value = null
  if (!a || !b || (Math.abs(a.x - b.x) < 0.2 && Math.abs(a.y - b.y) < 0.2)) return
  filterBox.value = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
  follow.value = false
  boxMode.value = false
}
const vb = computed(() => viewBoxOf(svgQuery.data.value))

// ── 决策 ──
const notes = ref<Record<string, string>>({})
const busy = ref(false)
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'eq', props.jobId] })
  await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'eq-suggest', props.jobId] })
  emit('changed')
}
async function decideOne(it: PcbCamEqItemDTO, decision: Decision) {
  if (!props.canApprove || busy.value) return
  busy.value = true
  try {
    const i = pendingFlat.value.findIndex((x) => x.id === it.id)
    await apiPcbCamDecideEq(props.jobId, it.id, { decision, note: notes.value[it.id] || null })
    sfx('decide')
    const next = pendingFlat.value[i + 1] ?? pendingFlat.value[i - 1]
    if (next && next.id !== it.id) focusId.value = next.id
    await refresh()
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    busy.value = false
  }
}
async function decideGroup(g: Group, decision: Decision) {
  if (!props.canApprove || busy.value || !g.pending.length) return
  busy.value = true
  try {
    const r = await apiPcbCamDecideEqBatch(props.jobId, { itemIds: g.pending.map((i) => i.id), decision })
    sfx('decide')
    ElMessage.success(`${g.label}:${r.changed} 条已判为「${dLabel(decision)}」`)
    await refresh()
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    busy.value = false
  }
}
const memoryCount = computed(() => pendingFlat.value.filter((i) => suggestions.value.get(i.id)).length)
async function applyMemory() {
  if (!props.canApprove || busy.value) return
  const byDecision = new Map<Decision, string[]>()
  for (const it of pendingFlat.value) {
    const s = suggestions.value.get(it.id)
    if (!s || s.decision === 'pending') continue
    byDecision.set(s.decision as Decision, [...(byDecision.get(s.decision as Decision) ?? []), it.id])
  }
  if (!byDecision.size) return
  busy.value = true
  try {
    let n = 0
    for (const [decision, ids] of byDecision) n += (await apiPcbCamDecideEqBatch(props.jobId, { itemIds: ids, decision, note: '沿用决策记忆' })).changed
    sfx('decide')
    ElMessage.success(`按记忆套用了 ${n} 条`)
    await refresh()
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    busy.value = false
  }
}
const submitMutation = useMutation({
  mutationFn: () => apiPcbCamSubmitEq(props.jobId),
  onSuccess: async () => {
    sfx('done')
    ElMessage.success('问题点已处理完,继续处理')
    await refresh()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
function defaultDecision(it: PcbCamEqItemDTO): Decision {
  const s = suggestions.value.get(it.id)
  if (s && s.decision !== 'pending') return s.decision as Decision
  return locOf(it).fix?.auto_fixable ? 'accept_fix' : 'ignore'
}

// ── 键盘 ──
function onKey(e: KeyboardEvent) {
  const t = e.target
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"], .el-select, .el-slider')) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const list = pendingFlat.value
  const i = list.findIndex((x) => x.id === focusId.value)
  const cur = focused.value
  // 有的输入法 / 自动化驱动只给 code 不给 key;小键盘回车也算回车
  const key = e.key || (e.code === 'NumpadEnter' ? 'Enter' : e.code === 'Space' ? ' ' : e.code)
  switch (key) {
    case 'j':
    case 'ArrowDown':
      if (list.length) focusId.value = list[Math.min(list.length - 1, i + 1)]!.id
      break
    case 'k':
    case 'ArrowUp':
      if (list.length) focusId.value = list[Math.max(0, i - 1)]!.id
      break
    case 'y':
      if (cur && cur.decision === 'pending') void decideOne(cur, defaultDecision(cur))
      break
    case 'n':
      if (cur && cur.decision === 'pending') void decideOne(cur, 'ignore')
      break
    case 'm':
      if (cur && cur.decision === 'pending') void decideOne(cur, 'manual')
      break
    case 'a':
      if (cur && cur.decision === 'pending') void decideOne(cur, 'ask_customer')
      break
    case ' ':
      follow.value = !follow.value
      break
    case 'Enter':
      if (pendingCount.value === 0 && props.status === 'needs_review' && props.canApprove) submitMutation.mutate()
      break
    case 'Escape':
      filterBox.value = null
      break
    default:
      return
  }
  e.preventDefault()
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
const itemEls = new Map<string, HTMLElement>()
watch(focusId, (id) => {
  const el = id ? itemEls.get(id) : null
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})
function setItemEl(id: string, el: unknown) {
  if (el instanceof HTMLElement) itemEls.set(id, el)
  else itemEls.delete(id)
}
</script>

<template>
  <div class="wb" :class="{ 'wb--mobile': isMobile }">
    <!-- 左:板图 -->
    <div class="wb__board">
      <div class="wb__bar">
        <el-select v-model="layer" size="small" filterable style="width: 200px" placeholder="层">
          <el-option v-for="f in layerFiles" :key="f" :label="f" :value="f" />
        </el-select>
        <el-checkbox v-model="follow" size="small" title="空格键切换">跟随焦点</el-checkbox>
        <el-button size="small" :type="boxMode ? 'primary' : 'default'" @click="boxMode = !boxMode">{{ boxMode ? '拖一个框…' : '框选' }}</el-button>
        <el-button v-if="filterBox" size="small" @click="filterBox = null">清除框选(Esc)</el-button>
        <span class="spacer" />
        <span class="t-caption">{{ onLayer.length ? `本层 ${onLayer.length} 处` : '本层无标记' }}</span>
      </div>
      <!-- SVG 由本平台 pcb-worker 生成、经服务端代理;内联渲染以叠加问题点框(mm 坐标) -->
      <div ref="stage" class="wb__stage" :class="{ 'wb__stage--box': boxMode }" @click="onStageClick" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
        <p v-if="svgQuery.isLoading.value" class="t-caption wb__hint">取板图…</p>
        <p v-else-if="!svg" class="t-caption wb__hint">{{ layer ? '这一层还画不出来' : '选一层' }}</p>
        <div v-else class="wb__svg" v-html="svg" />
        <div v-if="rubber" class="wb__rubber" :style="{ left: rubber.l + 'px', top: rubber.t + 'px', width: rubber.w + 'px', height: rubber.h + 'px' }" />
      </div>
      <p class="t-caption">点框选中 · Shift 拖框只看那一块 · <b>j/k</b> 上下 · <b>y</b> 按建议判 · <b>n</b> 接受现状 · <b>m</b> 人工 · <b>a</b> 问客户 · <b>空格</b> 跟随 · <b>Enter</b> 放行{{ vb ? '' : '' }}</p>
    </div>

    <!-- 右:决策流 -->
    <div class="wb__stream">
      <div class="wb__bar">
        <strong>待判 {{ pendingCount }}</strong><span class="t-caption">· 已判 {{ doneCount }}</span>
        <span v-if="filterBox" class="t-caption">· 只看框内</span>
        <span class="spacer" />
        <el-button v-if="canApprove && memoryCount" size="small" :disabled="busy" @click="applyMemory">按记忆套用 {{ memoryCount }} 条</el-button>
        <el-button v-if="canApprove && status === 'needs_review'" size="small" type="primary" :disabled="pendingCount > 0" :loading="submitMutation.isPending.value" @click="submitMutation.mutate()">全部处理完,继续(Enter)</el-button>
      </div>
      <div v-if="repeated.length" class="wb__repeat">
        <span v-for="r in repeated.slice(0, 3)" :key="r.kind + r.decision" class="wb__repeat-item">
          「{{ kindLabel(r.kind) }} → {{ dLabel(r.decision) }}」已重复 {{ r.count }} 次
          <el-button link type="primary" size="small" @click="emit('open-profile', r.kind)">写进工厂标准</el-button>
        </span>
      </div>
      <p v-if="eqQuery.isLoading.value" class="t-caption">取问题点…</p>
      <p v-else-if="!groups.length" class="t-caption">{{ filterBox ? '框里没有问题点' : '没有问题点' }}</p>
      <section v-for="g in groups" :key="g.key" class="wb-group" :class="{ 'wb-group--done': !g.pending.length }">
        <div class="wb-group__head">
          <el-tag :type="g.severity === 'error' ? 'danger' : 'warning'" size="small" effect="light">{{ g.pending.length ? g.pending.length : '✓' }}</el-tag>
          <span class="wb-group__label">{{ g.label }}</span>
          <span class="spacer" />
          <template v-if="canApprove && g.pending.length > 1">
            <span class="t-caption">全组</span>
            <el-button v-for="d in DECISIONS" :key="d.value" size="small" link :disabled="busy" @click="decideGroup(g, d.value)">{{ d.label }}</el-button>
          </template>
        </div>
        <div
          v-for="it in g.pending" :key="it.id" :ref="(el) => setItemEl(it.id, el)"
          class="wb-item" :class="{ 'wb-item--focus': it.id === focusId }" @click="focusId = it.id"
        >
          <div class="wb-item__head">
            <el-tag :type="it.severity === 'error' ? 'danger' : it.severity === 'warn' ? 'warning' : 'info'" size="small" effect="plain">{{ severityLabel(it.severity) }}</el-tag>
            <span class="t-caption" :title="it.itemId">{{ locOf(it).layer ?? '' }}<template v-if="locOf(it).location"> · ({{ locOf(it).location!.x.toFixed(1) }}, {{ locOf(it).location!.y.toFixed(1) }})</template></span>
            <span v-if="suggestions.get(it.id)" class="wb-item__memo" :title="suggestions.get(it.id)!.note ?? ''">
              记忆:{{ dLabel(suggestions.get(it.id)!.decision) }}<template v-if="suggestions.get(it.id)!.byName">(沿用 {{ (suggestions.get(it.id)!.at ?? '').slice(5, 10) }} {{ suggestions.get(it.id)!.byName }})</template><template v-if="suggestions.get(it.id)!.sameCustomer"> · 同客户</template> ×{{ suggestions.get(it.id)!.count }}
            </span>
            <span v-if="it.customerReply" class="wb-item__reply" :title="it.customerReply">客户已答复</span>
          </div>
          <p class="wb-item__msg">{{ it.message }}</p>
          <p v-if="it.customerReply" class="wb-item__replytext">客户答复:{{ it.customerReply }}</p>
          <div v-if="canApprove" class="wb-item__actions">
            <el-button v-for="d in DECISIONS" :key="d.value" size="small" :type="d.value === defaultDecision(it) ? 'primary' : 'default'" :disabled="busy" @click.stop="decideOne(it, d.value)">
              {{ d.label }}<kbd v-if="it.id === focusId">{{ d.value === defaultDecision(it) ? 'y' : d.key === 'y' ? '' : d.key }}</kbd>
            </el-button>
            <el-input v-model="notes[it.id]" size="small" placeholder="备注" maxlength="500" class="wb-item__note" @click.stop />
          </div>
        </div>
        <div v-if="g.done.length" class="wb-group__done">
          <el-button link size="small" @click="toggleDone(g.key)">已判 {{ g.done.length }} 条 {{ openGroups.has(g.key) ? '收起' : '展开' }}</el-button>
          <ul v-if="openGroups.has(g.key)" class="wb-group__donelist">
            <li v-for="it in g.done" :key="it.id" @click="focusId = it.id">
              <b>{{ dLabel(it.decision) }}</b> · {{ it.message }}<span v-if="it.note" class="t-caption"> · {{ it.note }}</span>
            </li>
          </ul>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wb { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, 1fr); gap: var(--sb-space-3); }
.wb--mobile { grid-template-columns: 1fr; }
.wb__bar { display: flex; align-items: center; gap: var(--sb-space-2); flex-wrap: wrap; margin-bottom: var(--sb-space-2); }
.wb__bar .spacer { flex: 1; }
.wb__stage { position: relative; height: min(62vh, 620px); border: 1px solid var(--sb-border); border-radius: 8px; background: var(--sb-bg-card); overflow: hidden; }
.wb__stage--box { cursor: crosshair; }
.wb__svg, .wb__svg :deep(svg) { width: 100%; height: 100%; display: block; }
.wb__hint { position: absolute; left: 12px; top: 8px; }
.wb__rubber { position: absolute; border: 1px dashed var(--sb-color-primary); background: var(--sb-color-primary-soft); background: color-mix(in srgb, var(--sb-color-primary) 12%, transparent); pointer-events: none; }
.wb__svg :deep(.pcb-hit) { stroke: #f59e0b; stroke-width: 1.5; stroke-dasharray: 4 3; cursor: pointer; }
.wb__svg :deep(.pcb-hit--error) { stroke: #dc2626; }
.wb__svg :deep(.pcb-hit--done) { stroke: #9ca3af; stroke-dasharray: none; stroke-width: 1; }
.wb__svg :deep(.pcb-hit--other) { stroke-dasharray: 2 2; }
.wb__svg :deep(.pcb-hit--selected) { stroke: #2563eb; stroke-width: 3; stroke-dasharray: none; filter: drop-shadow(0 0 4px rgba(37, 99, 235, 0.8)); }
.wb__svg :deep(.pcb-sel) { stroke: var(--sb-color-primary); stroke-width: 1.5; stroke-dasharray: 6 4; }
.wb__stream { max-height: min(74vh, 760px); overflow: auto; padding-right: 4px; }
.wb__repeat { display: flex; flex-direction: column; gap: 2px; font-size: 12px; padding: 6px 10px; margin-bottom: var(--sb-space-2); border: 1px dashed var(--sb-border); border-radius: 6px; }
.wb-group { border: 1px solid var(--sb-border); border-radius: 8px; padding: var(--sb-space-2) var(--sb-space-3); margin-bottom: var(--sb-space-2); background: var(--sb-bg-card); }
.wb-group--done { opacity: 0.6; }
.wb-group__head { display: flex; align-items: center; gap: var(--sb-space-2); }
.wb-group__head .spacer { flex: 1; }
.wb-group__label { font-weight: 600; }
.wb-item { border-left: 3px solid transparent; padding: 6px 8px; margin: 6px 0 0; border-radius: 4px; cursor: pointer; }
.wb-item--focus { border-left-color: var(--sb-color-primary); background: var(--sb-color-primary-soft); background: color-mix(in srgb, var(--sb-color-primary) 8%, transparent); }
.wb-item__head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wb-item__memo { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--sb-color-primary-soft); background: color-mix(in srgb, var(--sb-color-primary) 14%, transparent); color: var(--sb-color-primary); }
.wb-item__reply { font-size: 11px; padding: 0 6px; border-radius: 999px; background: rgba(34, 197, 94, 0.18); color: #15803d; }
.wb-item__msg { margin: 4px 0; font-size: 13px; }
.wb-item__replytext { margin: 0 0 4px; font-size: 12px; color: #15803d; }
.wb-item__actions { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.wb-item__note { flex: 1; min-width: 120px; }
.wb-item__actions kbd { margin-left: 4px; font-size: 10px; padding: 0 4px; border: 1px solid currentColor; border-radius: 3px; opacity: 0.7; }
.wb-item__actions kbd:empty { display: none; }
.wb-group__done { margin-top: 4px; }
.wb-group__donelist { list-style: none; margin: 0; padding: 0 0 0 8px; font-size: 12px; color: var(--sb-text-secondary); }
.wb-group__donelist li { padding: 2px 0; cursor: pointer; }
</style>
