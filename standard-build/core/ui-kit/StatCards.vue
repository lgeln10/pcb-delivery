<script setup lang="ts">
// core/ui-kit/StatCards.vue
// 「一个名称列 + 几个数值列」这类统计表在手机上的替身。
//
// 为什么需要它:这类表(渠道转化、小组概览、人员概览、失单原因…)列都设了 width/min-width,
// 在 375px 下加起来 700~1100px,EP 会把它塞进 .el-scrollbar__wrap 内部横滚 —— 内容够得着,
// 但要**在一个内部滚动条里左右拖着看数字**,而外面还有整页的纵向滚动,两层滚动叠在一起最难用。
// 转成卡片:名称一行,数值按 label/value 成对平铺,一屏看全,不用横拖。
//
// ★刻意做成「传列描述」而不是「传 el-table-column」:这两套的列定义没法共用(一个是 vnode、
//   一个是数据),硬要共用就得在运行时解析插槽,那比多写一行列描述贵得多也脆得多。
//   代价是同一张表的列在两处各写一遍 —— 接受它,但**两处要一起改**。
type Row = Record<string, unknown>
defineProps<{
  rows: readonly Row[]
  /** 卡片主标题(通常就是表里那个名称列) */
  title: (row: never) => string
  /** 主标题下的一行小字,可选 */
  subtitle?: (row: never) => string | undefined
  /** 数值列:label 与表头一致,value 返回**已经格式化好**的文本(金额/百分比在调用方格式化) */
  cols: readonly { label: string; value: (row: never) => string | number }[]
  /** 行可点时传,不传则卡片不可点(不要给不可点的卡片加 hover/cursor,那是骗点击) */
  onRowClick?: (row: never) => void
}>()
</script>

<template>
  <div class="stat-cards">
    <component
      :is="onRowClick ? 'button' : 'div'"
      v-for="(row, i) in rows"
      :key="i"
      :type="onRowClick ? 'button' : undefined"
      class="stat-card"
      :class="{ 'stat-card--tap': onRowClick }"
      @click="onRowClick?.(row as never)"
    >
      <div class="stat-card__head">
        <span class="stat-card__title">{{ title(row as never) }}</span>
        <span v-if="subtitle && subtitle(row as never)" class="stat-card__sub">{{ subtitle(row as never) }}</span>
      </div>
      <dl class="stat-card__grid">
        <div v-for="c in cols" :key="c.label" class="stat-card__cell">
          <dt>{{ c.label }}</dt>
          <dd>{{ c.value(row as never) }}</dd>
        </div>
      </dl>
      <slot name="extra" :row="row" />
    </component>
  </div>
</template>

<style scoped>
.stat-cards {
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
  padding: var(--sb-space-3);
}
.stat-card {
  display: block;
  width: 100%;
  padding: var(--sb-space-3);
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-md);
  background: var(--sb-bg-card);
  color: var(--sb-text-primary);
  text-align: left;
}
.stat-card--tap {
  min-height: 44px; /* 可点就得够得着 */
  cursor: pointer;
}
.stat-card__head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sb-space-2);
  align-items: baseline;
  margin-bottom: var(--sb-space-2);
}
.stat-card__title {
  font-weight: 600;
}
.stat-card__sub {
  color: var(--sb-text-secondary);
  font-size: var(--sb-font-sm);
}
/* 两列:375px 下三列会把「进行中商机 12 单 · ¥1,280,000」这种长值挤成两行 */
.stat-card__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sb-space-2) var(--sb-space-3);
  margin: 0;
}
.stat-card__cell {
  min-width: 0;
}
.stat-card__cell dt {
  color: var(--sb-text-tertiary);
  font-size: var(--sb-font-xs);
}
.stat-card__cell dd {
  margin: 2px 0 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums; /* 数字等宽,竖着扫的时候位数对齐 */
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
