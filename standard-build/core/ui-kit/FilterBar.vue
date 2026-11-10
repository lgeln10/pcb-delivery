<script setup lang="ts">
// core/ui-kit/FilterBar.vue
// 列表页筛选条件容器。
//   桌面端 = 平铺一排(默认只露首行,hover / 聚焦展开全部)。
//   移动端 = **一条 44px 的开关 + 生效项 chips**,字段本体搬进底部抽屉(sheet)。
//
// ★2026-08-27 之前移动端是「点开就地展开」。那是错的,不是不够好:
//   375×812 实测线索页 8 个筛选字段,展开后筛选栏本身 738px、首张卡片被顶到 967px ——
//   **整个列表被推出视口**。于是「改一个条件、看列表怎么变」这件事在手机上根本做不到,
//   只能改完、收起、再滚回去看。改成 sheet 之后列表始终在原地,收起态只让出 44px。
//   ★也不接着用「就地展开 + 限高滚动」:那还是要占掉几百像素,而且筛选区自己内部滚、
//     页面外部也滚,两层滚动在手机上极难操作。
//
// 用法:把页面里 <div class="filter-bar">…字段…</div> 换成 <FilterBar>…字段…</FilterBar>,
// 字段仍用 .filter-bar__field / .filter-bar__actions —— **并且传 `:active`**,见下。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronDown, SlidersHorizontal, X } from '@lucide/vue'
import { useIsMobile } from '../../src/composables/useIsMobile'

/** 一条「当前生效」的筛选条件。label 写人话(带字段名),clear 把它清掉;不给 clear = 只展示不可清。 */
export type ActiveFilter = { label: string; clear?: () => void }
/** 页面普遍写 `statusFilter.value && {…}`,筛选值多是字符串,短路结果是 `''` 不是 `false`。
 *  把整套假值都收进来,免得每页都要多写一个 `!!` 或 `.filter(Boolean)`。 */
type Falsy = false | 0 | '' | null | undefined

const props = withDefaults(
  defineProps<{
    label?: string
    /**
     * 当前生效的筛选条件。**这是本组件唯一需要页面配合的地方,别省。**
     *
     * ★为什么必须要:收起态下筛选条件是看不见的。选了「草稿」再收起来,列表只剩两条,
     *   而页面上没有任何地方交代「因为你在筛草稿」—— 用户只会觉得数据没了。
     *
     * 写法(假值组件自己滤掉,页面不用写 .filter(Boolean)):
     *   :active="[
     *     statusFilter && { label: `状态:${STATUS_META[statusFilter].label}`, clear: () => (statusFilter = '') },
     *     pool !== 'all' && { label: `线索池:${poolLabel(pool)}`, clear: () => (pool = 'all') },
     *   ]"
     *
     * ★为什么不让组件自己去数 slot 里有值的控件:那要 sniff Element Plus 的内部 class
     *   (`.el-select__placeholder:not(.is-transparent)` 之流),EP 一升版就静默失效 ——
     *   表现是筛选状态显示不出来、而页面其余一切正常,没人会发现。宁可页面多写一个 computed。
     */
    active?: Array<ActiveFilter | Falsy>
    /**
     * 手机上收不收进抽屉,默认收。
     *
     * ★传 false 的唯一情形:**这一条不是「可选的筛选」,而是页面的主控件** ——
     *   工资页「选员工 →(旁边就是)设置/调薪」、「选月份 → 查询」,股东看板的期间/视图/核算组织,
     *   票据台账的应收/应付切换。把这些收进「筛选条件」抽屉,等于把页面的主操作藏起来,
     *   而且旁边那个动作按钮会跟着一起消失。
     * ★判据:去掉它,页面还能用吗?能 = 筛选(收);不能 = 主控件(别收)。
     *   会犹豫的话看它旁边有没有跟着一个动作按钮 —— 有,基本就是主控件。
     */
    collapsible?: boolean
  }>(),
  { label: '筛选条件', collapsible: true },
)

const isMobile = useIsMobile()
const open = ref(false) // 移动端 sheet 的开合

const activeList = computed(() => (props.active ?? []).filter((f): f is ActiveFilter => Boolean(f)))
const canClearAll = computed(() => activeList.value.some((f) => f.clear))
function clearAll() {
  // 逐条调各自的 clear:页面持有真正的筛选 ref,组件不该也不能替它决定「默认值是什么」。
  for (const f of activeList.value) f.clear?.()
}

