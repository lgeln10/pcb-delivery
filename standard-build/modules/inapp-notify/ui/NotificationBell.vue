<script setup lang="ts">
import { ref, computed } from 'vue'
import { Bell } from '@lucide/vue'
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import {
  apiGetInappNotifyCount,
  apiListInappNotifications,
  apiMarkInappNotificationRead,
  apiMarkAllInappNotificationsRead,
  type InappNotificationDTO,
} from '../../../src/api/client'
import { useAuth } from '../../../src/auth'
import PushSelfTest from './PushSelfTest.vue'
import { notificationAction, openNotificationSource } from './notification-link'
import NotificationDetail from './NotificationDetail.vue'
import { formatNotifyTime } from './notification-format'

const { employee } = useAuth()

const qc = useQueryClient()
const open = ref(false)

const { data: countData } = useQuery({
  queryKey: ['inapp-notify-count'],
  queryFn: apiGetInappNotifyCount,
  refetchInterval: 30_000, // 30s 轮询未读数
})

const unread = computed(() => countData.value?.count ?? 0)

// 不要从 useQuery 解构 fetchNextPage/hasNextPage —— 那是 useInfiniteQuery 才有的,
// 这里解构出来永远是 undefined。原来就这么写着,而且解构完全文没再用过。真要做分页得换 useInfiniteQuery。
const { data: listData, isPending, isError, refetch } = useQuery({
  queryKey: ['inapp-notify-list'],
  queryFn: () => apiListInappNotifications({ limit: 20 }),
  enabled: open,
})

const items = computed<InappNotificationDTO[]>(() => listData.value?.items ?? [])

const markReadMutation = useMutation({
  mutationFn: (id: string) => apiMarkInappNotificationRead(id),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['inapp-notify-count'] })
    qc.invalidateQueries({ queryKey: ['inapp-notify-list'] })
  },
})

const markAllMutation = useMutation({
  mutationFn: apiMarkAllInappNotificationsRead,
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['inapp-notify-count'] })
    qc.invalidateQueries({ queryKey: ['inapp-notify-list'] })
  },
})

function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    qc.invalidateQueries({ queryKey: ['inapp-notify-list'] })
  }
}

const detailItem = ref<InappNotificationDTO | null>(null)

function handleClickItem(item: InappNotificationDTO) {
  if (!item.isRead) markReadMutation.mutate(item.id)
  // 三档口径在 notification-target.ts,与通知整页共用一份(见那里的注释)。
  // ★read 类(正文即内容)在铃铛里**一律开抽屉**,不像整页那样在手机上就地展开:
  //   铃铛是个一点外面就收起的浮层,把二三十行报告塞进去要在浮层里再滚一遍,
  //   而且滚动中误触外部就整个消失。抽屉在手机上是全屏的,反而是这里最好读的形态。
  if (notificationAction(item, employee.value?.id) === 'read') {
    detailItem.value = item
    open.value = false
    return
  }
  if (openNotificationSource(item, employee.value?.id)) open.value = false
}

/** 面板底部「查看全部」→ 通知整页(铃铛只取最新 20 条,翻页/筛未读要去整页) */
function goAllNotifications() {
  window.dispatchEvent(new CustomEvent('si:navigate', { detail: 'notifications' }))
  open.value = false
}

</script>

