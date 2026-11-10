<template>
  <section class="async-page-state" role="status" aria-live="polite" aria-label="页面加载中">
    <span class="async-page-state__spinner" aria-hidden="true" />
    <span>页面加载中…</span>
  </section>
</template>

<style scoped>
.async-page-state {
  display: flex;
  min-height: 240px;
  align-items: center;
  justify-content: center;
  gap: var(--sb-space-3);
  color: var(--sb-text-secondary);
  font-size: var(--sb-font-sm);
}

.async-page-state__spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--sb-border-strong);
  border-top-color: var(--sb-color-primary);
  border-radius: 50%;
  animation: async-page-spin 0.8s linear infinite;
}

@keyframes async-page-spin {
  to { transform: rotate(360deg); }
}
</style>
