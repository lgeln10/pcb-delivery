<script setup lang="ts">
// ★表单字段容器(质量红线:校验失败必须定位到具体字段,不只弹一句「失败」)。
// 用法:每个表单控件包一层 FormField,error prop 非空时在字段下方红字提示。
defineProps<{
  label: string
  /** 该字段的校验错误文案,空 = 无错误 */
  error?: string | null
  required?: boolean
}>()
</script>

<template>
  <label class="sb-field" :class="{ 'sb-field--error': !!error }">
    <span class="sb-field__label">
      <span v-if="required" class="sb-field__required">*</span>{{ label }}
    </span>
    <slot />
    <span v-if="error" class="sb-field__error" role="alert">{{ error }}</span>
  </label>
</template>

<style scoped>
.sb-field {
  display: block;
  margin-bottom: var(--sb-space-4);
}
.sb-field__label {
  display: block;
  margin-bottom: var(--sb-space-1);
  font-size: var(--sb-font-sm);
  color: var(--sb-text-primary);
}
.sb-field__required {
  color: var(--sb-color-danger);
  margin-right: var(--sb-space-1);
}
.sb-field__error {
  display: block;
  margin-top: var(--sb-space-1);
  font-size: var(--sb-font-xs);
  color: var(--sb-color-danger);
}
</style>
