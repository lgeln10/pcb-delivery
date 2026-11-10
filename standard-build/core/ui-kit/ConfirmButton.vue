<script setup lang="ts">
// ★破坏性操作二次确认组件(质量红线:删除/清空/不可逆变更必须二次确认)。
// 用法:删除类按钮一律用它,点击后在「浮层」里展开确认条,点「确认」才 emit('confirm')。
// 不确认绝不触发,AI 用组件就不会漏二次确认。
// ★浮层而非行内展开:确认条用 el-popover 渲染到 body(teleport),
//   不挤占原位 → 在表格行内点击不会把行/表格撑高(布局位移红线,见 UI_SPEC §3)。
import { ref } from 'vue'

withDefaults(
  defineProps<{
    /** 按钮文案,如「删除」 */
    label: string
    /** 确认提示文案 */
    confirmText?: string
    disabled?: boolean
    /** 禁用原因:disabled 时作为 title 悬浮解释,避免"点不动又不知为何"(交互红线) */
    disabledReason?: string
    /** 文字/链接样式:用于表格操作列,与 <el-button text> 兄弟按钮对齐(无边框、紧凑、不挤占列宽) */
    text?: boolean
    /** 纯图标模式:传入图标组件(如 lucide Trash2)→ trigger 只显图标,label 作悬浮提示;确认浮层文案不变 */
    icon?: unknown
    /** 尺寸:与同排 el-button 的 size 对齐(如批量操作栏用 size="small",避免高度参差) */
    size?: 'default' | 'small'
  }>(),
  { confirmText: '此操作不可撤销,确认执行?', size: 'default' },
)
const emit = defineEmits<{ confirm: [] }>()

const visible = ref(false)

function onConfirm() {
  visible.value = false
  emit('confirm')
}
</script>

<template>
  <span class="sb-confirm">
    <el-popover
      v-model:visible="visible"
      trigger="click"
      :disabled="disabled"
      placement="top-end"
      :width="260"
      popper-class="sb-confirm-popper"
    >
      <template #reference>
        <button
          type="button"
          class="sb-confirm__trigger"
          :class="{ 'sb-confirm__trigger--text': text, 'sb-confirm__trigger--icon': !!icon, 'sb-confirm__trigger--small': size === 'small' }"
          :disabled="disabled"
          :title="disabled ? disabledReason : (icon ? label : undefined)"
          :aria-label="icon ? label : undefined"
          :aria-disabled="disabled"
        >
          <component :is="icon" v-if="icon" :size="16" />
          <template v-else>{{ label }}</template>
        </button>
      </template>
      <div class="sb-confirm__pop" role="alertdialog">
        <p class="sb-confirm__text">{{ confirmText }}</p>
        <div class="sb-confirm__actions">
          <button type="button" class="sb-confirm__no" @click="visible = false">取消</button>
          <button type="button" class="sb-confirm__yes" @click="onConfirm">确认</button>
        </div>
      </div>
    </el-popover>
  </span>
</template>

<style scoped>
/* 与其它按钮(el-button default)统一外观:同高、同圆角、中性边框、单行不换行;
   仅用红色文字保留「危险」语义,hover 时浮现 danger 软底(不再是整块红框)。 */
.sb-confirm__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--el-component-size);
  padding: 0 var(--sb-space-4);
  border: 1px solid var(--sb-border-strong);
  border-radius: var(--sb-radius-sm);
  background: var(--sb-bg-card);
  color: var(--sb-color-danger);
  font-size: var(--sb-font-md);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.sb-confirm__trigger:hover:not(:disabled) {
  border-color: var(--sb-color-danger);
  background: var(--sb-color-danger-soft);
  color: var(--sb-color-danger-hover);
}
/* 小尺寸:与同排 el-button size="small" 对齐(同高、更紧的内边距、略小字号) */
.sb-confirm__trigger--small {
  height: var(--el-component-size-small);
  padding: 0 var(--sb-space-3);
  font-size: var(--sb-font-sm);
}
/* 文字样式:表格操作列用,与 el-button text 对齐(无边框/透明底/紧凑) */
.sb-confirm__trigger--text {
  padding: 0 var(--sb-space-2);
  border-color: transparent;
  background: transparent;
}
.sb-confirm__trigger--text:hover:not(:disabled) {
  border-color: transparent;
  background: var(--sb-color-danger-soft);
  color: var(--sb-color-danger-hover);
}
/* 纯图标模式:方形、紧凑、无边框透明底(与操作列里 el-button text 图标按钮对齐)*/
.sb-confirm__trigger--icon {
  width: var(--el-component-size);
  padding: 0;
  border-color: transparent;
  background: transparent;
}
.sb-confirm__trigger--icon:hover:not(:disabled) {
  border-color: transparent;
  background: var(--sb-color-danger-soft);
  color: var(--sb-color-danger-hover);
}
.sb-confirm__trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* 确认浮层内容(渲染到 body,不占原位 → 不撑高表格行)*/
.sb-confirm__pop {
  display: grid;
  gap: var(--sb-space-3);
}
.sb-confirm__text {
  margin: 0;
  font-size: var(--sb-font-sm);
  line-height: var(--sb-leading-normal);
  color: var(--sb-text-primary);
}
.sb-confirm__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sb-space-2);
}
.sb-confirm__yes {
  padding: var(--sb-space-1) var(--sb-space-3);
  border: none;
  border-radius: var(--sb-radius-sm);
  background: var(--sb-color-danger);
  color: var(--sb-text-inverse);
  cursor: pointer;
}
.sb-confirm__yes:hover {
  background: var(--sb-color-danger-hover);
}
.sb-confirm__no {
  padding: var(--sb-space-1) var(--sb-space-3);
  border: 1px solid var(--sb-border-strong);
  border-radius: var(--sb-radius-sm);
  background: var(--sb-bg-card);
  color: var(--sb-text-secondary);
  cursor: pointer;
}
</style>
