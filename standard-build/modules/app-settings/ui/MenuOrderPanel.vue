<script setup lang="ts">
// modules/app-settings/ui/MenuOrderPanel.vue
// 菜单排序(系统设置内的一个 tab):拖拽调整一级菜单(分组)之间、以及同一分组内二级菜单之间的顺序。
// 保存后写 menu_orders 表,全系统所有用户即时生效(统一顺序)。
// ★口径:
//   - 展示全部一级 + 二级菜单(含被功能开关关闭的),排序后仍按功能开关规则隐藏/显示(见 App.vue)。
//   - 只排一级/二级两层;二级文件夹内的三级子菜单只读展示、不可拖拽(需求不含三级排序)。
//   - 排序不隐藏任何菜单:缺失 key 回落目录原序、未知 key 忽略 —— 核心入口天然排得进去,不会自锁。
import { computed, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import AsyncState from '../../../core/ui-kit/AsyncState.vue'
import { NAV_CATALOG, isNavFolder } from '../../../src/nav-catalog'
import {
  apiGetMenuOrder,
  apiMyPermissions,
  apiSaveMenuOrder,
  errorMessage,
  isForbidden,
  type MenuOrderDTO,
} from '../../../src/api/client'

const queryClient = useQueryClient()

const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canManage = computed(() => {
  const c = myPermsQuery.data.value?.codes
  return c === null || (Array.isArray(c) && c.includes('menu-order:manage'))
})

const orderQuery = useQuery({ queryKey: ['menu-order'], queryFn: apiGetMenuOrder })

// el-tree 节点:node-key 用带前缀的 id 保证全树唯一(分组 key 与菜单 key 可能同形);
// key 保留真实 nav key,序列化时用它。level3 = 文件夹内子菜单(只读,不可拖)。
type TreeNode = { id: string; key: string; label: string; kind: 'group' | 'item' | 'child'; children?: TreeNode[] }

/** 按 [已保存顺序 → 目录原序] 稳定重排一层 key。缺失回落原序追加,未知忽略(不在 list 里就不会出现)。 */
function orderKeys<T>(list: T[], keyOf: (x: T) => string, order: string[]): T[] {
  if (!order.length) return list
  const rank = new Map(order.map((k, i) => [k, i]))
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.get(keyOf(a.item)) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(keyOf(b.item)) ?? Number.MAX_SAFE_INTEGER
      return ra === rb ? a.i - b.i : ra - rb
    })
    .map((x) => x.item)
}

// 由 nav-catalog + 已保存顺序 组装展示树。draggable 会就地改动这个数组,保存时按其顺序序列化。
const treeData = ref<TreeNode[]>([])
function buildTree(saved: MenuOrderDTO): TreeNode[] {
  const groups = orderKeys([...NAV_CATALOG], (g) => g.key, saved.groups)
  return groups.map((g) => {
    const items = orderKeys([...g.items], (e) => e.key, saved.items[g.key] ?? [])
    return {
      id: `g:${g.key}`,
      key: g.key,
      label: g.label,
      kind: 'group',
      children: items.map((entry) => {
        if (isNavFolder(entry)) {
          return {
            id: `i:${entry.key}`,
            key: entry.key,
            label: entry.label,
            kind: 'item',
            // 文件夹内三级子菜单:只读展示,不参与排序
            children: entry.children.map((c) => ({ id: `c:${c.key}`, key: c.key, label: c.label, kind: 'child' as const })),
          }
        }
        return { id: `i:${entry.key}`, key: entry.key, label: entry.label, kind: 'item' as const }
      }),
    }
  })
}
watch(
  () => orderQuery.data.value,
  (v) => { if (v) treeData.value = buildTree(v) },
  { immediate: true },
)

