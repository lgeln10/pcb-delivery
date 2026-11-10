<script setup lang="ts">
// modules/pcb-cam/ui/parts/CurtainCompare.vue
// 终稿对比的「拉帘」:一根可拖的竖线,左边我们的(+原稿)、右边工程师终稿,鼠标到哪擦到哪;再配一个跟手的放大镜。
// 比调透明度直观:两张图从不叠在一起,眼睛不用分色。两份 SVG 同一 viewBox,靠 clip-path 切。
import { computed, ref } from 'vue'

const props = defineProps<{ svg: string; stageClass: Record<string, boolean>; stageStyle: Record<string, string>; showHoles?: boolean }>()
const pos = ref(50) // 帘子位置 %
const lens = ref(false)
const lensPos = ref({ x: 0, y: 0, on: false })
const ZOOM = 4
const box = ref<HTMLElement | null>(null)
let dragging = false
function setPos(clientX: number) {
  const r = box.value?.getBoundingClientRect()
  if (!r) return
  pos.value = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100))
}
function onDown(e: PointerEvent) {
  dragging = true
  setPos(e.clientX)
}
function onMove(e: PointerEvent) {
  if (dragging) setPos(e.clientX)
  const r = box.value?.getBoundingClientRect()
  if (r) lensPos.value = { x: e.clientX - r.left, y: e.clientY - r.top, on: true }
}
function onUp() {
  dragging = false
}
const leftClass = computed(() => ({ ...props.stageClass, 'cmp-hide-gold': true, 'cmp-hide-missing': true, 'cmp-hide-extra': true }))
const rightClass = computed(() => ({ ...props.stageClass, 'cmp-hide-ours': true, 'cmp-hide-orig': true, 'cmp-hide-missing': true, 'cmp-hide-extra': true, 'cmp-hide-boxes': true }))
const rightStyle = computed(() => ({ ...props.stageStyle, clipPath: `inset(0 0 0 ${pos.value}%)` }))
/** 放大镜里显示原始叠加图(全部图层),中心对准鼠标:内容按 ZOOM 放大并反向平移 */
const lensStyle = computed(() => {
  const r = box.value?.getBoundingClientRect()
  const w = r?.width ?? 1
  const h = r?.height ?? 1
  return { width: `${w * ZOOM}px`, height: `${h * ZOOM}px`, transform: `translate(${-lensPos.value.x * ZOOM + 90}px, ${-lensPos.value.y * ZOOM + 90}px)` }
})
const lensWrap = computed(() => ({ left: `${lensPos.value.x - 90}px`, top: `${lensPos.value.y - 90}px` }))
</script>

<template>
  <div class="curtain-wrap">
    <div class="curtain__bar">
      <span class="t-caption">◀ 我们的(+原稿) · 拖动帘子 · 终稿 ▶</span>
      <span class="spacer" />
      <el-checkbox v-model="lens" size="small">放大镜 ×{{ ZOOM }}</el-checkbox>
    </div>
    <div ref="box" class="curtain" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="() => { onUp(); lensPos.on = false }">
      <!-- SVG 来自本平台 pcb-worker、经服务端代理;两份内联,右边用 clip-path 切 -->
      <div class="curtain__side" :class="leftClass" :style="stageStyle" v-html="svg" />
      <div class="curtain__side curtain__side--right" :class="rightClass" :style="rightStyle" v-html="svg" />
      <div class="curtain__line" :style="{ left: `${pos}%` }"><span class="curtain__knob">⇔</span></div>
      <span class="curtain__label curtain__label--l">我们的</span>
      <span class="curtain__label curtain__label--r">终稿</span>
      <div v-if="lens && lensPos.on" class="curtain__lens" :style="lensWrap">
        <div class="curtain__lens-inner" :class="stageClass" :style="lensStyle" v-html="svg" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.curtain-wrap { display: flex; flex-direction: column; gap: 6px; }
.curtain__bar { display: flex; align-items: center; gap: var(--sb-space-2); }
.curtain__bar .spacer { flex: 1; }
.curtain { position: relative; height: min(60vh, 600px); border: 1px solid var(--sb-border); border-radius: 8px; background: var(--sb-bg-card); overflow: hidden; cursor: col-resize; user-select: none; touch-action: none; }
.curtain__side { position: absolute; inset: 0; }
.curtain__side :deep(svg) { width: 100%; height: 100%; display: block; }
.curtain__side :deep(.cmp-ours) { opacity: var(--cmp-ours-opacity, 0.35); }
.curtain__side--right :deep(.cmp-gold) { opacity: 1; }
.curtain__side.cmp-hide-gold :deep(.cmp-gold), .curtain__side.cmp-hide-orig :deep(.cmp-orig), .curtain__side.cmp-hide-ours :deep(.cmp-ours), .curtain__side.cmp-hide-missing :deep(.cmp-missing), .curtain__side.cmp-hide-extra :deep(.cmp-extra), .curtain__side.cmp-hide-boxes :deep(.cmp-clusters) { display: none; }
.curtain__side :deep(.cmp-cluster) { stroke: #dc2626; stroke-width: 1.5; }
.curtain__side :deep(.cmp-cluster--extra) { stroke: #2563eb; }
.curtain__side :deep(.cmp-cluster--selected) { stroke: #f59e0b; stroke-width: 3; }
.curtain__line { position: absolute; top: 0; bottom: 0; width: 2px; background: #f59e0b; box-shadow: 0 0 6px rgba(245, 158, 11, 0.8); pointer-events: none; }
.curtain__knob { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 28px; height: 28px; border-radius: 50%; background: #f59e0b; color: #111; display: flex; align-items: center; justify-content: center; font-size: 14px; }
.curtain__label { position: absolute; top: 8px; font-size: 11px; padding: 1px 8px; border-radius: 4px; background: rgba(0, 0, 0, 0.55); color: #fff; pointer-events: none; }
.curtain__label--l { left: 8px; }
.curtain__label--r { right: 8px; }
.curtain__lens { position: absolute; width: 180px; height: 180px; border-radius: 50%; overflow: hidden; border: 2px solid #f59e0b; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35); pointer-events: none; background: var(--sb-bg-card); }
.curtain__lens-inner { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.curtain__lens-inner :deep(svg) { width: 100%; height: 100%; display: block; }
.curtain__lens-inner :deep(.cmp-ours) { opacity: var(--cmp-ours-opacity, 0.35); }
.curtain__lens-inner.cmp-hide-gold :deep(.cmp-gold), .curtain__lens-inner.cmp-hide-orig :deep(.cmp-orig), .curtain__lens-inner.cmp-hide-ours :deep(.cmp-ours), .curtain__lens-inner.cmp-hide-missing :deep(.cmp-missing), .curtain__lens-inner.cmp-hide-extra :deep(.cmp-extra), .curtain__lens-inner.cmp-hide-boxes :deep(.cmp-clusters) { display: none; }
</style>
