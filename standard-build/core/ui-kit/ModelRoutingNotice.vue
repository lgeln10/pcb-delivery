<script setup lang="ts">
// core/ui-kit/ModelRoutingNotice.vue
// 「模型到底在哪一页配」这件事的**唯一说法**,两处编辑面共用一份。
//
// ── 为什么要有它(2026-08-22 线上教训)────────────────────────────────────
// 模型配置有两套,谁生效由服务器的 TB_* 环境变量决定:
//   · 直连模式 → 「系统设置 → AI 大模型」
//   · 网关模式 → 「系统管理 → AI 网关 → 场景路由」
// 出过的事:图片识别报错 → 提示把人指到「AI 大模型」→ 用户在那一页把「图片识别」改成了
// 一个**实测能看图**的模型 → 再试还是同一个错。因为那台是网关模式,那一页的设置根本不生效。
//
// ★**光加一句提示是不够的** —— 那一页当时就已经有一条「当前走 AI 网关…不生效」的提示,
//   人照样改了、存了、以为配好了。所以这个组件配套的是**把不生效的输入真的锁上**
//   (见各页的 locked 用法):提示会被略过,禁用不会。
// ★锁不是死锁:留一个「仍要编辑」开关。撤下网关(去掉 TB_*)之后本地这份就是兜底,
//   提前配好是正当需求 —— 只是别让人以为它现在就在生效。
import { computed } from 'vue'
import { ArrowRight, Info, Lock } from '@lucide/vue'

const props = defineProps<{
  /** 这个组件挂在哪一页:local=系统设置→AI 大模型;gateway=系统管理→AI 网关 */
  page: 'local' | 'gateway'
  /** 服务器当前是不是走网关(local 页取自 LlmConfigDTO.gatewayActive;gateway 页取自网关状态) */
  gatewayActive: boolean
  /** 当前用户看不看得到对面那一页 —— 看不到就别给按钮(si:navigate 会被可见性白名单静默丢弃) */
  canGoOther?: boolean
  /** 本页的输入是否已被锁住(只影响文案:说不说「已锁住」) */
  locked?: boolean
}>()

/** 本页现在算不算数。 */
const inCharge = computed(() => (props.page === 'local' ? !props.gatewayActive : props.gatewayActive))
const otherKey = computed(() => (props.page === 'local' ? 'ai-gateway' : 'app-settings'))
const otherLabel = computed(() => (props.page === 'local' ? '系统管理 → AI 网关 → 场景路由' : '系统设置 → AI 大模型'))
function goOther() {
  window.dispatchEvent(new CustomEvent('si:navigate', { detail: otherKey.value }))
}
</script>

<template>
  <div class="mrn" :class="inCharge ? 'mrn--on' : 'mrn--off'">
    <component :is="inCharge ? Info : Lock" :size="15" class="mrn__i" />
    <div class="mrn__body">
      <p class="mrn__line">
        <template v-if="inCharge">
          <b>当前{{ gatewayActive ? '走 AI 网关' : '是直连模式' }} —— 这一页配的就是生效的那份。</b>
          <span v-if="page === 'local'">(服务器没设 <code>TB_*</code>,业务调用直接打各家供应商。)</span>
          <span v-else>(每个场景发的是虚拟模型名,真模型由下面这张「场景路由」表决定。)</span>
        </template>
        <template v-else>
          <b>这一页现在不生效。</b>
          <span v-if="page === 'local'">
            服务器已接入 AI 网关:出口、模型、凭据都由网关的场景路由决定,本页的供应商 / 模型 / 备用 / API Key
            <b>都不参与</b>(只有「深度思考」开关仍会随每次调用下发)。
          </span>
          <span v-else>
            服务器还没接入 AI 网关(缺 <code>TB_BASE_URL</code> / <code>TB_USER_TOKEN</code> / <code>TB_MODEL_TOKEN</code>),
            当前是直连模式,模型请到那一页配。
          </span>
        </template>
      </p>
      <p v-if="!inCharge && locked" class="mrn__line mrn__line--sub">
        所以下面的输入已锁住,免得改完存下、以为配好了。撤下网关后本页会重新生效,要提前配可以点「仍要编辑」。
      </p>
      <button v-if="!inCharge && canGoOther" type="button" class="mrn__go" @click="goOther">
        去「{{ otherLabel }}」<ArrowRight :size="13" />
      </button>
      <p v-else-if="!inCharge" class="mrn__line mrn__line--sub">要改的话去「{{ otherLabel }}」(你当前没有那一页的权限,找管理员)。</p>
    </div>
  </div>
</template>

<style scoped>
.mrn {
  display: flex; gap: var(--sb-space-2); align-items: flex-start;
  padding: var(--sb-space-3); margin-bottom: var(--sb-space-4);
  border-radius: var(--sb-radius-md); border: 1px solid var(--sb-border);
  font-size: var(--sb-font-xs); line-height: 1.7; color: var(--sb-text-secondary);
}
/* 生效中:低调(它只是确认现状);不生效:醒目(它在拦一个正要犯的错) */
.mrn--on { background: var(--sb-bg-subtle); }
.mrn--off { background: var(--sb-color-warning-soft); border-color: var(--sb-color-warning); color: var(--sb-text-primary); }
.mrn__i { flex: none; margin-top: 2px; }
.mrn__body { min-width: 0; }
.mrn__line { margin: 0; }
.mrn__line--sub { margin-top: 4px; color: var(--sb-text-tertiary); }
.mrn__go {
  display: inline-flex; align-items: center; gap: 4px; margin-top: var(--sb-space-2);
  padding: 4px 10px; border: 1px solid var(--sb-border); border-radius: var(--sb-radius-pill);
  background: var(--sb-bg-card); color: var(--sb-color-primary); font-size: var(--sb-font-xs); cursor: pointer;
}
.mrn__go:hover { background: var(--sb-bg-subtle); }
.mrn code { padding: 0 3px; border-radius: 3px; background: var(--sb-bg-subtle); font-size: 0.95em; }
</style>