// 拖拽约束:只能在同一层、同一父节点内前后移动;不允许嵌套(inner)、不允许跨分组、三级不可拖。
function allowDrag(node: { level: number }) {
  return node.level <= 2 // 一级(分组)/ 二级(菜单)可拖;三级(文件夹子菜单)只读
}
function allowDrop(
  dragNode: { level: number; parent?: unknown },
  dropNode: { level: number; parent?: unknown },
  type: 'prev' | 'inner' | 'next',
) {
  if (type === 'inner') return false // 不改变层级归属
  if (dragNode.level !== dropNode.level) return false
  if (dragNode.level === 1) return true // 一级分组之间自由排
  if (dragNode.level === 2) return dragNode.parent === dropNode.parent // 二级菜单只在本分组内排
  return false
}

function serialize(): MenuOrderDTO {
  const groups = treeData.value.map((g) => g.key)
  const items: Record<string, string[]> = {}
  for (const g of treeData.value) items[g.key] = (g.children ?? []).map((it) => it.key)
  return { groups, items }
}

const saveMutation = useMutation({
  mutationFn: () => apiSaveMenuOrder(serialize()),
  onSuccess: async (data) => {
    ElMessage.success('菜单顺序已保存,全系统即时生效')
    queryClient.setQueryData(['menu-order'], data)
    // App.vue 侧边栏读的是 ['menu-order', isAuthenticated] —— 一并失效,立即重排
    await queryClient.invalidateQueries({ queryKey: ['menu-order'] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

function resetOrder() {
  if (orderQuery.data.value) treeData.value = buildTree(orderQuery.data.value)
}
</script>

<template>
  <section class="module-surface">
    <div class="module-toolbar">
      <p class="t-caption">
        拖拽调整菜单顺序:一级菜单(分组)之间上下拖动、同一分组内的二级菜单之间上下拖动。
        保存后左侧导航对所有用户即时生效。被功能开关关闭的菜单在此仍可见,排序后仍按开关规则隐藏/显示。
        (二级文件夹内的子菜单只读展示,不参与排序。)
      </p>
    </div>

    <AsyncState
      :loading="orderQuery.isLoading.value"
      :error="orderQuery.error.value && !isForbidden(orderQuery.error.value) ? errorMessage(orderQuery.error.value) : null"
      :forbidden="isForbidden(orderQuery.error.value)"
      :empty="false"
      @retry="orderQuery.refetch"
    >
      <section class="panel mo-panel">
        <div class="panel-toolbar"><h2 class="panel-title">菜单排序</h2></div>
        <el-tree
          :data="treeData"
          node-key="id"
          default-expand-all
          :expand-on-click-node="false"
          :draggable="canManage"
          :allow-drag="allowDrag"
          :allow-drop="allowDrop"
          class="mo-tree"
        >
          <template #default="{ data }">
            <span
              class="mo-node"
              :class="{ 'mo-node--group': data.kind === 'group', 'mo-node--child': data.kind === 'child' }"
            >
              <strong v-if="data.kind === 'group'">{{ data.label }}</strong>
              <span v-else>{{ data.label }}</span>
              <span v-if="data.kind === 'child'" class="t-caption muted">(文件夹子菜单,不排序)</span>
            </span>
          </template>
        </el-tree>

        <div v-if="canManage" class="form-actions">
          <el-button type="primary" :loading="saveMutation.isPending.value" @click="saveMutation.mutate()">保存顺序</el-button>
          <el-button text :disabled="saveMutation.isPending.value" @click="resetOrder">还原</el-button>
        </div>
      </section>
    </AsyncState>
  </section>
</template>

<style scoped>
.mo-panel {
  max-width: 640px;
}
.mo-tree {
  background: transparent;
}
.mo-node {
  display: inline-flex;
  align-items: center;
  gap: var(--sb-space-2);
}
.mo-node--group {
  font-weight: 600;
}
.mo-node--child {
  color: var(--sb-text-secondary);
}
.muted {
  color: var(--sb-text-secondary);
}
.form-actions {
  margin-top: var(--sb-space-5);
  display: flex;
  gap: var(--sb-space-2);
}
</style>
