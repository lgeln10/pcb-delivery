<script setup lang="ts">
// modules/inapp-notify/ui/NotificationsPage.vue
// 收件箱整页 —— **一页两区**:上「需要你处理」(要动手的),下「知会」(要知道的)。
// 设计与取舍见 docs/design/ATTENTION_INBOX.md §2.1。
//
// ★2026-08-15 由「通知 | 需要处理」两个视图切换合并成一页两区,三个理由:
//   ① 队列存在的全部意义是「等我处理的事有唯一入口」。藏在第二个 Tab 后面 = 你得先想起来去点它
//      —— 那正是我们要消灭的分散,只是换了个地方分散;
//   ② 两区回答的是不同的动词(处理 / 知道),所以要**分区**而不是混排:混排会让一条 FYI
//      把一张待批的合同挤到屏幕外;
//   ③ 行动区天生短(审批+AI+待办,还做了同类折叠),知会流天生长 —— 短的在上、长的在下,
//      一次滚动读完,不需要任何切换。
//   顺带:一页只留一个「刷新」(两区一起刷),与「全部已读」同一行。
//
// ★本页**不能**用 .module-surface--fill。那套是给「表格内部滚动 + 分页贴底」的列表页的:
//   它把整页滚动收走(.app-main 不再溢出),而本页的 <ul> 有 overflow:hidden(为圆角),
//   在 flex 列里 min-height 因此算作 0 → 列表被压扁、超出的通知**被裁掉且够不着**,
//   表现就是「通知列表滑不动」(2026-08-15 用户反馈)。本页是自然增高页,让 .app-main 滚。
//
// 与铃铛共用的三块(**别在这里另写一份**,分叉了两边都不报错):
//   - 点击落点   notification-link.ts
//   - 时间显示   notification-format.ts
//   - 推送自检   PushSelfTest.vue(只留在铃铛面板里;整页底部那份已按需求撤掉)
//
// 分页用手写游标而不是 useInfiniteQuery:标已读之后要**就地**把那条改成已读(而不是整列表重拉),
// 否则用户点一下、列表闪一下再回来,还容易把已经滚到的位置丢掉。全仓也还没有第二处 useInfiniteQuery。
import { computed, onMounted, ref, watch } from 'vue'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { CheckCheck, RefreshCw } from '@lucide/vue'
import AsyncState from '../../../core/ui-kit/AsyncState.vue'
import {
  apiListInappNotifications,
  apiMarkAllInappNotificationsRead,
  apiMarkInappNotificationRead,
  errorMessage,
  type InappNotificationDTO,
} from '../../../src/api/client'
import { useAuth } from '../../../src/auth'
import { MarkdownView } from '../../../core/ui-kit'
import { useIsMobile } from '../../../src/composables/useIsMobile'
import { notificationAction, openNotificationSource } from './notification-link'
import NotificationDetail from './NotificationDetail.vue'
import { formatNotifyTime } from './notification-format'

const PAGE_SIZE = 30

const { employee } = useAuth()
const qc = useQueryClient()

const unreadOnly = ref(false)
const items = ref<InappNotificationDTO[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)       // 首屏/切筛选:整块骨架
const loadingMore = ref(false)   // 追加下一页:只让按钮转,列表不动
const error = ref<string | null>(null)

