// core/org/logic/department-tree.ts
// 部门树:★拷贝改造自 core/db/templates/tree/tree-template.ts(防环 + path 级联那段危险逻辑
// 与模板同源,模板侧已有完整测试;本文件自包含,不 import 模板)。
// 在模板之上叠加 org 业务规则:删除/禁用保护(不许出现孤儿员工)。
import { randomUUID } from 'node:crypto'
import { and, asc, count, eq, inArray, like, ne, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../../db/client'
import { auditedUpdate, scope } from '../../db/soft-delete'
import { departments, employees, type Department } from '../model'
import { OrgError } from './errors'

const TREE_LOCK_KEY = 'org-dept-tree'

/** path = 父 path + 自身 id + '/';根部门 path = '/' + id + '/' */
export function buildPath(parentPath: string | null, id: string): string {
  return (parentPath ?? '/') + id + '/'
}

/** 事务内取 per-tenant 树锁:防环校验是"读后写",并发 move 可能成环,同租户树变更串行化 */
async function lockTree(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId + ':' + TREE_LOCK_KEY}))`)
}

export async function getDepartment(db: Db, tenantId: string, id: string): Promise<Department | null> {
  const rows = await db
    .select()
    .from(departments)
    .where(and(scope(departments, tenantId), eq(departments.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export async function createDepartment(
  db: Db,
  ctx: Ctx,
  input: { name: string; parentId?: string | null; sort?: number; isAccountingEntity?: boolean },
): Promise<Department> {
  const id = randomUUID()
  let parentPath: string | null = null
  if (input.parentId) {
    const parent = await getDepartment(db, ctx.tenantId, input.parentId)
    if (!parent) throw new OrgError('PARENT_NOT_FOUND', `parent department ${input.parentId} not found`)
    parentPath = parent.path
  }
  const path = buildPath(parentPath, id)
  // 根部门(无父)恒为独立核算;非根勾选时跑嵌套约束(祖先非根已是实体 → 拒绝)。
  // 新建时本身无子孙,故只查祖先链。
  const isRoot = !input.parentId
  let isAccountingEntity = isRoot ? true : !!input.isAccountingEntity
  if (isAccountingEntity && !isRoot) {
    await assertNoEntityAncestor(db, ctx.tenantId, path)
  }
  const rows = await db
    .insert(departments)
    .values({
      id,
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      parentId: input.parentId ?? null,
      path,
      name: input.name,
      sort: input.sort ?? 0,
      isAccountingEntity,
    })
    .returning()
  return rows[0]!
}

/** path = `/rootId/.../selfId/` → 真祖先 id 列表(不含自身),首个是根。 */
function ancestorIds(path: string): string[] {
  const segs = path.split('/').filter(Boolean)
  return segs.slice(0, -1) // 去掉自身(末段)
}

/** 嵌套约束之一:除根外,任一真祖先已是独立核算 → 不允许本节点再独立核算。 */
async function assertNoEntityAncestor(db: Db, tenantId: string, path: string): Promise<void> {
  const ancestors = ancestorIds(path)
  const nonRootAncestors = ancestors.slice(1) // 去掉根(根允许是实体)
  if (nonRootAncestors.length === 0) return
  const [hit] = await db
    .select({ n: count() })
    .from(departments)
    .where(
      and(
        scope(departments, tenantId),
        inArray(departments.id, nonRootAncestors),
        eq(departments.isAccountingEntity, true),
      ),
    )
  if (Number(hit!.n) > 0) {
    throw new OrgError('NESTED_ACCOUNTING_ENTITY', '上级部门已是财务独立核算,不可再嵌套独立核算')
  }
}

/** 嵌套约束之二:本节点子树内(不含自身)已有独立核算节点 → 不允许本节点再独立核算。 */
async function assertNoEntityDescendant(db: Db, tenantId: string, dept: Department): Promise<void> {
  const [hit] = await db
    .select({ n: count() })
    .from(departments)
    .where(
      and(
        scope(departments, tenantId),
        like(departments.path, dept.path + '%'),
        ne(departments.id, dept.id),
        eq(departments.isAccountingEntity, true),
      ),
    )
  if (Number(hit!.n) > 0) {
    throw new OrgError('NESTED_ACCOUNTING_ENTITY', '下级部门已是财务独立核算,不可再设本部门为独立核算')
  }
}

/**
 * 开启/关闭部门「财务独立核算」。
 * - 开启:跑嵌套约束(祖先非根 + 子孙均不得已是实体)。
 * - 关闭:根部门禁止关闭;「已有账务数据则禁止」由 finance 侧守卫(本函数不跨模块查 finance 表)。
 * 幂等:目标值与当前一致直接返回。
 */
export async function setDepartmentAccountingEntity(db: Db, ctx: Ctx, deptId: string, value: boolean): Promise<void> {
  const dept = await getDepartment(db, ctx.tenantId, deptId)
  if (!dept) throw new OrgError('NOT_FOUND', `department ${deptId} not found`)
  if (dept.isAccountingEntity === value) return // 幂等
  const isRoot = dept.parentId === null
  if (!value) {
    if (isRoot) throw new OrgError('ROOT_ENTITY_LOCKED', '根部门为默认独立核算账套,不可关闭')
  } else if (!isRoot) {
    await assertNoEntityAncestor(db, ctx.tenantId, dept.path)
    await assertNoEntityDescendant(db, ctx.tenantId, dept)
  }
  await db
    .update(departments)
    .set({ isAccountingEntity: value, updatedBy: ctx.employeeId, updatedAt: new Date() })
    .where(and(scope(departments, ctx.tenantId), eq(departments.id, deptId)))
}

/** 编辑部门详情:名称 + 排序(不动父子关系——改上级走 moveDepartment)。 */
export async function updateDepartment(
  db: Db,
  ctx: Ctx,
  id: string,
  input: { name: string; sort?: number },
): Promise<Department> {
  const dept = await getDepartment(db, ctx.tenantId, id)
  if (!dept) throw new OrgError('NOT_FOUND', `department ${id} not found`)
  const name = input.name.trim()
  if (!name) throw new OrgError('INVALID_INPUT', '部门名称不能为空')
  await auditedUpdate(db, departments, ctx.tenantId, id, ctx.employeeId, {
    name,
    sort: input.sort ?? dept.sort,
  })
  return (await getDepartment(db, ctx.tenantId, id))!
}

/** 子树部门 id 列表(含自身)。数据权限 DEPT_AND_SUB 用。一条 SQL 走 pattern_ops 索引。 */
export async function getDeptSubtreeIds(db: Db, tenantId: string, deptId: string): Promise<string[]> {
  const dept = await getDepartment(db, tenantId, deptId)
  if (!dept) throw new OrgError('NOT_FOUND', `department ${deptId} not found`)
  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(scope(departments, tenantId), like(departments.path, dept.path + '%')))
  return rows.map((r) => r.id)
}

/**
 * 部门迁移(★防环 + 级联重算整棵子树 path,单事务全成或回滚)。
 * newParentId = null 表示移为根部门。幂等:移到当前父节点下是 no-op。
 */
export async function moveDepartment(db: Db, ctx: Ctx, deptId: string, newParentId: string | null): Promise<void> {
  if (deptId === newParentId) throw new OrgError('CYCLE_DETECTED', 'cannot set parent to self')
  await db.transaction(async (tx) => {
    await lockTree(tx, ctx.tenantId)
    const dept = await getDepartment(tx, ctx.tenantId, deptId)
    if (!dept) throw new OrgError('NOT_FOUND', `department ${deptId} not found`)
    if (dept.parentId === newParentId) return // no-op,幂等

    let newParentPath: string | null = null
    if (newParentId) {
      const parent = await getDepartment(tx, ctx.tenantId, newParentId)
      if (!parent) throw new OrgError('PARENT_NOT_FOUND', `parent department ${newParentId} not found`)
      // ★防环:目标父部门在自己子树内 → 成环
      if (parent.path.startsWith(dept.path)) {
        throw new OrgError('CYCLE_DETECTED', `department ${newParentId} is inside subtree of ${deptId}`)
      }
      newParentPath = parent.path
    }

    const oldPath = dept.path
    const newPath = buildPath(newParentPath, deptId)
    await tx
      .update(departments)
      .set({ parentId: newParentId, updatedBy: ctx.employeeId, updatedAt: new Date() })
      .where(and(eq(departments.tenantId, ctx.tenantId), eq(departments.id, deptId)))
    // ★级联:一条 UPDATE 前缀替换自身 + 全部子孙的 path(path 是 uuid+'/',无 LIKE 通配符)
    await tx.execute(sql`
      update departments
      set path = ${newPath} || substring(path from (${oldPath.length + 1})::int),
          updated_by = ${ctx.employeeId},
          updated_at = now()
      where tenant_id = ${ctx.tenantId}
        and path like ${oldPath + '%'}
    `)
  })
}

/** 删除/禁用保护:还有在职员工或未删子部门的部门,禁止删除/禁用(防孤儿员工/孤儿子树) */
async function assertDeptRemovable(db: Db, tenantId: string, deptId: string): Promise<void> {
  const [child] = await db
    .select({ n: count() })
    .from(departments)
    .where(and(scope(departments, tenantId), eq(departments.parentId, deptId)))
  if (Number(child!.n) > 0) {
    throw new OrgError('DEPT_HAS_CHILDREN', '请先删除子部门')
  }
  const [emp] = await db
    .select({ n: count() })
    .from(employees)
    .where(and(scope(employees, tenantId), eq(employees.departmentId, deptId), eq(employees.status, 'active')))
  if (Number(emp!.n) > 0) {
    throw new OrgError('DEPT_HAS_ACTIVE_EMPLOYEES', '请先移走部门内的员工')
  }
}

export async function deleteDepartment(db: Db, ctx: Ctx, deptId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertDeptRemovable(tx, ctx.tenantId, deptId)
    const dept = await getDepartment(tx, ctx.tenantId, deptId)
    if (!dept) throw new OrgError('NOT_FOUND', `department ${deptId} not found`)
    await tx
      .update(employees)
      .set({ departmentId: null, updatedBy: ctx.employeeId, updatedAt: new Date() })
      .where(and(scope(employees, ctx.tenantId), eq(employees.departmentId, deptId)))
    await tx.delete(departments).where(and(eq(departments.tenantId, ctx.tenantId), eq(departments.id, deptId)))
  })
}

export async function setDepartmentStatus(db: Db, ctx: Ctx, deptId: string, status: 'active' | 'disabled'): Promise<void> {
  if (status === 'disabled') await assertDeptRemovable(db, ctx.tenantId, deptId)
  await db
    .update(departments)
    .set({ status, updatedBy: ctx.employeeId, updatedAt: new Date() })
    .where(and(scope(departments, ctx.tenantId), eq(departments.id, deptId)))
}

/** 整树一次拉(部门量级小,几百以内,不分页;排序:同级按 sort) */
export async function listDepartments(db: Db, ctx: Ctx): Promise<Department[]> {
  return db
    .select()
    .from(departments)
    .where(scope(departments, ctx.tenantId))
    .orderBy(asc(departments.path), asc(departments.sort))
}

/**
 * 选部门下拉专用:返回全租户部门轻量清单(id/name/parentId/status)。
 * 供各业务页「选部门下拉」使用。
 * ★关键:不要求 org:view。部门下拉需要部门全集,而能进业务页的用户(财务等)
 *   通常没有 org:view——原打 GET /api/org/departments(org:view 门控)会 403 空白。
 *   部门本就不做数据权限过滤(非 owner 维度),仅按租户隔离,登录即可用。
 *   详见 skill ref-picker-scope-audit。
 */
export async function listDepartmentPicker(
  db: Db,
  tenantId: string,
): Promise<{ id: string; name: string; parentId: string | null; status: string }[]> {
  return db
    .select({
      id: departments.id,
      name: departments.name,
      parentId: departments.parentId,
      status: departments.status,
    })
    .from(departments)
    .where(scope(departments, tenantId))
    .orderBy(asc(departments.path), asc(departments.sort))
}

/**
 * 对账:按 parent_id 链重算每个部门的期望 path(不变量1/9 的测试依据)。
 * 若 parent 链成环或指向已删部门,抛错。
 */
export async function recomputeDeptPaths(db: Db, tenantId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: departments.id, parentId: departments.parentId })
    .from(departments)
    .where(scope(departments, tenantId))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const expected = new Map<string, string>()

  function compute(id: string, visiting: Set<string>): string {
    const cached = expected.get(id)
    if (cached) return cached
    if (visiting.has(id)) throw new OrgError('CYCLE_DETECTED', `department parent cycle at ${id}`)
    visiting.add(id)
    const row = byId.get(id)
    if (!row) throw new OrgError('NOT_FOUND', `parent department ${id} missing or deleted`)
    const parentPath = row.parentId ? compute(row.parentId, visiting) : null
    const p = buildPath(parentPath, id)
    expected.set(id, p)
    return p
  }

  for (const r of rows) compute(r.id, new Set())
  return expected
}