<template>
  <div class="notif-bell" @keydown.esc="open = false">
    <button
      type="button"
      class="icon-button notif-btn"
      :title="unread ? `${unread} 条未读通知` : '通知'"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <Bell :size="18" />
      <span v-if="unread > 0" class="notif-badge">{{ unread > 99 ? '99+' : unread }}</span>
    </button>

    <Transition name="notif-panel">
      <div v-if="open" class="notif-panel" role="dialog" aria-label="通知列表">
        <div class="notif-panel__header">
          <span class="notif-panel__title">通知</span>
          <button
            v-if="unread > 0"
            type="button"
            class="notif-markall"
            :disabled="markAllMutation.isPending.value"
            @click="markAllMutation.mutate()"
          >
            全部已读
          </button>
        </div>

        <div class="notif-panel__body">
          <p v-if="isPending" class="notif-empty">加载中…</p>
          <p v-else-if="isError" class="notif-empty">
            通知加载失败
            <button type="button" class="notif-retry" @click="refetch()">重试</button>
          </p>
          <p v-else-if="items.length === 0" class="notif-empty">暂无通知</p>
          <ul v-else class="notif-list">
            <li
              v-for="item in items"
              :key="item.id"
              class="notif-item"
              :class="{ 'notif-item--unread': !item.isRead }"
              @click="handleClickItem(item)"
            >
              <div class="notif-item__dot" />
              <div class="notif-item__content">
                <p class="notif-item__title">{{ item.title }}</p>
                <p class="notif-item__body">{{ item.body }}</p>
                <span class="notif-item__time">{{ formatNotifyTime(item.createdAt) }}</span>
              </div>
            </li>
          </ul>
        </div>

        <div class="notif-panel__foot">
          <!-- 铃铛只取最新 20 条且不分页(见上面 useQuery 的注释),要翻页/筛未读得去整页 -->
          <button type="button" class="notif-all" @click="goAllNotifications">查看全部通知</button>
          <PushSelfTest />
        </div>
      </div>
    </Transition>

    <!-- 遮罩：点击外部关闭 -->
    <div v-if="open" class="notif-overlay" @click="open = false" />
  </div>
  <!-- 「知会」类的正文详情:铃铛收起后开抽屉(桌面/手机同款,理由见 handleClickItem) -->
  <NotificationDetail :item="detailItem" :self-employee-id="employee?.id" @close="detailItem = null" />
</template>

<style scoped>
.notif-bell {
  position: relative;
}

.notif-btn {
  position: relative;
}

.notif-badge {
  position: absolute;
  top: 0;
  right: 0;
  transform: translate(40%, -40%);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 99px;
  background: var(--sb-color-danger);
  color: var(--sb-text-inverse);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  pointer-events: none;
}

.notif-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
}

.notif-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 100;
  width: 320px;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--sb-bg-card);
  border: 1px solid var(--sb-border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}

.notif-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--sb-border);
}

.notif-panel__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--sb-text-primary);
}

.notif-markall {
  font-size: 12px;
  color: var(--sb-color-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.notif-markall:hover { text-decoration: underline; }
.notif-markall:disabled { opacity: 0.5; cursor: default; }

/* 面板底部:「查看全部」+ 推送自检。两条都是次要入口,别和通知内容抢注意力 */
.notif-panel__foot {
  border-top: 1px solid var(--sb-border);
  padding: var(--sb-space-2) var(--sb-space-3);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
}
.notif-all {
  font-size: var(--sb-font-sm);
  color: var(--sb-color-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.notif-all:hover { text-decoration: underline; }

.notif-panel__body {
  overflow-y: auto;
  flex: 1;
}

.notif-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--sb-text-tertiary);
  font-size: 13px;
}

.notif-retry {
  display: inline-block;
  margin-left: var(--sb-space-2);
  border: none;
  background: none;
  color: var(--sb-color-primary);
  cursor: pointer;
  font-size: 13px;
}

.notif-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.notif-item {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  border-bottom: 1px solid var(--sb-border);
  transition: background 0.12s;
}
.notif-item:last-child { border-bottom: none; }
.notif-item:hover { background: var(--sb-bg-hover); }
.notif-item--unread { background: var(--sb-color-primary-soft); }
.notif-item--unread:hover { background: #e0ecff; }

.notif-item__dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: transparent;
}
.notif-item--unread .notif-item__dot {
  background: var(--sb-color-primary);
}

.notif-item__content {
  flex: 1;
  min-width: 0;
}

.notif-item__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--sb-text-primary);
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notif-item__body {
  font-size: 12px;
  color: var(--sb-text-secondary);
  margin-bottom: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notif-item__time {
  font-size: 11px;
  color: var(--sb-text-tertiary);
}

/* 面板出现动画 */
.notif-panel-enter-active,
.notif-panel-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.notif-panel-enter-from,
.notif-panel-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (max-width: 768px) {
  /* 面板是 right:0 的 320px 定宽,而铃铛在窄屏顶栏里的右缘约 321px(375 - 顶栏 padding 16
     - 用户菜单 30 - gap 8)—— 也就是 375px 屏上左缘刚好落在 1px 处,零余量。再窄一格
     (360px 的安卓机、Capacitor 壳里常见的 360dp)左缘就是负值,被 body 的 overflow-x:hidden
     直接裁掉,通知标题左侧缺一截且找不回来。定值改成夹在视口内:375px 下仍是 320px(视觉零变化),
     更窄的机器自动收。 */
  .notif-panel {
    width: min(320px, calc(100vw - 32px));
  }
}
</style>
