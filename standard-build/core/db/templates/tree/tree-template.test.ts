// tree-template 的不变量测试。模块拷贝模板后,把这份测试一起拷走改造(换表名即可)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { COMMON_FIELDS_DDL, createTestDb, type TestDb } from '../../test-helpers'
import {
  buildPath,
  createNode,
  getSubtreeIds,
  moveNode,
  recomputeAllPaths,
  TreeError,
  demoTreeNodes,
} from './tree-template'
import type { Ctx } from '../../client'

let t: TestDb
const ctx: Ctx = { tenantId: randomUUID(), employeeId: randomUUID() }

beforeAll(async () => {
  t = await createTestDb()
  // demo 表仅测试时创建,不进生产迁移
  await t.raw.exec(`
    create table demo_tree_nodes (
      ${COMMON_FIELDS_DDL},
      parent_id uuid,
      path text not null,
      name text not null,
      sort integer not null default 0
    );
    create index demo_tree_tenant_parent_idx on demo_tree_nodes (tenant_id, parent_id);
    create index demo_tree_tenant_path_idx on demo_tree_nodes (tenant_id, path text_pattern_ops);
  `)
})
afterAll(async () => t.close())

describe('tree-template', () => {
  it('path = 父 path + 自身 id(根节点 /id/)', async () => {
    const root = await createNode(t.db, ctx, { name: 'root' })
    expect(root.path).toBe(`/${root.id}/`)
    const child = await createNode(t.db, ctx, { name: 'child', parentId: root.id })
    expect(child.path).toBe(`/${root.id}/${child.id}/`)
    expect(buildPath(root.path, child.id)).toBe(child.path)
  })

  it('子树查询返回自身 + 全部子孙', async () => {
    const a = await createNode(t.db, ctx, { name: 'a' })
    const b = await createNode(t.db, ctx, { name: 'b', parentId: a.id })
    const c = await createNode(t.db, ctx, { name: 'c', parentId: b.id })
    const other = await createNode(t.db, ctx, { name: 'other' })
    const ids = await getSubtreeIds(t.db, ctx.tenantId, a.id)
    expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id]))
    expect(ids).not.toContain(other.id)
  })

  it('防环:移到自己子树内被拒;移到自己下面被拒', async () => {
    const a = await createNode(t.db, ctx, { name: 'a' })
    const b = await createNode(t.db, ctx, { name: 'b', parentId: a.id })
    const c = await createNode(t.db, ctx, { name: 'c', parentId: b.id })
    await expect(moveNode(t.db, ctx, a.id, c.id)).rejects.toThrowError(TreeError) // a → 自己孙子下
    await expect(moveNode(t.db, ctx, a.id, a.id)).rejects.toThrowError(TreeError) // a → 自己下
    // 失败后路径未被破坏
    const expected = await recomputeAllPaths(t.db, ctx.tenantId)
    const ids = await getSubtreeIds(t.db, ctx.tenantId, a.id)
    expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id]))
    expect(expected.get(c.id)).toBe(`/${a.id}/${b.id}/${c.id}/`)
  })

  it('迁移级联:移有子孙的节点,整棵子树 path 重算正确(对账全等)', async () => {
    const r1 = await createNode(t.db, ctx, { name: 'r1' })
    const r2 = await createNode(t.db, ctx, { name: 'r2' })
    const m = await createNode(t.db, ctx, { name: 'm', parentId: r1.id })
    const m1 = await createNode(t.db, ctx, { name: 'm1', parentId: m.id })
    const m2 = await createNode(t.db, ctx, { name: 'm2', parentId: m1.id })

    await moveNode(t.db, ctx, m.id, r2.id) // 把 m 整棵子树从 r1 移到 r2 下

    const expected = await recomputeAllPaths(t.db, ctx.tenantId)
    expect(expected.get(m2.id)).toBe(`/${r2.id}/${m.id}/${m1.id}/${m2.id}/`)
    // 对账:重算 path 与库内存储全等
    const stored = await t.db.select({ id: demoTreeNodes.id, path: demoTreeNodes.path }).from(demoTreeNodes)
    for (const row of stored) {
      if (expected.has(row.id)) expect(row.path, `node ${row.id}`).toBe(expected.get(row.id))
    }
  })

  it('移为根节点(newParentId=null)', async () => {
    const r = await createNode(t.db, ctx, { name: 'r' })
    const x = await createNode(t.db, ctx, { name: 'x', parentId: r.id })
    await moveNode(t.db, ctx, x.id, null)
    const expected = await recomputeAllPaths(t.db, ctx.tenantId)
    expect(expected.get(x.id)).toBe(`/${x.id}/`)
  })

  it('幂等:移到当前父节点下是 no-op', async () => {
    const r = await createNode(t.db, ctx, { name: 'r' })
    const x = await createNode(t.db, ctx, { name: 'x', parentId: r.id })
    await moveNode(t.db, ctx, x.id, r.id)
    await moveNode(t.db, ctx, x.id, r.id)
    const expected = await recomputeAllPaths(t.db, ctx.tenantId)
    expect(expected.get(x.id)).toBe(`/${r.id}/${x.id}/`)
  })

  it('租户隔离:跨租户看不到节点', async () => {
    const a = await createNode(t.db, ctx, { name: 'a' })
    const otherCtx: Ctx = { tenantId: randomUUID(), employeeId: randomUUID() }
    await expect(getSubtreeIds(t.db, otherCtx.tenantId, a.id)).rejects.toThrowError(TreeError)
  })
})
