<script setup lang="ts">
// modules/pcb-cam/ui/parts/DiffMinimap.vue
// 差异热力小地图:缩略板上按簇面积铺热度,点哪跳哪(选中最近的簇)。多层板找问题比翻清单快。
// 画在 canvas 上:簇数上千也不卡。坐标 = 板坐标 mm(y 向上)。
import { onMounted, ref, watch } from 'vue'
import type { PcbCamCompareCluster } from '../../../../src/api/client'

const props = defineProps<{ clusters: PcbCamCompareCluster[]; frame: { x: number; y: number; w: number; h: number } | null; selected: number | null }>()
const emit = defineEmits<{ (e: 'select', id: number): void }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const W = 260
const H = 180

function toPx(x: number, y: number, f: { x: number; y: number; w: number; h: number }) {
  // frame 是 SVG viewBox(y 已翻:y = -y1);板坐标 y 向上 → 像素 y 向下
  const s = Math.min((W - 8) / f.w, (H - 8) / f.h)
  const ox = (W - f.w * s) / 2
  const oy = (H - f.h * s) / 2
  return { px: ox + (x - f.x) * s, py: oy + (-y - f.y) * s, s }
}
function draw() {
  const c = canvas.value
  const f = props.frame
  if (!c || !f) return
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  const { px: bx, py: by, s } = toPx(f.x, -f.y, f)
  ctx.fillStyle = 'rgba(127,127,127,0.10)'
  ctx.strokeStyle = 'rgba(127,127,127,0.6)'
  ctx.lineWidth = 1
  ctx.fillRect(bx, by, f.w * s, f.h * s)
  ctx.strokeRect(bx, by, f.w * s, f.h * s)
  const maxA = Math.max(0.01, ...props.clusters.map((k) => k.area_mm2))
  ctx.globalCompositeOperation = 'lighter'
  for (const k of props.clusters) {
    const { px, py } = toPx(k.at[0], k.at[1], f)
    const r = 6 + 22 * Math.sqrt(k.area_mm2 / maxA)
    const g = ctx.createRadialGradient(px, py, 0, px, py, r)
    const col = k.direction === 'missing' ? '220,38,38' : k.direction === 'extra' ? '37,99,235' : '168,85,247'
    g.addColorStop(0, `rgba(${col},0.75)`)
    g.addColorStop(1, `rgba(${col},0)`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(px, py, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  if (props.selected !== null) {
    const k = props.clusters.find((x) => x.id === props.selected)
    if (k) {
      const { px, py } = toPx(k.at[0], k.at[1], f)
      ctx.strokeStyle = '#f59e0b'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(px, py, 9, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}
function onClick(e: MouseEvent) {
  const c = canvas.value
  const f = props.frame
  if (!c || !f || !props.clusters.length) return
  const r = c.getBoundingClientRect()
  const mx = ((e.clientX - r.left) / r.width) * W
  const my = ((e.clientY - r.top) / r.height) * H
  let best: { id: number; d: number } | null = null
  for (const k of props.clusters) {
    const { px, py } = toPx(k.at[0], k.at[1], f)
    const d = (px - mx) ** 2 + (py - my) ** 2
    if (!best || d < best.d) best = { id: k.id, d }
  }
  if (best) emit('select', best.id)
}
onMounted(draw)
watch(() => [props.clusters, props.frame, props.selected], draw, { deep: true })
</script>

<template>
  <div class="minimap">
    <canvas ref="canvas" :width="W" :height="H" class="minimap__c" title="差异热力:点哪跳哪" @click="onClick" />
    <p class="t-caption minimap__cap">热力 = 差异簇面积 · <i style="color:#dc2626">少了</i> <i style="color:#2563eb">多了</i> <i style="color:#a855f7">改了</i></p>
  </div>
</template>

<style scoped>
.minimap { display: flex; flex-direction: column; gap: 2px; }
.minimap__c { width: 100%; max-width: 260px; aspect-ratio: 260 / 180; border: 1px solid var(--sb-border); border-radius: 6px; background: var(--sb-bg-card); cursor: crosshair; }
.minimap__cap { margin: 0; }
.minimap__cap i { font-style: normal; }
</style>
