<script setup lang="ts">
// modules/pcb-cam/ui/parts/LayerStack3D.vue
// 图层爆炸视图:所有层按板外形同一坐标系出图(frame=board),斜着拉成一摞;滚轮改层距,点一层飞到正面(压平),
// 再点回到爆炸。内外层对位一眼看全 —— 看的是「这个位置内层和外层对不对得上」,不是装饰。纯 CSS 3D,SVG 内联。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { apiPcbCamLayerSvg, errorMessage } from '../../../../src/api/client'
import { recolorSvg } from './svg-geo'

const props = defineProps<{ jobId: string; layers: Array<{ file: string; type: string }>; colorOf: (file: string, type: string) => string }>()

/** 层序:顶层字符 → 顶层阻焊 → 顶层线路 → 内层 1..n → 底层线路 → 底层阻焊 → 底层字符;外形放最底 */
const ORDER: Record<string, number> = { top_silk: 0, top_paste: 1, top_mask: 2, top_copper: 3, inner_copper: 4, bottom_copper: 90, bottom_mask: 91, bottom_paste: 92, bottom_silk: 93, outline: 99 }
const ordered = computed(() =>
  [...props.layers]
    .filter((l) => l.type in ORDER)
    .sort((a, b) => (ORDER[a.type] ?? 50) - (ORDER[b.type] ?? 50) || a.file.localeCompare(b.file))
    .slice(0, 16),
)
const svgQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'stack3d', props.jobId, ordered.value.map((l) => l.file).join('|')]),
  queryFn: async () => {
    const out = new Map<string, string>()
    let lastErr: unknown = null
    await Promise.all(ordered.value.map(async (l) => {
      try {
        out.set(l.file, recolorSvg(await apiPcbCamLayerSvg(props.jobId, l.file, 'board'), props.colorOf(l.file, l.type)))
      } catch (e) {
        lastErr = e // 一层画不出来不影响其他层
      }
    }))
    // 一层都没画出来(引擎刚重启 / 离线)当失败抛出去:别把空结果当成功缓存 5 分钟
    if (out.size === 0) throw lastErr instanceof Error ? lastErr : new Error('没有一层画出来')
    return out
  },
  enabled: computed(() => ordered.value.length > 0),
  staleTime: 5 * 60_000,
  retry: 1,
})
const gap = ref(28)
const tilt = ref(58)
const spin = ref(-24)
const focus = ref<string | null>(null)
const exploded = ref(false)
onMounted(() => setTimeout(() => (exploded.value = true), 60)) // 进场:从叠平到拉开
function onWheel(e: WheelEvent) {
  e.preventDefault()
  gap.value = Math.max(6, Math.min(80, gap.value + (e.deltaY > 0 ? 3 : -3)))
}
let dragging: { x: number; y: number; spin: number; tilt: number } | null = null
function onDown(e: PointerEvent) {
  dragging = { x: e.clientX, y: e.clientY, spin: spin.value, tilt: tilt.value }
}
function onMove(e: PointerEvent) {
  if (!dragging) return
  spin.value = dragging.spin + (e.clientX - dragging.x) * 0.4
  tilt.value = Math.max(0, Math.min(85, dragging.tilt - (e.clientY - dragging.y) * 0.3))
}
function onUp() {
  dragging = null
}
onBeforeUnmount(() => (dragging = null))
function styleOf(i: number, file: string) {
  const n = ordered.value.length
  const z = exploded.value ? (n / 2 - i) * gap.value : 0
  const isFocus = focus.value === file
  return {
    transform: `translateZ(${z}px)`,
    opacity: focus.value && !isFocus ? 0.12 : 1,
    zIndex: String(100 - i),
  }
}
const sceneStyle = computed(() => (focus.value ? { transform: 'rotateX(0deg) rotateZ(0deg)' } : { transform: `rotateX(${tilt.value}deg) rotateZ(${spin.value}deg)` }))
const label = (t: string) => ({ top_silk: '顶字符', top_paste: '顶锡膏', top_mask: '顶阻焊', top_copper: '顶层', inner_copper: '内层', bottom_copper: '底层', bottom_mask: '底阻焊', bottom_paste: '底锡膏', bottom_silk: '底字符', outline: '外形' })[t] ?? t
watch(() => props.jobId, () => (focus.value = null))
</script>

