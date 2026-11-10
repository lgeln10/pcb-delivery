<script setup lang="ts">
// modules/pcb-cam/ui/parts/EngineLog.vue
// 引擎实况流:跑着的时候不转圈,把 worker 每个 op 的一行往上滚(stage 开始/结束、op +added −deleted ~modified、
// 需人工的、失败的)。数据来自 GET /jobs/:id/progress?after=<n> 增量轮询;停了就只拉一次留着看。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { apiPcbCamProgress, type PcbCamProgressLine } from '../../../../src/api/client'
import { opLabel } from '../labels'

const props = defineProps<{ jobId: string; running: boolean; stageLabel: (s: string) => string }>()
const emit = defineEmits<{ (e: 'stage-end', line: PcbCamProgressLine): void }>()

const lines = ref<PcbCamProgressLine[]>([])
const unavailable = ref(false)
const box = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let lastN = 0
let stopped = false

async function pull() {
  if (stopped) return
  try {
    const r = await apiPcbCamProgress(props.jobId, lastN)
    unavailable.value = Boolean(r.unavailable)
    if (r.lines.length) {
      for (const l of r.lines) if (l.event === 'stage_end') emit('stage-end', l)
      lines.value = [...lines.value, ...r.lines].slice(-300)
      lastN = r.lines[r.lines.length - 1]!.n
      requestAnimationFrame(() => box.value?.scrollTo({ top: box.value.scrollHeight, behavior: 'smooth' }))
    }
  } catch {
    unavailable.value = true
  }
  if (props.running && !stopped) timer = setTimeout(pull, 1500)
}
function restart() {
  if (timer) clearTimeout(timer)
  lines.value = []
  lastN = 0
  void pull()
}
watch(() => props.jobId, restart, { immediate: true })
watch(
  () => props.running,
  (r) => {
    if (r) {
      if (timer) clearTimeout(timer)
      void pull()
    }
  },
)
onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
})

const shown = computed(() => lines.value.slice(-120))
function fmtTs(ts: number) {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
function text(l: PcbCamProgressLine): string {
  if (l.event === 'stage_start') return `▶ ${props.stageLabel(l.stage)} 开始`
  if (l.event === 'stage_end') return `■ ${props.stageLabel(l.stage)} ${l.status === 'ok' ? '通过' : l.status === 'needs_review' ? '待确认' : l.status ?? ''}${l.decisions ? ` · 拍板 ${l.decisions}` : ''}${l.errors ? ` · 错 ${l.errors}` : ''}${l.ms ? ` · ${(l.ms / 1000).toFixed(1)}s` : ''}`
  if (l.event === 'op_start') return `  ${opLabel(l.op)} ${l.layer ?? ''} …`
  if (l.event === 'op_end') return `  ${opLabel(l.op)} ${l.layer ?? ''} → +${l.added ?? 0} −${l.deleted ?? 0} ~${l.modified ?? 0}${l.ms ? ` (${l.ms} ms)` : ''}`
  if (l.event === 'op_skip') return `  ⚠ ${l.message}`
  if (l.event === 'op_fail') return `  ✗ ${l.message}`
  return `  ${l.message}`
}
const cls = (l: PcbCamProgressLine) => ({ 'elog__line--stage': l.event.startsWith('stage'), 'elog__line--warn': l.event === 'op_skip', 'elog__line--fail': l.event === 'op_fail', 'elog__line--changed': l.event === 'op_end' && ((l.added ?? 0) + (l.deleted ?? 0) + (l.modified ?? 0)) > 0 })
</script>

<template>
  <div class="elog" :class="{ 'elog--running': running }">
    <div class="elog__head">
      <span class="elog__dot" /><span class="t-caption">引擎实况{{ running ? ':正在改图' : ':空闲' }}</span>
      <span class="spacer" />
      <span v-if="unavailable" class="t-caption">引擎离线,没有实况</span>
      <span v-else class="t-caption">{{ lines.length }} 行</span>
    </div>
    <div ref="box" class="elog__box">
      <p v-if="!shown.length" class="t-caption">还没有实况:本地引擎开始改图后,每一步会在这里滚出来</p>
      <div v-for="l in shown" :key="l.n" class="elog__line" :class="cls(l)"><span class="elog__ts">{{ fmtTs(l.ts) }}</span>{{ text(l) }}</div>
      <div v-if="running" class="elog__cursor">▌</div>
    </div>
  </div>
</template>

<style scoped>
.elog { border: 1px solid var(--sb-border); border-radius: 8px; background: var(--sb-bg-card); margin-top: var(--sb-space-3); }
.elog__head { display: flex; align-items: center; gap: var(--sb-space-2); padding: var(--sb-space-2) var(--sb-space-3); border-bottom: 1px solid var(--sb-border); }
.elog__head .spacer { flex: 1; }
.elog__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sb-text-secondary); }
.elog--running .elog__dot { background: #22c55e; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6); animation: elog-pulse 1.2s infinite; }
@keyframes elog-pulse { 0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6); } 70% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); } 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); } }
.elog__box { max-height: 260px; overflow: auto; padding: var(--sb-space-2) var(--sb-space-3); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
.elog__line { color: var(--sb-text-secondary); animation: elog-in 0.25s ease-out; }
.elog__line--stage { color: var(--sb-text-primary); font-weight: 600; }
.elog__line--changed { color: var(--sb-text-primary); }
.elog__line--warn { color: #b45309; }
.elog__line--fail { color: var(--sb-color-danger); }
.elog__ts { opacity: 0.55; margin-right: 8px; }
.elog__cursor { animation: elog-blink 1s steps(2) infinite; }
@keyframes elog-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes elog-blink { to { opacity: 0; } }
</style>
