<script setup lang="ts">
// Vue 会把异步加载错误作为 error prop 传入；显式接收但绝不渲染，避免错误细节落入 DOM。
defineProps<{ error?: unknown }>()

function reloadPage() {
  window.location.reload()
}
</script>

<template>
  <section class="async-page-error" role="alert">
    <span class="async-page-error__icon" aria-hidden="true">!</span>
    <h2>页面加载失败</h2>
    <p>请检查网络连接后重新加载页面。</p>
    <button type="button" @click="reloadPage">重新加载</button>
  </section>
</template>

<style scoped>
.async-page-error {
  display: flex;
  min-height: 240px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sb-space-2);
  color: var(--sb-text-secondary);
  text-align: center;
}

.async-page-error__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: var(--sb-color-danger-soft);
  color: var(--sb-color-danger);
  font-weight: 700;
}

h2, p { margin: 0; }
h2 { color: var(--sb-text-primary); font-size: var(--sb-font-lg); }
p { font-size: var(--sb-font-sm); }
button {
  margin-top: var(--sb-space-2);
  padding: var(--sb-space-2) var(--sb-space-4);
  border: 1px solid var(--sb-border-strong);
  border-radius: var(--sb-radius-sm);
  background: var(--sb-bg-card);
  color: var(--sb-text-primary);
  cursor: pointer;
}
button:hover { background: var(--sb-bg-hover); }
</style>