// 桌面端收起态高度 = 首行字段的实际底边(而非定值):日期区间等字段比普通字段高,
// 定值 max-height 会把首行控件裁掉一截。filter-bar 是 align-items:flex-end,
// 首行所有字段底边对齐,量第一个字段的 bottom 即首行底边;ResizeObserver 跟随换行/尺寸变化。
const barEl = ref<HTMLElement | null>(null)
const collapsedH = ref('')
let ro: ResizeObserver | null = null
function measure() {
  const el = barEl.value
  const first = el?.firstElementChild as HTMLElement | null
  if (!el || !first) return
  const padBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0
  collapsedH.value = `${Math.ceil(first.getBoundingClientRect().bottom - el.getBoundingClientRect().top + padBottom)}px`
}
watch(
  barEl,
  (el) => {
    ro?.disconnect()
    ro = null
    if (!el) return
    measure()
    ro = new ResizeObserver(measure)
    ro.observe(el)
    // 观察每个字段:EP 日期选择器等控件异步撑高时,首行底边(flex-end 对齐)会整体下移,
    // 但容器被 max-height 夹住、其他字段自身尺寸不变,只观察容器/首字段会漏掉这次变化。
    for (const child of el.children) ro.observe(child)
  },
  { flush: 'post' },
)
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <!-- 桌面端:默认收起只露首行(高度按首行实测,见上),鼠标悬停/聚焦其内任一控件时展开全部 -->
  <div
    v-if="!isMobile"
    ref="barEl"
    class="filter-bar filter-bar--collapsible"
    :style="collapsedH ? { '--fb-collapsed-h': collapsedH } : undefined"
  >
    <slot />
  </div>

  <!-- 移动端 · 主控件形态(collapsible=false):不收进抽屉,就地铺开,但用紧凑版式
       (标签与控件同一行,一个字段 44px 而不是 66px) -->
  <div v-else-if="!collapsible" class="filter-bar filter-bar--mobile filter-bar--inline">
    <div class="filter-bar__panel"><slot /></div>
  </div>

  <!-- 移动端 · 筛选形态:开关 + 生效项;字段本体在底部抽屉里 -->
  <div v-else class="filter-bar filter-bar--mobile">
    <button type="button" class="filter-bar__toggle" @click="open = true">
      <SlidersHorizontal :size="16" />
      <span class="filter-bar__toggle-label">{{ label }}</span>
      <ChevronDown :size="16" class="filter-bar__chevron" />
    </button>

    <!-- 生效项:整颗 chip 可点 = 清掉这一条。只在真有条件时才占这一行。 -->
    <div v-if="activeList.length" class="filter-bar__chips">
      <button
        v-for="(f, i) in activeList"
        :key="i"
        type="button"
        class="filter-bar__chip"
        :disabled="!f.clear"
        :aria-label="f.clear ? `清除筛选:${f.label}` : f.label"
        @click="f.clear?.()"
      >
        <span>{{ f.label }}</span>
        <X v-if="f.clear" :size="12" />
      </button>
      <button v-if="canClearAll && activeList.length > 1" type="button" class="filter-bar__chip filter-bar__chip--all" @click="clearAll">
        重置
      </button>
    </div>

    <!-- ★底部抽屉而不是全屏抽屉:筛选是列表的旁支,不是「离开了列表」。
         留一截列表在上面露着,改完条件关掉就看见结果,心理上是连着的。
         高度按内容长(size="auto"),上限与滚动在 styles.css 的 .sb-filter-sheet 里。 -->
    <el-drawer v-model="open" class="sb-filter-sheet" direction="btt" size="auto" :title="label">
      <div class="filter-bar__panel"><slot /></div>
      <!-- 底栏用全局 .drawer-footer(不自拼):sticky、右对齐、手机上按钮平分整行,
           全站抽屉一个样 —— 这条有 ui-structure-contract 的护栏盯着。 -->
      <template #footer>
        <div class="drawer-footer">
          <!-- ★叫「重置」不叫「清空」:抽屉底栏的护栏把「清空」当破坏性动作,要求靠左标 danger ——
               而这里清的是筛选条件、不是数据,标成红色危险动作是误导。「重置」也和
               .filter-bar__actions 里各页自带的那颗同名(UI_SPEC:筛选栏只放查询/重置)。 -->
          <el-button v-if="canClearAll" @click="clearAll">重置</el-button>
          <el-button type="primary" @click="open = false">完成</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
