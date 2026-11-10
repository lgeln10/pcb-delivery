<script setup lang="ts">
// core/ui-kit/ToolbarActions.vue
// 顶部操作栏的动作区容器(取代页面里裸写的 `.module-toolbar` 最后那个 <div>)。
//
// **为什么要这个组件**:2026-08-15 在 375×812 下逐页量过 —— 线索页顶部 7 个按钮铺满 3 行、
// 吃掉 172px,而可视区去掉顶栏和底部 tab 只剩 ~600px:**光工具栏就占 28%**。
// 更糟的是排序:唯一的高频动作「录入线索」被挤到第三行最左,而「渠道配置 / 下载模板 / 导入 Excel」
// 这些管理员一年用两次的动作占着第一行。桌面端一排平铺没问题,手机上就是喧宾夺主。
//
// 做法:**手机上只留主动作 + 一个「更多」**,其余收进去。桌面端渲染与原来逐字节一致。
//
// 用法:
//   <div class="module-toolbar">
//     <p class="t-caption">…说明…</p>
//     <ToolbarActions>
//       <el-button …>渠道配置</el-button>          ← 默认 slot = 次要动作
//       <input ref="importInput" type="file" hidden />   ← 隐藏元素放这里也安全,见下
//       <template #primary>
//         <el-button type="primary" …>录入线索</el-button>   ← 主动作,手机上始终可见
//       </template>
//     </ToolbarActions>
//   </div>
//
// ★两条实现上的讲究,改的时候别绕开:
//  ① **收起用 `v-show` 不用 `v-if`** —— 次要动作里常夹着 `<input type="file" hidden>` 这类
//    靠模板 ref 触发的元素(`importInput?.click()`)。用 `v-if` 收起时 ref 是 null,
//    「导入 Excel」会变成点了没反应的死按钮,而且**不报错**。`v-show` 只改 display,ref 一直在;
//    对 display:none 的 file input 调 `.click()` 也照常弹选择框。
//  ② 桌面端外层用 `display: contents` —— 按钮仍是 `.module-toolbar__actions` 的直接 flex 子元素,
//    间距/换行/对齐全部沿用既有全局规则,这个组件在桌面端等于不存在。
//
// 不做折叠的情况:次要动作 ≤2 个时,一个「更多」点开只露一两个按钮,比直接摆着还费事。
import { computed, ref, useSlots, Comment, Fragment, Text, type VNode } from 'vue'
import { ChevronDown, MoreHorizontal } from '@lucide/vue'
import { useIsMobile } from '../../src/composables/useIsMobile'

const props = withDefaults(defineProps<{ moreLabel?: string; collapseFrom?: number }>(), {
  moreLabel: '更多',
  collapseFrom: 3,
})

const slots = useSlots()
const isMobile = useIsMobile()
const open = ref(false)

/** 数默认 slot 里**真的会显示出来**的节点:注释(v-if 假分支)、空白文本、隐藏元素都不算。 */
function countVisible(nodes: VNode[] | undefined): number {
  let n = 0
  for (const v of nodes ?? []) {
    if (v.type === Comment) continue
    if (v.type === Fragment) {
      n += countVisible(v.children as VNode[])
      continue
    }
    if (v.type === Text) {
      if (String(v.children ?? '').trim()) n += 1
      continue
    }
    // <input hidden> / v-show=false 的元素不占位,不该把它算进「够不够多到要折叠」
    const p = (v.props ?? {}) as Record<string, unknown>
    if (p.hidden !== undefined && p.hidden !== false) continue
    n += 1
  }
  return n
}

const secondaryCount = computed(() => countVisible(slots.default?.()))
const collapsed = computed(() => isMobile.value && secondaryCount.value >= props.collapseFrom)

/** 手机上次要动作区的三种形态(桌面端恒为 ''，走 display:contents 那条基础规则)。
 *  ★为什么按个数分而不是一条 CSS 走天下:交给 flex 自己换行的话,「2 个次要动作」会排成
 *    [主][次一] / [次二] —— 第二行孤零零一个按钮。个数是已知的,直接把版式定死更稳。
 *  - none   : 一个都没有 → 整块让位,主动作才铺得满整行(空的 flex 子项照样吃一个 gap)
 *  - inline : 恰好一个   → 和主动作同处一行(最常见的形态,省下一整行 52px)
 *  - block  : 两个或折叠 → 自成一行、两列平铺 */
const restMode = computed(() => {
  if (!isMobile.value) return ''
  if (secondaryCount.value === 0) return 'none'
  return !collapsed.value && secondaryCount.value === 1 ? 'inline' : 'block'
})
</script>

