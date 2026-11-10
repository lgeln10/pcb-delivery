// core/org/api.ts
// ★org 对外接口唯一入口(DATA_MODEL_org §3)。其他模块(partner/document/finance/…)
// 只准 import 这个文件,禁止直接读 org 的表或 import logic/ 内部文件。
//
// 典型用法:
// - document 审批找审批人 → getLeaderChain
// - finance "销售只看自己的应收" → getDataScope 拿到 SELF,按 created_by 过滤
// - 任何"本部门及子部门"汇总 → getDeptSubtree
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { scope } from '../db/soft-delete'
import { departments, employees, type Employee } from './model'
import { getDeptSubtreeIds, setDepartmentAccountingEntity as setDepartmentAccountingEntityImpl } from './logic/department-tree'
import { getLeaderChain as getLeaderChainImpl } from './logic/employee'
import {
  getDataScope as getDataScopeImpl,
  hasPermission as hasPermissionImpl,
  listEmployeeIdsWithPermission as listEmployeeIdsWithPermissionImpl,
  type DataScope,
  type DataScopeResult,
} from './logic/data-scope'
import { OrgError } from './logic/errors'
import { markEmployeeLeft, setLeader, updateEmployee } from './logic/employee'
import { hasRole, syncPermissions, type PermissionDef } from './logic/role'

export type { DataScope, DataScopeResult, Employee, PermissionDef }
export { OrgError, syncPermissions, hasRole } // syncPermissions:各模块启动时幂等注册自己的权限点

/** 当前登录员工(ctx 由 core/auth 解析登录态构造) */
export async function getCurrentEmployee(db: Db, ctx: Ctx): Promise<Employee> {
  const rows = await db
    .select()
    .from(employees)
    .where(and(scope(employees, ctx.tenantId), eq(employees.id, ctx.employeeId)))
    .limit(1)
  if (!rows[0]) throw new OrgError('NOT_FOUND', `employee ${ctx.employeeId} not found`)
  return rows[0]
}

/** 某员工所在部门(只读 {id,name})。供按部门派生跟进标签等用;员工/部门不存在返回 null。 */
export async function getEmployeeDepartment(
  db: Db,
  tenantId: string,
  empId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: departments.id, name: departments.name })
    .from(employees)
    .innerJoin(departments, eq(departments.id, employees.departmentId))
    .where(and(scope(employees, tenantId), eq(employees.id, empId)))
    .limit(1)
  return rows[0] ?? null
}

/** 指定员工的会计取数资料。业务模块生成可追溯凭证时使用 ID 做辅助核算、名称做摘要展示。 */
export async function getEmployeeAccountingProfile(
  db: Db,
  tenantId: string,
  employeeId: string,
): Promise<{ id: string; name: string; departmentId: string | null; departmentName: string | null } | null> {
  const rows = await db
    .select({ id: employees.id, name: employees.name, departmentId: employees.departmentId, departmentName: departments.name })
    .from(employees)
    .leftJoin(departments, eq(departments.id, employees.departmentId))
    .where(and(scope(employees, tenantId), eq(employees.id, employeeId)))
    .limit(1)
  return rows[0] ?? null
}

/** 某部门的整棵子树部门 id 列表(含自身)。数据权限 DEPT_AND_SUB 用。 */
export async function getDeptSubtree(db: Db, tenantId: string, deptId: string): Promise<string[]> {
  return getDeptSubtreeIds(db, tenantId, deptId)
}

export type AccountingEntity = { id: string; name: string; path: string }

/**
 * ★租户内全部「财务独立核算」部门(= 一套套独立的账)。供标题栏组织切换器 + finance entity 解析。
 * 只读、按 path 排序(根在前)。部门量级小,不分页。
 */
export async function listAccountingEntities(db: Db, tenantId: string): Promise<AccountingEntity[]> {
  return db
    .select({ id: departments.id, name: departments.name, path: departments.path })
    .from(departments)
    .where(and(scope(departments, tenantId), eq(departments.isAccountingEntity, true)))
    .orderBy(asc(departments.path))
}