/* 移动端容器:开关 + chips 纵向堆叠。
   ★不画卡片:全局 .filter-bar 那层边框 + 上下内边距 + 阴影是给「一排筛选字段」准备的,
   而这里永远只有一个开关(字段在抽屉里),那层外壳纯属白吃 26px 还像张空卡片。 */
.filter-bar--mobile {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sb-space-2);
  padding: 0;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
/* 主控件形态仍然画卡片:里面是页面的主控件(不是一个开关),需要一个边界把它和列表分开。
   把上面那条「不画卡片」逐项还原 —— 全局 .filter-bar 的值,不是新口径。 */
.filter-bar--inline {
  padding: var(--sb-space-3) var(--sb-pad-card);
  border-color: var(--sb-border);
  background: var(--sb-bg-card);
  box-shadow: var(--sb-shadow-card);
}
.filter-bar__toggle {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
  width: 100%;
  padding: var(--sb-space-1) 0;
  border: 0;
  background: transparent;
  color: var(--sb-text-primary);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.filter-bar__toggle-label {
  flex: 1;
  text-align: left;
}
.filter-bar__chevron {
  color: var(--sb-text-secondary);
}

/* ── 生效项 chips ──
   ★同「缩墨迹不缩命中区」那条:chip 看着 28px,命中区靠 ::after 补到 44px;
     换行时 row-gap 必须 ≥ 2×外扩量(44-28=16),否则上下两行命中区重叠,
     点下面那颗会清掉上面那条筛选 —— 而且看不出来。 */
.filter-bar__chips {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--sb-space-4) + var(--sb-space-1)) var(--sb-space-2); /* 行距 20px > 16px,留点富余 */
}
.filter-bar__chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--sb-space-1);
  height: 28px;
  padding: 0 var(--sb-space-3);
  border: 1px solid transparent; /* 只为与「清空」那颗对齐盒模型;本体靠 soft 底色 */
  border-radius: 999px;
  background: var(--sb-color-primary-soft);
  /* ★文字用 text-primary 不用 color-primary:主色写在 soft 底上,12px 的字实测只有
     浅色 4.28:1、暗色 3.42:1,都不到 AA 的 4.5 —— 「这是一条生效的筛选」由那层蓝底交代就够了,
     不必再赔上可读性。(暗金那档 5.68 是够的,但三档不该各长各的。) */
  color: var(--sb-text-primary);
  font-size: var(--sb-font-xs);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.filter-bar__chip::after {
  content: '';
  position: absolute;
  inset: -8px 0; /* 28 + 8×2 = 44 */
}
.filter-bar__chip:disabled {
  cursor: default;
}
.filter-bar__chip--all {
  border-color: var(--sb-border-strong);
  background: transparent;
  color: var(--sb-text-secondary);
}

/* ── 抽屉内的字段区 ──
   标签与控件改成**同一行**(原来是标签在上、控件在下,一个字段 66px;现在 44px)。
   ★用一个网格 + 字段 display:contents,让**所有标签共用一列**并按最长的那个定宽 ——
     字段各自为政的话「状态」和「国家/地区」两个控件左边会错开。
   ★slot 内容带的是页面的 scope id,不是本组件的,所以这里必须 :deep。 */
.filter-bar__panel {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: var(--sb-space-3) var(--sb-space-3);
}
.filter-bar__panel :deep(.filter-bar__field) {
  display: contents;
}
/* 单选按钮组/日期区间这类本身就要占一整行的控件:退回「标签在上、控件在下」并跨两列。
   ★:has() 已在本仓 styles.css 用过,老内核忽略整条规则 = 退回上面那条 contents,
     表现是控件被挤在右列里换行,不好看但不坏。 */
.filter-bar__panel :deep(.filter-bar__field:has(.el-radio-group)),
.filter-bar__panel :deep(.filter-bar__field:has(.el-date-editor--daterange)) {
  display: grid;
  grid-column: 1 / -1;
  gap: var(--sb-space-1);
}
/* 页面自带的「查询 / 重置」独占一行(UI_SPEC:.filter-bar__actions 只放这两个) */
.filter-bar__panel :deep(.filter-bar__actions) {
  grid-column: 1 / -1;
  margin-left: 0;
}
</style>