<template>
  <div class="module-toolbar__actions" :class="{ 'toolbar-actions--mobile': isMobile }">
    <!-- ★DOM 顺序 = 桌面顺序(次要在左、主动作在右),与改造前逐字节一致。
         手机上靠 order 重排(主 -2 / 更多 -1 / 其余 0)—— 不能靠调 DOM 顺序,
         因为桌面端外层是 display:contents,order 对它不生效。 -->
    <!-- ★v-show 不是 v-if:见文件头 ① -->
    <div v-show="!collapsed || open" class="toolbar-actions__rest" :class="restMode && `toolbar-actions__rest--${restMode}`"><slot /></div>
    <span v-if="$slots.primary" class="toolbar-actions__primary"><slot name="primary" /></span>
    <el-button v-if="collapsed" class="toolbar-actions__more" :icon="MoreHorizontal" @click="open = !open">
      {{ moreLabel }}
      <ChevronDown :size="14" class="toolbar-actions__chev" :class="{ 'is-open': open }" />
    </el-button>
  </div>
</template>

<style scoped>
/* 桌面端:本组件等于不存在 —— 按钮仍是 .module-toolbar__actions 的直接 flex 子元素,
   间距/换行/右对齐全部走既有全局规则。 */
.toolbar-actions__rest,
.toolbar-actions__primary {
  display: contents;
}

/* 手机端 */
.toolbar-actions--mobile {
  flex-wrap: wrap;
  gap: var(--sb-space-2);
}
/* ★主动作与它的同伴(「更多」或唯一那个次要动作)**同处一行**。
   原来两者都是 `flex: 1 1 100%`,于是各占整行 —— 触屏上按钮高 44px,两行加 gap 就是 96px,
   而 375×812 去掉顶栏和底部 tab 只剩 ~683px 内容区,光工具栏吃掉 14%,还没算说明文字和筛选条。
   2026-08-27 在费用报销页实测:首张卡片要到 266px 才开始。改成一行后省 52px。
   主动作留 min-width 保底,免得次要动作标签长的时候把它压成半截。 */
.toolbar-actions--mobile .toolbar-actions__primary {
  display: flex;
  order: -2; /* 主动作永远第一个,不随次要动作增减漂移 */
  flex: 1 1 auto;
  min-width: 45%;
}
.toolbar-actions--mobile .toolbar-actions__primary :deep(.el-button) {
  width: 100%;
  margin-left: 0;
}
.toolbar-actions--mobile .toolbar-actions__more {
  order: -1;
  flex: 0 1 auto; /* 按内容宽,把剩下的横向空间让给主动作 */
  margin-left: 0;
}
.toolbar-actions__chev {
  margin-left: 4px;
  transition: transform 0.18s ease;
}
.toolbar-actions__chev.is-open {
  transform: rotate(180deg);
}
.toolbar-actions--mobile .toolbar-actions__rest :deep(.el-button) {
  min-width: 0;
  margin-left: 0;
}
/* ── 形态 none:一个可见的次要动作都没有 ──
   ★这里必须真的 `display: none`,不能只靠「里面没东西」—— 空的 flex 子项宽度是 0,
     但 gap 照吃,主动作就差那 8px 铺不满整行,看着像没对齐。
   ★对隐藏的 <input type="file"> 无害:v-show 折叠时用的也是 display:none,
     而对 display:none 的 file input 调 .click() 照常弹选择框(见文件头 ①)。 */
.toolbar-actions--mobile .toolbar-actions__rest--none {
  display: none;
}
/* ── 形态 inline:恰好一个次要动作,和主动作同处一行 ──
   `display: contents` 让这个按钮变成**外层的直接 flex 子项**,与主动作在同一个换行上下文里,
   按内容宽度排;主动作靠 flex-grow 吃掉剩余宽度,仍是视觉主角。 */
.toolbar-actions--mobile .toolbar-actions__rest--inline {
  display: contents;
}
/* ── 形态 block:两个次要动作,或折叠态点开「更多」之后 ──
   自成一行、两列平铺(一行两个刚好够放四个汉字,也保证每个都够宽好点)。
   ★折叠态下尤其不能让它顺着「更多」后面接着排 —— 那样第一个次要动作会和「更多」并排,
     看着像是和主动作平级。 */
.toolbar-actions--mobile .toolbar-actions__rest--block {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sb-space-2);
  flex: 1 1 100%;
}
.toolbar-actions--mobile .toolbar-actions__rest--block :deep(.el-button) {
  flex: 1 1 calc(50% - var(--sb-space-2));
}
</style>
