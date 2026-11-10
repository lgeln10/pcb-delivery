<script setup lang="ts">
// modules/pcb-cam/ui/parts/AskBoard.vue
// 自然语言查板:「把内层小于 4mil 的线标出来」「这块板哪里改动最多」→ 后端翻成结构化查询 → worker 实测 → 一句回答 +
// 图上的框(父组件叠到板图上)。答案永远来自几何引擎,模型只负责翻译。
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiPcbCamAsk, errorMessage, type PcbCamAskResult, type PcbCamQueryHit } from '../../../../src/api/client'

const props = defineProps<{ jobId: string }>()
const emit = defineEmits<{ (e: 'hits', hits: PcbCamQueryHit[], byLayer: Record<string, number>): void; (e: 'clear'): void }>()

const q = ref('')
const busy = ref(false)
const last = ref<PcbCamAskResult | null>(null)
const EXAMPLES = ['内层小于 4mil 的线', '顶层大于 2mm 的焊盘', '这块板哪里改动最多', '阻焊改了什么']
async function ask(text?: string) {
  const question = (text ?? q.value).trim()
  if (!question || busy.value) return
  q.value = question
  busy.value = true
  try {
    const r = await apiPcbCamAsk(props.jobId, question)
    last.value = r
    if (r.ok && r.result) emit('hits', r.result.hits, r.result.by_layer)
    else emit('clear')
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    busy.value = false
  }
}
function clear() {
  last.value = null
  q.value = ''
  emit('clear')
}
</script>

<template>
  <div class="ask">
    <div class="ask__row">
      <el-input v-model="q" size="small" placeholder="问这块板:内层小于 4mil 的线 / 哪里改动最多 …" clearable @keydown.enter.prevent="ask()" @clear="clear">
        <template #prefix><span class="ask__spark">✦</span></template>
      </el-input>
      <el-button size="small" type="primary" :loading="busy" @click="ask()">问</el-button>
      <el-button v-if="last" size="small" @click="clear">清除标记</el-button>
    </div>
    <div v-if="!last" class="ask__examples">
      <span v-for="e in EXAMPLES" :key="e" class="ask__chip" @click="ask(e)">{{ e }}</span>
    </div>
    <p v-else class="ask__answer" :class="{ 'ask__answer--no': !last.ok }">
      {{ last.answer }}<span v-if="last.via" class="t-caption"> · {{ last.via === 'rules' ? '规则翻译' : '模型翻译' }}</span>
    </p>
  </div>
</template>

<style scoped>
.ask { display: flex; flex-direction: column; gap: 6px; margin: var(--sb-space-2) 0; }
.ask__row { display: flex; gap: var(--sb-space-2); align-items: center; }
.ask__row .el-input { flex: 1; }
.ask__spark { color: var(--sb-color-primary); }
.ask__examples { display: flex; gap: 6px; flex-wrap: wrap; }
.ask__chip { font-size: 12px; padding: 2px 10px; border: 1px dashed var(--sb-border); border-radius: 999px; cursor: pointer; color: var(--sb-text-secondary); }
.ask__chip:hover { border-color: var(--sb-color-primary); color: var(--sb-color-primary); }
.ask__answer { margin: 0; font-size: 13px; }
.ask__answer--no { color: var(--sb-text-secondary); }
</style>
