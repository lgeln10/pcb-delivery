<script setup lang="ts">
// modules/pcb-cam/ui/parts/TimeScrub.vue
// 时间轴刷写:一根滑块从客户原稿拖到生产稿,一个改过图的 stage 一帧;当前帧实色、上一帧红色垫底(改动的地方一眼跳出来),
// 右边列出这一帧改了什么(op / 层 / +−~),走到哪一帧亮哪一行。帧来自 worker steps/history/<stage>/;
// 没改过图的 stage 不占帧。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { apiPcbCamHistory, apiPcbCamLayerSvg, type PcbCamStage } from '../../../../src/api/client'
import { opLabel } from '../labels'
import { recolorSvg } from './svg-geo'

const props = defineProps<{ jobId: string; layer: string; layers: string[]; stageLabel: (s: string) => string; color: string }>()
const emit = defineEmits<{ (e: 'update:layer', v: string): void }>()

const historyQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'history', props.jobId]),
  queryFn: () => apiPcbCamHistory(props.jobId),
  staleTime: 60_000,
})
const frames = computed(() => historyQuery.data.value?.frames.filter((f) => !f.panel) ?? [])
const changedLayers = computed(() => Object.keys(historyQuery.data.value?.by_layer ?? {}))
// 当前层一定要在选项里:帧清单比下拉晚到时,值匹配不到任何 option,el-select 会显示成空白
const otherLayers = computed(() => [...new Set([props.layer, ...props.layers])].filter((f) => f && !changedLayers.value.includes(f)))
const idx = ref(0)
watch(frames, (f) => (idx.value = Math.max(0, f.length - 1)), { immediate: true })
const frame = computed(() => frames.value[idx.value] ?? null)
const prevFrame = computed(() => (idx.value > 0 ? frames.value[idx.value - 1] ?? null : null))
const revOf = (stage: string) => (stage === 'orig' ? 'orig' : (stage as PcbCamStage))

function useFrameSvg(getStage: () => string | null, tag: string) {
  return useQuery({
    queryKey: computed(() => ['pcb-cam', 'scrub', tag, props.jobId, props.layer, getStage() ?? '']),
    queryFn: async () => {
      const st = getStage()!
      const svg = await apiPcbCamLayerSvg(props.jobId, props.layer, 'board', revOf(st))
      return recolorSvg(svg, tag === 'cur' ? props.color : '#dc2626')
    },
    enabled: computed(() => Boolean(props.jobId && props.layer && getStage())),
    staleTime: 5 * 60_000,
  })
}
const curSvg = useFrameSvg(() => frame.value?.stage ?? null, 'cur')
const prevSvg = useFrameSvg(() => prevFrame.value?.stage ?? null, 'prev')

const ops = computed(() => (frame.value?.ops ?? []).map((o) => ({ ...o, mine: o.layer === props.layer })).sort((a, b) => Number(b.mine) - Number(a.mine) || a.n - b.n))
const layerTouched = computed(() => Boolean(frame.value?.layers.includes(props.layer)))
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
function togglePlay() {
  playing.value = !playing.value
  if (timer) clearInterval(timer)
  if (playing.value) {
    if (idx.value >= frames.value.length - 1) idx.value = 0
    timer = setInterval(() => {
      if (idx.value >= frames.value.length - 1) {
        playing.value = false
        if (timer) clearInterval(timer)
        return
      }
      idx.value += 1
    }, 1400)
  }
}
onBeforeUnmount(() => timer && clearInterval(timer))
const ghost = ref(true)
const marks = computed(() => Object.fromEntries(frames.value.map((f, i) => [i, f.stage === 'orig' ? '原稿' : props.stageLabel(f.stage)])))
</script>

