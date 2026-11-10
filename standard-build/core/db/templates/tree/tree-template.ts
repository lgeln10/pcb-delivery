// core/db/templates/tree/tree-template.ts
// ★标准实现模板:树结构(parent_id + path 双字段)。带完整测试(tree-template.test.ts)。
//
// 【用法】拷贝本文件到你的模块,把 demoTreeNodes 换成你自己的表(org 部门树、finance 科目树、将来 BOM 树),
// 删掉 demo 表定义,按需改造。**不要 import 本文件**——模板是拷贝源,不是共享库(docs/DATA_MODEL.md §3)。
//
// 【为什么是模板不是基类】共享基类制造跨模块依赖,改基类炸所有树。拷贝让每个模块的树代码自包含,
// 但都源自这份带测试的正确实现——防环 + 迁移级联是高风险逻辑,别让 AI 每次重写。
//
// 【核心设计】
// - parent_id 查直接上下级;path 存全路径 `/<rootId>/.../<selfId>/`(含自身)用于一次查整棵子树
// - 子树查询:path LIKE node.path || '%',走 (tenant_id, path text_pattern_ops) 索引
//   (path 由 uuid 和 '/' 组成,不含 LIKE 通配符,无需转义)
// - 防环:新父节点的 path 若以自己的 path 为前缀,说明目标在自己子树内 → 拒绝
// - 迁移级联:单事务内,改 parent_id + 一条 UPDATE 前缀替换整棵子树的 path
// - 并发防环:防环校验是"读后写",并发两个 move 可能互查通过后提交成环。
//   事务内先取 per-tenant advisory lock,同租户树变更串行化(树变更低频,锁粒度合理)
import { randomUUID } from 'node:crypto'
import { and, eq, like, sql } from 'drizzle-orm'
import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { commonFields } from '../../common-fields'
import type { Ctx, Db } from '../../client'