/** 根部门 id(parent_id is null)。= 默认账套实体。 */
export async function getRootEntityId(db: Db, tenantId: string): Promise<string | null> {
  const rows = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(scope(departments, tenantId), isNull(departments.parentId)))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * ★解析要切到的账套实体。requestedId 是合法独立核算部门 → 用它;没给 → 根部门(默认账套)。
 * 找不到任何实体时返回 null(理论不会:根恒为实体)。
 *
 * ★requestedId 给了但不合法时怎么办,取决于**这个 id 是哪来的**,所以由调用方显式选:
 * - `'throw'`(默认):这是用户这次的明确指令(接口入参、显式切账套)。默默换一套账返回,
 *   等于「你要 A 账套,我给你根账套的数字」—— 财务场景下这是最坏的一种静默。
 * - `'fallbackToRoot'`:这是**环境里带来的陈旧状态**,典型是浏览器 localStorage 里存的
 *   当前账套(见 core/http/middleware.ts)。那种情况下抛错会把人锁死,见那里的注释。
 */
export async function resolveAccountingEntity(
  db: Db,
  tenantId: string,
  requestedId?: string | null,
  opts: { onInvalid?: 'throw' | 'fallbackToRoot' } = {},
): Promise<string | null> {
  if (requestedId) {
    const rows = await db
      .select({ id: departments.id })
      .from(departments)
      .where(
        and(scope(departments, tenantId), eq(departments.id, requestedId), eq(departments.isAccountingEntity, true)),
      )
      .limit(1)
    if (rows[0]) return rows[0].id
    if ((opts.onInvalid ?? 'throw') === 'throw') {
      throw new OrgError('INVALID_INPUT', '指定账套不存在、已停用或不属于当前企业')
    }
  }
  return getRootEntityId(db, tenantId)
}

/**
 * 账套级财务操作必须同时满足功能权限和数据范围。SELF 只适用于个人业务数据，
 * 不能读取或修改整套账；部门范围仅允许操作该部门本身作为独立核算组织的账套。
 */
export async function assertAccountingEntityAccess(db: Db, ctx: Ctx, permCode: string): Promise<void> {
  if (!ctx.entityId) throw new OrgError('INVALID_INPUT', '当前未选择账套')
  const dataScope = await getDataScopeImpl(db, ctx.tenantId, ctx.employeeId, permCode)
  if (dataScope.kind === 'ALL') return
  if ((dataScope.kind === 'DEPT' || dataScope.kind === 'DEPT_AND_SUB') && dataScope.departmentIds.includes(ctx.entityId)) return
  throw new OrgError('ACCOUNTING_ENTITY_FORBIDDEN', '当前权限的数据范围不能访问所选账套，请切换账套或联系财务管理员')
}

