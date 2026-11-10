<script setup lang="ts">
// ★五态组件(质量红线:每个数据视图必须处理 加载/错误/无权限/空/成功)。
// 用法:数据视图一律包在 <AsyncState> 里,五态自动齐全,AI 用组件就不会漏。
// 优先级:loading > error > forbidden > empty > 成功(默认插槽)。
// 默认态已是合格视觉:loading=骨架屏,empty=居中图标+引导文案+可选主操作(empty-action 插槽)。
// 每个状态都可用同名插槽覆写。
withDefaults(
  defineProps<{
    loading?: boolean
    /** 错误信息(给人看的文案,不是堆栈) */
    error?: string | null
    forbidden?: boolean
    empty?: boolean
    /** 骨架行数 */
    loadingRows?: number
    /** 空状态主标题/提示 */
    emptyTitle?: string
    emptyHint?: string
  }>(),
  { loadingRows: 4, emptyTitle: '暂无数据', emptyHint: '' },
)
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="loading" class="sb-state sb-state--loading" role="status" aria-busy="true">
    <slot name="loading">
      <div class="sb-skeleton">
        <div
          v-for="row in loadingRows"
          :key="row"
          class="sb-skeleton__row"
          :style="{ width: row === loadingRows ? '60%' : '100%' }"
        />
      </div>
    </slot>
  </div>

  <div v-else-if="error" class="sb-state sb-state--error" role="alert">
    <slot name="error" :message="error">
      <div class="sb-empty">
        <span class="sb-empty__icon sb-empty__icon--error">!</span>
        <span class="sb-empty__title">加载失败</span>
        <span class="sb-empty__hint">{{ error }}</span>
        <button type="button" class="sb-state__retry" @click="$emit('retry')">重试</button>
      </div>
    </slot>
  </div>

  <div v-else-if="forbidden" class="sb-state sb-state--forbidden">
    <slot name="forbidden">
      <div class="sb-empty">
        <span class="sb-empty__icon">🔒</span>
        <span class="sb-empty__title">无权限查看</span>
        <span class="sb-empty__hint">该数据需要更高的访问权限,请联系管理员</span>
      </div>
    </slot>
  </div>

  <div v-else-if="empty" class="sb-state sb-state--empty">
    <slot name="empty">
      <div class="sb-empty">
        <span class="sb-empty__icon">∅</span>
        <span class="sb-empty__title">{{ emptyTitle }}</span>
        <span v-if="emptyHint" class="sb-empty__hint">{{ emptyHint }}</span>
        <slot name="empty-action" />
      </div>
    </slot>
  </div>

  <slot v-else />
</template>

<style scoped>
.sb-state--loading {
  padding: var(--sb-space-2) 0;
}
.sb-empty__icon--error {
  background: var(--sb-color-danger-soft);
  color: var(--sb-color-danger);
  font-weight: 700;
}
.sb-state__retry {
  margin-top: var(--sb-space-1);
  padding: var(--sb-space-1) var(--sb-space-4);
  border: 1px solid var(--sb-border-strong);
  border-radius: var(--sb-radius-sm);
  background: var(--sb-bg-card);
  color: var(--sb-text-primary);
  cursor: pointer;
}
.sb-state__retry:hover {
  background: var(--sb-bg-hover);
}
</style>