async function load(append = false) {
  if (append) loadingMore.value = true
  else {
    loading.value = true
    error.value = null
  }
  try {
    const r = await apiListInappNotifications({
      limit: PAGE_SIZE,
      unreadOnly: unreadOnly.value,
      cursor: append ? (cursor.value ?? undefined) : undefined,
    })
    items.value = append ? [...items.value, ...r.items] : r.items
    cursor.value = r.nextCursor
  } catch (e) {
    // 追加失败不能把已经看到的列表清掉 —— 那等于用户滚了半天白滚
    if (append) ElMessage.error(errorMessage(e))
    else error.value = errorMessage(e)
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

onMounted(() => load())
// 切「全部/未读」= 换了查询条件,游标必须一起重置,否则会拿旧游标去翻新列表
watch(unreadOnly, () => { cursor.value = null; void load() })

const unreadCount = computed(() => items.value.filter((n) => !n.isRead).length)
// 点这条会发生什么:'read' = 正文即内容(就地读)/ 'jump' = 跳走 / 'none' = 不认识的类型,只标已读。
const actionOf = (item: InappNotificationDTO) => notificationAction(item, employee.value?.id)
const canJump = (item: InappNotificationDTO) => actionOf(item) === 'jump'

// ★读全文的两种形态(2026-08-21 定的口径):手机就地展开,桌面开抽屉。
//   手机上抽屉会盖住整屏、还要多一次「关掉」;桌面上就地展开会把下面的列表整段推走,
//   一屏能看的条数本来就多,推走比盖住更难受。
const isMobile = useIsMobile()
const expandedId = ref<string | null>(null)
const detailItem = ref<InappNotificationDTO | null>(null)
function readInPlace(item: InappNotificationDTO) {
  if (isMobile.value) expandedId.value = expandedId.value === item.id ? null : item.id
  else detailItem.value = item
}

// 一页一个「刷新」:两区一起刷,转圈也一起转
const refreshing = computed(() => loading.value)
function refreshAll() {
  cursor.value = null
  void load()
}

const markAllMutation = useMutation({
  mutationFn: apiMarkAllInappNotificationsRead,
  onSuccess: (r) => {
    ElMessage.success(r.updated > 0 ? `已把 ${r.updated} 条标为已读` : '没有未读通知')
    qc.invalidateQueries({ queryKey: ['inapp-notify-count'] })
    qc.invalidateQueries({ queryKey: ['inapp-notify-list'] })
    cursor.value = null
    void load()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

async function onClickItem(item: InappNotificationDTO) {
  if (!item.isRead) {
    // ★就地改,不从「未读」列表里移除:点了之后那条在手指底下消失、后面的整体上跳,
    //   是最容易点错下一条的交互。下次进页面/刷新时它自然不在未读里了。
    item.isRead = true
    try {
      await apiMarkInappNotificationRead(item.id)
      qc.invalidateQueries({ queryKey: ['inapp-notify-count'] })
      qc.invalidateQueries({ queryKey: ['inapp-notify-list'] })
    } catch (e) {
      item.isRead = false // 回滚,别让界面显示成已读而服务端还是未读
      ElMessage.error(errorMessage(e))
    }
  }
  // 三档:正文即内容的就地读完(不跳走,否则内容反而丢了);有落地页的照旧跳;
  // 不认识的类型只标已读(见 notification-target.ts)
  if (actionOf(item) === 'read') readInPlace(item)
  else openNotificationSource(item, employee.value?.id)
}
</script>

<template>
  <section class="module-surface">
    <div class="module-toolbar">
      <p class="t-caption">发给你的通知都在这里。</p>
      <div class="notif-page__actions">
        <el-button :icon="RefreshCw" :loading="refreshing" @click="refreshAll">刷新</el-button>
        <el-button
          :icon="CheckCheck"
          :disabled="unreadCount === 0"
          :loading="markAllMutation.isPending.value"
          @click="markAllMutation.mutate()"
        >
          全部已读
        </el-button>
      </div>
    </div>

    <section class="inbox-zone">
      <h3 class="inbox-zone__title">
        知会
        <span class="inbox-zone__hint">读过就完,不用你动手</span>
        <el-radio-group v-model="unreadOnly" size="small" class="inbox-zone__filter">
          <el-radio-button :value="false">全部</el-radio-button>
          <el-radio-button :value="true">未读</el-radio-button>
        </el-radio-group>
      </h3>

      <AsyncState
        :loading="loading"
        :error="error"
        :empty="items.length === 0"
        :empty-title="unreadOnly ? '没有未读通知' : '还没有收到通知'"
        :empty-hint="unreadOnly ? '所有通知都已读完' : '系统通知会出现在这里'"
        @retry="load()"
      >
        <ul class="notif-page__list">
          <li
            v-for="item in items"
            :key="item.id"
            class="notif-page__item"
            :class="{ 'notif-page__item--unread': !item.isRead, 'notif-page__item--flat': !canJump(item) }"
            role="button"
            tabindex="0"
            @click="onClickItem(item)"
            @keyup.enter="onClickItem(item)"
          >
            <span class="notif-page__dot" aria-hidden="true" />
            <span class="notif-page__content">
              <span class="notif-page__title">{{ item.title }}</span>
              <!-- 展开态渲染 markdown 全文(报告类正文带分段/列表/加粗);收起态仍是截断的纯文本预览 -->
              <MarkdownView v-if="expandedId === item.id" :source="item.body" class="notif-page__md" />
              <span v-else class="notif-page__body">{{ item.body }}</span>
              <span class="notif-page__time">{{ formatNotifyTime(item.createdAt) }}</span>
            </span>
          </li>
        </ul>

        <div v-if="cursor" class="notif-page__more">
          <el-button :loading="loadingMore" @click="load(true)">加载更多</el-button>
        </div>
        <p v-else-if="items.length >= PAGE_SIZE" class="notif-page__end">没有更多了</p>
      </AsyncState>
    </section>

    <!-- 桌面读全文用抽屉(手机是就地展开,见 readInPlace) -->
    <NotificationDetail :item="detailItem" :self-employee-id="employee?.id" @close="detailItem = null" />
  </section>
</template>

<style scoped>
/* 布局交给全局的 `.module-toolbar > div:last-child`(flex + gap + 右对齐),这里只管手机上的收窄 */

/* ── 分区(与「我的待办」的分节同一套视觉:标题 + 数字胶囊 + 弱化说明)── */
.inbox-zone__title {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
  margin: 0 0 var(--sb-space-2);
  font-size: var(--sb-font-md);
  font-weight: 600;
  color: var(--sb-text-primary);
}
.inbox-zone__count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--sb-radius-pill);
  background: var(--sb-color-danger);
  color: var(--sb-text-inverse, #fff);
  font-size: var(--sb-font-xs);
}
.inbox-zone__hint {
  font-size: var(--sb-font-xs);
  font-weight: 400;
  color: var(--sb-text-tertiary);
}
/* 「全部/未读」只管知会区,所以摆在这一区的标题行右端,而不是页面顶部 */
.inbox-zone__filter {
  margin-left: auto;
}
/* 分区标题右端的次级入口(AI 会话):文字链形态,别做成按钮跟顶部两个主操作抢分量 */
.inbox-zone__link {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border: none;
  border-radius: var(--sb-radius-md);
  background: none;
  color: var(--sb-color-primary);
  font-size: var(--sb-font-xs);
  font-family: inherit;
  cursor: pointer;
}
.inbox-zone__link:hover { background: var(--sb-color-primary-soft); }

.notif-page__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-md);
  overflow: hidden;
}

.notif-page__item {
  display: flex;
  gap: var(--sb-space-3);
  padding: var(--sb-space-4);
  cursor: pointer;
  border-bottom: 1px solid var(--sb-border);
  transition: background 0.12s;
}
.notif-page__item:last-child { border-bottom: none; }
.notif-page__item:hover { background: var(--sb-bg-hover); }
/* 触屏没有 hover,按下得有回馈 —— 不然点了像没点上,用户会再戳一次 */
.notif-page__item:active { background: var(--sb-bg-hover); }
.notif-page__item:focus-visible { outline: 2px solid var(--sb-color-primary); outline-offset: -2px; }
.notif-page__item--unread { background: var(--sb-color-primary-soft); }
/* 点了也不会跳转的类型:不摆出「可点」的手型,免得用户以为没反应是坏了 */
.notif-page__item--flat { cursor: default; }

.notif-page__dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 7px;
  border-radius: 50%;
  background: transparent;
}
.notif-page__item--unread .notif-page__dot { background: var(--sb-color-primary); }

.notif-page__content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.notif-page__title {
  font-size: var(--sb-font-md);
  font-weight: 600;
  color: var(--sb-text-primary);
}
.notif-page__md {
  /* 展开态:整段可读,不截断。字号沿用正文档,别把报告放大成正文 */
  margin-top: 2px;
}
.notif-page__body {
  font-size: var(--sb-font-sm);
  color: var(--sb-text-secondary);
  /* 整页有的是宽度,正文给到 3 行再截(铃铛里是 2 行) */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.notif-page__time {
  font-size: var(--sb-font-xs);
  color: var(--sb-text-tertiary);
  margin-top: 2px;
}

.notif-page__more {
  display: flex;
  justify-content: center;
  padding: var(--sb-space-4) 0 0;
}
.notif-page__end {
  margin: var(--sb-space-4) 0 0;
  text-align: center;
  font-size: var(--sb-font-xs);
  color: var(--sb-text-tertiary);
}

@media (max-width: 768px) {
  /* 手机上一行放不下「刷新 + 全部已读」的右对齐,让工具条换行,按钮各占一行的一半 */
  .notif-page__actions { flex: 1; }
  .notif-page__actions .el-button { flex: 1; }
  .notif-page__item { padding: var(--sb-space-3); }
  /* 分区标题窄屏折行:说明文字让位,筛选钮回到行首后面 */
  .inbox-zone__title { flex-wrap: wrap; }
  .inbox-zone__hint { display: none; }
  /* 「加载更多」拉满整行:翻页是这页唯一的高频触控点,居中的小按钮拇指够不准 */
  .notif-page__more .el-button { width: 100%; }
}
</style>