/** 报销等业务单据按业务主体部门归属最近的独立核算组织，禁止手工跨账套归属。 */
export async function getEmployeeAccountingEntity(db: Db, tenantId: string, employeeId: string): Promise<string | null> {
  const [employee] = await db
    .select({ departmentPath: departments.path })
    .from(employees)
    .innerJoin(departments, eq(departments.id, employees.departmentId))
    .where(and(scope(employees, tenantId), eq(employees.id, employeeId)))
    .limit(1)
  if (!employee) return null
  const entities = await db
    .select({ id: departments.id, path: departments.path })
    .from(departments)
    .where(and(scope(departments, tenantId), eq(departments.isAccountingEntity, true)))
  return entities
    .filter((entity) => employee.departmentPath === entity.path || employee.departmentPath.startsWith(`${entity.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0]?.id ?? null
}

/** 开启/关闭部门「财务独立核算」(嵌套约束/根锁在 logic 兜底)。供 org 路由用。 */
export async function setDepartmentAccountingEntity(db: Db, ctx: Ctx, deptId: string, value: boolean): Promise<void> {
  return setDepartmentAccountingEntityImpl(db, ctx, deptId, value)
}

/** 某员工的上级链(直属上级 → 根)。document 审批找人用。 */
export async function getLeaderChain(db: Db, tenantId: string, empId: string): Promise<Employee[]> {
  return getLeaderChainImpl(db, tenantId, empId)
}

/** 是否有某功能权限(超管短路 true) */
export async function hasPermission(db: Db, tenantId: string, empId: string, permCode: string): Promise<boolean> {
  return hasPermissionImpl(db, tenantId, empId, permCode)
}

/**
 * ★谁持有某功能权限(含超管)—— 群发/告警选收件人用这个,别自己遍历员工逐个 hasPermission。
 * 那种写法是 N+1,而且单个失败只能就地吞掉,「收件人算错了」永远不会被发现。
 */
export async function listEmployeeIdsWithPermission(db: Db, tenantId: string, permCode: string): Promise<string[]> {
  return listEmployeeIdsWithPermissionImpl(db, tenantId, permCode)
}

/**
 * ★某员工对某权限的数据范围 —— 所有业务模块数据过滤都调它。
 * 内部已处理多角色取最宽 + 超管短路,返回已解析的最终结果(部门 id 已展开)。
 */
export async function getDataScope(
  db: Db,
  tenantId: string,
  empId: string,
  permCode: string,
): Promise<DataScopeResult> {
  return getDataScopeImpl(db, tenantId, empId, permCode)
}

/**
 * ★人事异动落到组织:改员工部门/汇报线(调岗/晋升等生效用)。幂等(set 相同值无副作用)。
 * 供 modules/hr-core 异动单生效时调用——employee 写权限归 org,HR 走此接口,不直接改 employees 表。
 */
export async function reassignEmployee(
  db: Db,
  ctx: Ctx,
  empId: string,
  opts: { departmentId?: string; leaderId?: string | null },
): Promise<void> {
  if (opts.departmentId !== undefined) await updateEmployee(db, ctx, empId, { departmentId: opts.departmentId })
  if (opts.leaderId !== undefined) await setLeader(db, ctx, empId, opts.leaderId)
}

/**
 * ★离职落到组织:status=left(沿用「离职不删除」不变量)+ 回收全部角色(权限回收)。
 * 两者在 markEmployeeLeft 同一事务内完成;组织页直接离职走同一函数,两条路径口径一致。
 * 幂等:重复调用不报错。供 hr-core 离职单生效用。
 */
export async function separateEmployee(
  db: Db,
  ctx: Ctx,
  empId: string,
  opts: { subordinatesNewLeaderId?: string | null } = {},
): Promise<void> {
  await markEmployeeLeft(db, ctx, empId, opts)
}

/** 批量按 id 取员工姓名(含已删/离职,用于历史留痕展示如凭证签章)。缺失的 id 不在结果里。 */
export async function getEmployeeNames(db: Db, tenantId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (uniq.length === 0) return new Map()
  const rows = await db
    .select({ id: employees.id, name: employees.name })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), inArray(employees.id, uniq)))
  return new Map(rows.map((r) => [r.id, r.name]))
}

/**
 * 批量取员工姓名(id → name)。一次 IN 查,给「主人是谁」这类展示用。
 * ★批量而不是逐个:调用方通常在渲染一张列表,逐个查就是 N+1。
 * 查不到的 id 不出现在结果里 —— 调用方按「未指派/已删除」处理,别用空串冒充存在。
 */
export async function employeeNamesByIds(db: Db, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const briefs = await employeeBriefsByIds(db, tenantId, ids)
  return new Map([...briefs].map(([id, b]) => [id, b.name]))
}

/** 展示一个人所需的最小信息:姓名 + 头像。avatarUrl 为 null = 这个人没设过头像。 */
export type EmployeeBrief = { name: string; avatarUrl: string | null }

/**
 * 批量取员工展示信息(id → {name, avatarUrl})。语义同 employeeNamesByIds,只是多带一列头像。
 * ★头像**不在这里兜底** —— 没设过就是 null,由前端显示姓名首字。任何「查不到就给个默认头像」
 *   的兜底都会把「这个人没设头像」变成「系统替他挑了一张」,那正是这一列存在的原因。
 */
export async function employeeBriefsByIds(db: Db, tenantId: string, ids: string[]): Promise<Map<string, EmployeeBrief>> {
  const uniq = [...new Set(ids.filter(Boolean))]
  if (uniq.length === 0) return new Map()
  const rows = await db
    .select({ id: employees.id, name: employees.name, avatarUrl: employees.avatarUrl })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), inArray(employees.id, uniq)))
  return new Map(rows.map((r) => [r.id, { name: r.name, avatarUrl: r.avatarUrl }]))
}