// ── demo 表(仅测试时建表,不进生产迁移;拷贝时换成你的表)────────────────────
export const demoTreeNodes = pgTable(
  'demo_tree_nodes',
  {
    ...commonFields,
    parentId: uuid('parent_id'), // 根节点为 null;自引用 FK 在迁移里加,demo 表省略
    path: text('path').notNull(),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [
    index('demo_tree_tenant_parent_idx').on(t.tenantId, t.parentId),
    index('demo_tree_tenant_path_idx').using('btree', t.tenantId, t.path.op('text_pattern_ops')),
  ],
)

export class TreeError extends Error {
  constructor(
    public code: 'NODE_NOT_FOUND' | 'PARENT_NOT_FOUND' | 'CYCLE_DETECTED',
    message: string,
  ) {
    super(message)
    this.name = 'TreeError'
  }
}

const TREE_LOCK_KEY = 'demo-tree' // 拷贝时改成你的表名,避免与其他树共用锁

/** path = 父 path + 自身 id + '/';根节点 path = '/' + id + '/' */
export function buildPath(parentPath: string | null, id: string): string {
  return (parentPath ?? '/') + id + '/'
}

/** 事务内取 per-tenant 树锁,串行化同租户的树结构变更(防并发成环) */
async function lockTree(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId + ':' + TREE_LOCK_KEY}))`)
}

async function getNode(db: Db, tenantId: string, id: string) {
  const rows = await db
    .select()
    .from(demoTreeNodes)
    .where(and(eq(demoTreeNodes.tenantId, tenantId), eq(demoTreeNodes.isDeleted, false), eq(demoTreeNodes.id, id)))
    .limit(1)
  return rows[0] ?? null
}

/** 创建节点:客户端生成 id 以便插入前算出 path */
export async function createNode(
  db: Db,
  ctx: Ctx,
  input: { name: string; parentId?: string | null; sort?: number },
): Promise<typeof demoTreeNodes.$inferSelect> {
  const id = randomUUID()
  let parentPath: string | null = null
  if (input.parentId) {
    const parent = await getNode(db, ctx.tenantId, input.parentId)
    if (!parent) throw new TreeError('PARENT_NOT_FOUND', `parent ${input.parentId} not found`)
    parentPath = parent.path
  }
  const rows = await db
    .insert(demoTreeNodes)
    .values({
      id,
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      parentId: input.parentId ?? null,
      path: buildPath(parentPath, id),
      name: input.name,
      sort: input.sort ?? 0,
    })
    .returning()
  return rows[0]!
}

/** 子树节点 id 列表(含自身)。一条 SQL,LIKE 前缀走 pattern_ops 索引。 */
export async function getSubtreeIds(db: Db, tenantId: string, nodeId: string): Promise<string[]> {
  const node = await getNode(db, tenantId, nodeId)
  if (!node) throw new TreeError('NODE_NOT_FOUND', `node ${nodeId} not found`)
  const rows = await db
    .select({ id: demoTreeNodes.id })
    .from(demoTreeNodes)
    .where(
      and(eq(demoTreeNodes.tenantId, tenantId), eq(demoTreeNodes.isDeleted, false), like(demoTreeNodes.path, node.path + '%')),
    )
  return rows.map((r) => r.id)
}

/**
 * 迁移节点(★防环 + 级联重算整棵子树 path,单事务,要么全成要么回滚)。
 * newParentId = null 表示移为根节点。幂等:移到当前父节点下是 no-op。
 */
export async function moveNode(db: Db, ctx: Ctx, nodeId: string, newParentId: string | null): Promise<void> {
  if (nodeId === newParentId) throw new TreeError('CYCLE_DETECTED', 'cannot set parent to self')
  await db.transaction(async (tx) => {
    await lockTree(tx, ctx.tenantId)
    const node = await getNode(tx, ctx.tenantId, nodeId)
    if (!node) throw new TreeError('NODE_NOT_FOUND', `node ${nodeId} not found`)
    if (node.parentId === newParentId) return // no-op,幂等

    let newParentPath: string | null = null
    if (newParentId) {
      const parent = await getNode(tx, ctx.tenantId, newParentId)
      if (!parent) throw new TreeError('PARENT_NOT_FOUND', `parent ${newParentId} not found`)
      // ★防环:目标父节点在自己子树内(其 path 以自己的 path 为前缀)→ 成环
      if (parent.path.startsWith(node.path)) {
        throw new TreeError('CYCLE_DETECTED', `${newParentId} is inside subtree of ${nodeId}`)
      }
      newParentPath = parent.path
    }

    const oldPath = node.path
    const newPath = buildPath(newParentPath, nodeId)
    await tx
      .update(demoTreeNodes)
      .set({ parentId: newParentId })
      .where(and(eq(demoTreeNodes.tenantId, ctx.tenantId), eq(demoTreeNodes.id, nodeId)))
    // ★级联:一条 UPDATE 前缀替换自身 + 全部子孙的 path。
    // 用 substring 而非 replace:明确"只换前缀",不存在中段误替换的论证负担。
    await tx.execute(sql`
      update demo_tree_nodes
      set path = ${newPath} || substring(path from (${oldPath.length + 1})::int),
          updated_by = ${ctx.employeeId},
          updated_at = now()
      where tenant_id = ${ctx.tenantId}
        and path like ${oldPath + '%'}
    `)
  })
}

/**
 * 对账:按 parent_id 链重算每个节点的期望 path(不变量"path 与 parent_id 链一致"的测试依据)。
 * 返回 Map<id, expectedPath>;若 parent 链成环或断裂,抛错。
 */
export async function recomputeAllPaths(db: Db, tenantId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: demoTreeNodes.id, parentId: demoTreeNodes.parentId })
    .from(demoTreeNodes)
    .where(and(eq(demoTreeNodes.tenantId, tenantId), eq(demoTreeNodes.isDeleted, false)))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const expected = new Map<string, string>()

  function compute(id: string, visiting: Set<string>): string {
    const cached = expected.get(id)
    if (cached) return cached
    if (visiting.has(id)) throw new TreeError('CYCLE_DETECTED', `cycle at ${id}`)
    visiting.add(id)
    const row = byId.get(id)
    if (!row) throw new TreeError('NODE_NOT_FOUND', `parent ${id} missing or deleted`)
    const parentPath = row.parentId ? compute(row.parentId, visiting) : null
    const p = buildPath(parentPath, id)
    expected.set(id, p)
    return p
  }

  for (const r of rows) compute(r.id, new Set())
  return expected
}