<template>
  <div class="stack3d">
    <div class="stack3d__bar">
      <span class="t-caption">{{ ordered.length }} 层 · 拖动旋转 · 滚轮改层距 · 点一层压平看它</span>
      <span class="spacer" />
      <el-slider v-model="gap" :min="6" :max="80" size="small" style="width: 140px" />
      <el-button v-if="focus" size="small" @click="focus = null">回到爆炸视图</el-button>
      <el-button size="small" @click="exploded = !exploded">{{ exploded ? '叠平' : '拉开' }}</el-button>
    </div>
    <div class="stack3d__viewport" @wheel="onWheel" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp">
      <p v-if="svgQuery.isLoading.value" class="t-caption stack3d__hint">正在取 {{ ordered.length }} 层的板图…</p>
      <p v-else-if="svgQuery.isError.value" class="t-caption stack3d__hint">板图没取到:{{ errorMessage(svgQuery.error.value) }} <el-button link type="primary" size="small" @click.stop="svgQuery.refetch()">重试</el-button></p>
      <div class="stack3d__scene" :style="sceneStyle">
        <!-- SVG 由本平台 pcb-worker 生成、经服务端代理,内联渲染以便改色与 3D 变换 -->
        <div
          v-for="(l, i) in ordered" :key="l.file" class="stack3d__layer" :class="{ 'stack3d__layer--focus': focus === l.file }"
          :style="styleOf(i, l.file)" @click.stop="focus = focus === l.file ? null : l.file"
        >
          <div class="stack3d__svg" v-html="svgQuery.data.value?.get(l.file) ?? ''" />
          <span class="stack3d__tag" :style="{ background: colorOf(l.file, l.type) }">{{ label(l.type) }}<i>{{ l.file }}</i></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stack3d { display: flex; flex-direction: column; gap: var(--sb-space-2); }
.stack3d__bar { display: flex; align-items: center; gap: var(--sb-space-2); }
.stack3d__bar .spacer { flex: 1; }
.stack3d__viewport { position: relative; height: min(64vh, 640px); border: 1px solid var(--sb-border); border-radius: 8px; background: radial-gradient(ellipse at center, var(--sb-bg-card) 0%, var(--sb-bg-page, var(--sb-bg-card)) 100%); perspective: 1400px; overflow: hidden; cursor: grab; user-select: none; touch-action: none; }
.stack3d__viewport:active { cursor: grabbing; }
.stack3d__hint { position: absolute; top: 8px; left: 12px; z-index: 200; }
.stack3d__scene { position: absolute; inset: 0; transform-style: preserve-3d; transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1); }
.stack3d__layer { position: absolute; inset: 8%; transform-style: preserve-3d; transition: transform 0.7s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.4s; cursor: pointer; }
.stack3d__svg { position: absolute; inset: 0; background: rgba(127, 127, 127, 0.06); border: 1px solid rgba(127, 127, 127, 0.35); border-radius: 4px; backface-visibility: visible; }
.stack3d__layer--focus .stack3d__svg { border-color: var(--sb-color-primary); box-shadow: 0 0 0 2px var(--sb-color-primary); }
.stack3d__svg :deep(svg) { width: 100%; height: 100%; display: block; }
.stack3d__tag { position: absolute; left: -2px; top: -22px; padding: 1px 8px; border-radius: 4px; color: #fff; font-size: 11px; white-space: nowrap; }
.stack3d__tag i { font-style: normal; opacity: 0.8; margin-left: 6px; }
</style>
