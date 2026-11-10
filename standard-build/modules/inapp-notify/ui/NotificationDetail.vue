<script setup lang="ts">
// modules/inapp-notify/ui/NotificationDetail.vue
// 「知会」类通知的正文详情抽屉(桌面);正文按 markdown 渲染。
//
// ★为什么需要它:这类通知(日报/周报/晨检/预算与备份告警/关键商机清单)**正文就是内容**,
//   而列表里正文被截成 2–3 行 —— 二三十行的分段报告在产品里等于读不到。
//   在此之前点它们只会跳到某张业务列表,内容反而永远打不开(2026-08-21 梳理)。
// ★次要动作:该类型若还有一张相关页面(如冲突预警的客户查重),抽屉底部给一颗「去…」——
//   主动作是读完,不是跳走。按钮文案直接取自导航目录,避免再手抄一份 key→中文名。
import { computed } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { MarkdownView } from '../../../core/ui-kit'
import { NAV_CATALOG, flattenNavItems } from '../../../src/nav-catalog'
import { notificationTarget } from '../notification-target'
import { navigateToSection } from './notification-link'
import { formatNotifyTime } from './notification-format'

const props = defineProps<{
  item: { title: string; body: string; createdAt: string; sourceType: string; sourceId: string } | null
  selfEmployeeId?: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const open = computed({
  get: () => props.item !== null,
  set: (v: boolean) => {
    if (!v) emit('close')
  },
})

/** 该类型附带的「去哪一屏」次要动作(read 类才有;jump 类根本不会开这个抽屉)。 */
const secondary = computed<{ section: string; label: string } | null>(() => {
  if (!props.item) return null
  const t = notificationTarget(props.item, props.selfEmployeeId)
  if (!t || t.kind !== 'read' || !t.section) return null
  const label = flattenNavItems(NAV_CATALOG.flatMap((g) => g.items)).find((i) => i.key === t.section)?.label
  // 菜单里查不到 label(该用户不可见/被功能开关关掉)→ 不给按钮,而不是给一颗点了没反应的
  return label ? { section: t.section, label } : null
})

function goSecondary() {
  const s = secondary.value
  if (!s) return
  navigateToSection(s.section)
  emit('close')
}
</script>

<template>
  <el-drawer v-model="open" :title="item?.title ?? ''" size="var(--sb-drawer-compact)" append-to-body destroy-on-close class="notif-detail">
    <template v-if="item">
      <p class="notif-detail__time">{{ formatNotifyTime(item.createdAt) }}</p>
      <MarkdownView :source="item.body" />
    </template>
    <template v-if="secondary" #footer>
      <div class="drawer-footer">
        <el-button text type="primary" @click="goSecondary">
          去{{ secondary.label }}<ChevronRight :size="14" />
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<style scoped>
.notif-detail__time {
  margin: 0 0 var(--sb-space-3);
  font-size: var(--sb-font-xs);
  color: var(--sb-text-tertiary);
}
</style>
