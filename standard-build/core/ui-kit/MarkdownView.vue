<script setup lang="ts">
// core/ui-kit/MarkdownView.vue
// ★2026-08-21 从 modules/superindividual/ui/ 挪到这里:它早已被 6 个模块跨模块 import
//   (askai / im-connect / digitalemployee / news / aiagent,现在再加站内信),
//   而跨模块直接 import 别人的 ui 是本仓明令禁止的。共享组件的正确落点就是 ui-kit(同 FilePreview)。
// 把 markdown 文本渲染成安全 HTML（marked 解析 + DOMPurify 消毒）。
// agent 产出是不可信内容，必须经 DOMPurify 才能 v-html，避免 XSS。
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ source: string | null | undefined }>()

const html = computed(() => {
  const src = (props.source ?? '').toString()
  if (!src.trim()) return ''
  const raw = marked.parse(src, { gfm: true, breaks: true }) as string
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'rel'] })
})
</script>

<template>
  <div class="md" v-html="html" />
</template>

<style scoped>
.md { font-size: var(--sb-font-sm); color: var(--sb-text-primary); line-height: 1.7; word-break: break-word; }
.md :deep(> *:first-child) { margin-top: 0; }
.md :deep(> *:last-child) { margin-bottom: 0; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4) {
  margin: var(--sb-space-4) 0 var(--sb-space-2); font-weight: 700; color: var(--sb-text-primary); line-height: 1.3;
}
.md :deep(h1) { font-size: var(--sb-font-xl); }
.md :deep(h2) { font-size: var(--sb-font-lg); }
.md :deep(h3) { font-size: var(--sb-font-md); }
.md :deep(h4) { font-size: var(--sb-font-sm); }
.md :deep(p) { margin: var(--sb-space-2) 0; }
.md :deep(ul), .md :deep(ol) { margin: var(--sb-space-2) 0; padding-left: 1.4em; }
.md :deep(li) { margin: 2px 0; }
.md :deep(li > p) { margin: 0; }
.md :deep(strong) { font-weight: 700; color: var(--sb-text-primary); }
.md :deep(em) { font-style: italic; }
.md :deep(a) { color: var(--sb-color-primary); text-decoration: none; }
.md :deep(a:hover) { text-decoration: underline; }
.md :deep(hr) { border: 0; border-top: 1px solid var(--sb-border); margin: var(--sb-space-3) 0; }
.md :deep(blockquote) {
  margin: var(--sb-space-2) 0; padding: var(--sb-space-1) var(--sb-space-3);
  border-left: 3px solid var(--sb-border-strong); color: var(--sb-text-secondary);
}
.md :deep(code) {
  font-family: var(--sb-font-mono); font-size: 0.92em;
  background: var(--sb-bg-subtle); padding: 1px 5px; border-radius: var(--sb-radius-sm);
}
.md :deep(pre) {
  margin: var(--sb-space-2) 0; padding: var(--sb-space-3); border-radius: var(--sb-radius-md);
  background: var(--sb-term-bg); color: var(--sb-term-fg); overflow-x: auto;
}
.md :deep(pre code) { background: none; padding: 0; color: inherit; }
.md :deep(table) { width: 100%; border-collapse: collapse; margin: var(--sb-space-2) 0; font-size: var(--sb-font-xs); }
.md :deep(th), .md :deep(td) { border: 1px solid var(--sb-border); padding: 4px 10px; text-align: left; }
.md :deep(th) { background: var(--sb-bg-subtle); font-weight: 600; }
.md :deep(img) { max-width: 100%; }
</style>