<template>
  <div class="scrub">
    <div class="scrub__bar">
      <el-select :model-value="layer" size="small" filterable style="width: 240px" @update:model-value="(v: string) => emit('update:layer', v)">
        <el-option-group label="改过图的层">
          <el-option v-for="f in changedLayers" :key="f" :label="f" :value="f" />
        </el-option-group>
        <el-option-group v-if="otherLayers.length" label="其他层(这次没改过)">
          <el-option v-for="f in otherLayers" :key="f" :label="f" :value="f" />
        </el-option-group>
      </el-select>
      <el-button size="small" :disabled="frames.length < 2" @click="togglePlay">{{ playing ? '暂停' : '▶ 播放' }}</el-button>
      <el-checkbox v-model="ghost" size="small">上一帧垫底(红)</el-checkbox>
      <span class="spacer" />
      <span class="t-caption">{{ frame ? (frame.stage === 'orig' ? '客户原稿' : `${stageLabel(frame.stage)} 之后`) : '' }}{{ frame && frame.stage !== 'orig' && !layerTouched ? ' · 这一步没动本层' : '' }}</span>
    </div>
    <div class="scrub__slider">
      <el-slider v-model="idx" :min="0" :max="Math.max(0, frames.length - 1)" :step="1" :marks="marks" :show-tooltip="false" :disabled="frames.length < 2" />
    </div>
    <div class="scrub__body">
      <div class="scrub__stage">
        <p v-if="historyQuery.isLoading.value" class="t-caption">正在取改图记录…</p>
        <p v-else-if="frames.length < 2" class="t-caption">这块板本地引擎还没改过图(或引擎不是 native):没有可回放的帧</p>
        <!-- SVG 由本平台 pcb-worker 生成、经服务端代理;两帧内联叠放 -->
        <div v-else class="scrub__stack">
          <div v-if="ghost && prevSvg.data.value" class="scrub__layer scrub__layer--prev" v-html="prevSvg.data.value" />
          <div class="scrub__layer" v-html="curSvg.data.value ?? ''" />
          <div v-if="curSvg.isFetching.value" class="scrub__loading t-caption">取帧…</div>
        </div>
      </div>
      <div class="scrub__ops">
        <h5 class="t-subtitle">这一帧改了什么<span class="t-caption">({{ ops.length }})</span></h5>
        <p v-if="!ops.length" class="t-caption">{{ frame?.stage === 'orig' ? '客户给来的样子,还没动' : '无' }}</p>
        <ul v-else class="scrub__oplist">
          <li v-for="o in ops" :key="o.key" :class="{ 'scrub__op--mine': o.mine }">
            <b>{{ opLabel(o.op) }}</b><span class="t-caption"> {{ o.layer }}</span>
            <span class="scrub__cnt">+{{ o.added }} −{{ o.deleted }} ~{{ o.modified }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrub { display: flex; flex-direction: column; gap: var(--sb-space-2); }
.scrub__bar { display: flex; align-items: center; gap: var(--sb-space-2); flex-wrap: wrap; }
.scrub__bar .spacer { flex: 1; }
.scrub__slider { padding: 0 var(--sb-space-4) var(--sb-space-4); }
.scrub__body { display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, 1fr); gap: var(--sb-space-3); }
@media (max-width: 900px) { .scrub__body { grid-template-columns: 1fr; } }
.scrub__stage { min-height: 320px; }
.scrub__stack { position: relative; height: min(60vh, 600px); border: 1px solid var(--sb-border); border-radius: 8px; background: var(--sb-bg-card); overflow: hidden; }
.scrub__layer { position: absolute; inset: 0; }
.scrub__layer :deep(svg) { width: 100%; height: 100%; display: block; }
.scrub__layer--prev { opacity: 0.55; }
.scrub__loading { position: absolute; right: 8px; top: 6px; }
.scrub__ops { border: 1px solid var(--sb-border); border-radius: 8px; padding: var(--sb-space-3); max-height: min(60vh, 600px); overflow: auto; }
.scrub__oplist { list-style: none; margin: 0; padding: 0; }
.scrub__oplist li { padding: 4px 6px; border-radius: 4px; display: flex; gap: 6px; align-items: baseline; opacity: 0.55; }
.scrub__op--mine { opacity: 1 !important; background: var(--sb-color-primary-soft); background: color-mix(in srgb, var(--sb-color-primary) 10%, transparent); }
.scrub__cnt { margin-left: auto; font-family: ui-monospace, monospace; font-size: 12px; }
</style>
