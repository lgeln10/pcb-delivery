// core/org/logic/employee.ts
// 员工:创建(密码必哈希)、编辑、汇报线(leader 链防环)、离职(status=left 不删除 + 下属汇报线重指)、
// 游标分页列表。
// 不变量3:有历史单据的员工不被删除,操作人引用要保留。删除只对"从未开通登录(passwordHash=null)
// 因而从未产生任何 created_by"的误建员工开放(deleteEmployee 受限软删除),其余一律走离职。
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { and, asc, eq, gt, ilike, ne, or, sql } from 'drizzle-orm'
import type { Ctx, Db } from '../../db/client'
import { auditedUpdate, scope, softDelete } from '../../db/soft-delete'
import { departments, employeeRoles, employees, tenants, type Department, type Employee } from '../model'
import { getDepartment } from './department-tree'
import { generateEmpNo } from './emp-no'
import { OrgError } from './errors'
import { assertSeatAvailable } from '../../license/state'

const BCRYPT_ROUNDS = 10
const LEADER_CHAIN_MAX_DEPTH = 50 // 防环兜底:正常组织层级远小于此
const LEADER_LOCK_KEY = 'org-leader-chain'

/** 管理员重置员工密码的默认值(不指定新密码时用) */
export const DEFAULT_RESET_PASSWORD = 'changeMe@6am'

/** 读取本租户「新建/导入员工默认登录密码」(明文:建员工页要展示、建员工/导入要用)。 */
export async function getDefaultEmployeePassword(db: Db, ctx: Ctx): Promise<string> {
  const rows = await db
    .select({ pwd: tenants.defaultEmployeePassword })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId))
    .limit(1)
  return rows[0]?.pwd || DEFAULT_RESET_PASSWORD
}

/** 设置本租户默认员工密码(至少 8 位)。修改后,后续新建/导入的员工都用这个。 */
export async function setDefaultEmployeePassword(db: Db, ctx: Ctx, password: string): Promise<string> {
  const pwd = password.trim()
  if (pwd.length < 8) throw new OrgError('INVALID_INPUT', '默认密码至少 8 位')
  await db.update(tenants).set({ defaultEmployeePassword: pwd }).where(eq(tenants.id, ctx.tenantId))
  return pwd
}

/** ★质量红线:密码只走这里,永不明文入库 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

/** 事务内取 per-tenant 汇报线锁:并发 setLeader 互查通过可成环,串行化 */
async function lockLeaderChain(tx: Db, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId + ':' + LEADER_LOCK_KEY}))`)
}

export async function getEmployee(db: Db, tenantId: string, id: string): Promise<Employee | null> {
  const rows = await db
    .select()
    .from(employees)
    .where(and(scope(employees, tenantId), eq(employees.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export async function createEmployee(
  db: Db,
  ctx: Ctx,
  input: {
    name: string
    empNo?: string // 选填:留空由系统按 No.00001 规则自动生成(与 Excel 导入同一套规则)
    phone: string
    position?: string
    departmentId: string
    leaderId?: string | null
    password?: string // 不传且无 passwordHash = 不开通登录
    passwordHash?: string // 已哈希的密码(批量导入时统一默认密码只哈希一次,避免逐行 bcrypt)
    email?: string | null
  },
): Promise<Employee> {
  // 本地化部署授权:席位强制(启用强制且已达上限 → 拦)。未配 LICENSE_KEY 则无操作。
  await assertSeatAvailable(db)
  const dept = await getDepartment(db, ctx.tenantId, input.departmentId)
  if (!dept) throw new OrgError('NOT_FOUND', `department ${input.departmentId} not found`)
  // 汇报线:显式传 leaderId 用显式;否则默认取部门负责人(该部门已设负责人且在职时)。
  let leaderId = input.leaderId ?? null
  if (leaderId) {
    const leader = await getEmployee(db, ctx.tenantId, leaderId)
    if (!leader || leader.status !== 'active') {
      throw new OrgError('EMPLOYEE_NOT_ACTIVE', `leader ${leaderId} not found or not active`)
    }
  } else if (dept.headEmployeeId) {
    const head = await getEmployee(db, ctx.tenantId, dept.headEmployeeId)
    if (head && head.status === 'active') leaderId = dept.headEmployeeId
  }
  // 密码只哈希一次:自动工号撞号重试时不重复做 bcrypt
  const passwordHash = input.passwordHash ?? (input.password ? await hashPassword(input.password) : null)
  // 工号/手机号租户内唯一:库层部分唯一索引兜底,违反时这里直接抛(调用方按库错误处理)
  const insertWith = async (empNo: string): Promise<Employee> => {
    const rows = await db
      .insert(employees)
      .values({
        id: randomUUID(),
        tenantId: ctx.tenantId,
        createdBy: ctx.employeeId,
        updatedBy: ctx.employeeId,
        departmentId: input.departmentId,
        leaderId,
        name: input.name,
        empNo,
        phone: input.phone,
        position: input.position ?? '',
        passwordHash,
        email: input.email ?? null,
      })
      .returning()
    return rows[0]!
  }
  const explicitEmpNo = input.empNo?.trim()
  if (explicitEmpNo) return insertWith(explicitEmpNo)
  // 工号留空 = 系统生成。并发建员工可能算出同一个 max+1,唯一索引兜底 → 重算工号重试(仅工号撞号)。
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await insertWith(await generateEmpNo(db, ctx.tenantId))
    } catch (e) {
      if (attempt < 8 && isEmpNoConflict(e)) continue
      throw e
    }
  }
}

/** 是否 emp_no 唯一索引撞号(仅此可重试:换个号重算即可;手机号撞了重试无益)。 */
function isEmpNoConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string; message?: string; cause?: { code?: string; constraint?: string; message?: string } }
  const code = err?.code ?? err?.cause?.code
  const text = `${err?.constraint ?? ''} ${err?.cause?.constraint ?? ''} ${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  return code === '23505' && text.includes('employees_tenant_emp_no_uq')
}

/** 上溯 leader 链(不含本人,直属上级 → 根)。防环兜底:重复节点或超深即抛。 */
export async function getLeaderChain(db: Db, tenantId: string, empId: string): Promise<Employee[]> {
  const start = await getEmployee(db, tenantId, empId)
  if (!start) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)
  const chain: Employee[] = []
  const seen = new Set<string>([empId])
  let cursor = start.leaderId
  // 链式上溯逐条查:链长 = 组织层级(个位数),不构成 N+1 问题;递归 CTE 可读性差,不用
  while (cursor) {
    if (seen.has(cursor) || chain.length >= LEADER_CHAIN_MAX_DEPTH) {
      throw new OrgError('CYCLE_DETECTED', `leader chain cycle detected at ${cursor}`)
    }
    seen.add(cursor)
    const leader = await getEmployee(db, tenantId, cursor)
    if (!leader) break // 上级被软删:链到此为止(离职走 status=left 不会出现这种情况)
    chain.push(leader)
    cursor = leader.leaderId
  }
  return chain
}

/** 设置直属上级(★防环:目标不能在自己的下级链中,即其上溯链不能经过本人) */
export async function setLeader(db: Db, ctx: Ctx, empId: string, leaderId: string | null): Promise<void> {
  if (empId === leaderId) throw new OrgError('CYCLE_DETECTED', 'cannot set leader to self')
  await db.transaction(async (tx) => {
    await lockLeaderChain(tx, ctx.tenantId)
    const emp = await getEmployee(tx, ctx.tenantId, empId)
    if (!emp) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)
    if (leaderId) {
      const leader = await getEmployee(tx, ctx.tenantId, leaderId)
      if (!leader || leader.status !== 'active') {
        throw new OrgError('EMPLOYEE_NOT_ACTIVE', `leader ${leaderId} not found or not active`)
      }
      // 防环:沿目标的 leader 链上溯,碰到本人 = 目标在本人下级链中
      const chainOfLeader = await getLeaderChain(tx, ctx.tenantId, leaderId)
      if (chainOfLeader.some((e) => e.id === empId)) {
        throw new OrgError('CYCLE_DETECTED', `${leaderId} reports (transitively) to ${empId}`)
      }
    }
    await auditedUpdate(tx, employees, ctx.tenantId, empId, ctx.employeeId, { leaderId })
  })
}

/**
 * 设/清部门负责人。负责人须是本部门在职员工。设定后:
 * ① departments.head_employee_id = 负责人;
 * ② 本部门其余在职成员的汇报线(leader_id)全部改指负责人;
 * ③ 负责人自身的 leader 归到父部门负责人(无则置空),避免「负责人 → 本部门成员 → 负责人」成环。
 * 传 null = 清除负责人(只清指针,不动成员既有汇报线)。与 setLeader 共用汇报线锁串行化。
 */
export async function setDepartmentHead(db: Db, ctx: Ctx, deptId: string, headEmployeeId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLeaderChain(tx, ctx.tenantId)
    const dept = await getDepartment(tx, ctx.tenantId, deptId)
    if (!dept) throw new OrgError('NOT_FOUND', `department ${deptId} not found`)

    if (headEmployeeId === null) {
      await auditedUpdate(tx, departments, ctx.tenantId, deptId, ctx.employeeId, { headEmployeeId: null })
      return
    }

    const head = await getEmployee(tx, ctx.tenantId, headEmployeeId)
    if (!head || head.status !== 'active') {
      throw new OrgError('EMPLOYEE_NOT_ACTIVE', `head ${headEmployeeId} not found or not active`)
    }
    if (head.departmentId !== deptId) {
      throw new OrgError('INVALID_INPUT', '部门负责人必须是该部门的在职员工')
    }

    await auditedUpdate(tx, departments, ctx.tenantId, deptId, ctx.employeeId, { headEmployeeId })

    // 本部门其余在职成员 → 汇报线改指负责人
    await tx
      .update(employees)
      .set({ leaderId: headEmployeeId, updatedBy: ctx.employeeId, updatedAt: new Date() })
      .where(
        and(
          scope(employees, ctx.tenantId),
          eq(employees.departmentId, deptId),
          eq(employees.status, 'active'),
          ne(employees.id, headEmployeeId),
        ),
      )

    // 负责人自身汇报线:归到父部门负责人;成环风险(旧上级恰是本部门成员,现已反指负责人)时也走此归置。
    const parentHead = await parentDepartmentHead(tx, ctx.tenantId, dept)
    const nextHeadLeader = parentHead && parentHead !== headEmployeeId ? parentHead : null
    if (nextHeadLeader !== head.leaderId) {
      await auditedUpdate(tx, employees, ctx.tenantId, headEmployeeId, ctx.employeeId, { leaderId: nextHeadLeader })
    }
  })
}

/** 父部门(逐级上溯,跳过未设负责人的层)的在职负责人 id;到根仍无则 null。 */
async function parentDepartmentHead(tx: Db, tenantId: string, dept: Department): Promise<string | null> {
  let parentId = dept.parentId
  while (parentId) {
    const parent = await getDepartment(tx, tenantId, parentId)
    if (!parent) return null
    if (parent.headEmployeeId) {
      const parentHead = await getEmployee(tx, tenantId, parent.headEmployeeId)
      if (parentHead && parentHead.status === 'active') return parentHead.id
    }
    parentId = parent.parentId
  }
  return null
}

/**
 * 离职:status=left(★不变量3:不删除,历史单据保留操作人)+ 同事务回收全部角色。
 * 组织页直接离职与人事离职单(separateEmployee)同口径:离职即无任何角色,复职需重新分配
 * —— 否则「组织页离职→复职」会静默带回旧角色(2026-08-27 审计中危)。
 * 其直属下属的汇报线重指:默认指向离职者的上级(跳级);可显式指定 newLeaderId。
 * 若 newLeaderId 恰是下属之一(提拔),该下属改指离职者的上级,避免自环。
 */
export async function markEmployeeLeft(
  db: Db,
  ctx: Ctx,
  empId: string,
  opts: { subordinatesNewLeaderId?: string | null } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockLeaderChain(tx, ctx.tenantId)
    const emp = await getEmployee(tx, ctx.tenantId, empId)
    if (!emp) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)

    const fallback = emp.leaderId // 离职者自己的上级(可能为 null)
    const target = opts.subordinatesNewLeaderId !== undefined ? opts.subordinatesNewLeaderId : fallback
    if (target === empId) throw new OrgError('INVALID_INPUT', 'new leader cannot be the leaving employee')
    if (target) {
      const t = await getEmployee(tx, ctx.tenantId, target)
      if (!t || t.status !== 'active') {
        throw new OrgError('EMPLOYEE_NOT_ACTIVE', `new leader ${target} not found or not active`)
      }
    }

    const subs = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(and(scope(employees, ctx.tenantId), eq(employees.leaderId, empId), eq(employees.status, 'active')))

    await auditedUpdate(tx, employees, ctx.tenantId, empId, ctx.employeeId, { status: 'left', leaderId: null })
    // 回收全部角色(纯关联表物理删行,同 deleteEmployee;无角色时 no-op,幂等)
    await tx.delete(employeeRoles).where(and(eq(employeeRoles.tenantId, ctx.tenantId), eq(employeeRoles.employeeId, empId)))
    // 离职者若是某部门负责人,清除该部门负责人指针(避免悬空指向离职者)
    await tx
      .update(departments)
      .set({ headEmployeeId: null, updatedBy: ctx.employeeId, updatedAt: new Date() })
      .where(and(scope(departments, ctx.tenantId), eq(departments.headEmployeeId, empId)))
    for (const s of subs) {
      // 新上级恰是该下属本人(提拔场景)→ 改指离职者的原上级
      const newLeader = s.id === target ? fallback : target
      await auditedUpdate(tx, employees, ctx.tenantId, s.id, ctx.employeeId, {
        leaderId: newLeader === s.id ? null : newLeader,
      })
    }
    // 重指后逐个下属上溯验环(下属数量小;有环则整个事务回滚)
    for (const s of subs) await getLeaderChain(tx, ctx.tenantId, s.id)
  })
}

/**
 * 复职:status=left → active(撤销离职)。
 * 只对已离职员工生效;在职员工重复调用直接抛(避免误操作)。
 * 离职时 leaderId 已清空、下属已改挂,复职不自动还原汇报线——由管理员另行重建
 * (「设为负责人」整部门重指,或人事异动单 reassignEmployee)。
 * 角色同理:离职时已全部回收(markEmployeeLeft 事务内,组织页与人事离职单同口径),
 * 复职不自动恢复,需在「分配角色」里重新授予。
 */
export async function reinstateEmployee(db: Db, ctx: Ctx, empId: string): Promise<Employee> {
  const emp = await getEmployee(db, ctx.tenantId, empId)
  if (!emp) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)
  if (emp.status !== 'left') throw new OrgError('INVALID_INPUT', '该员工不是离职状态,无需复职')
  await auditedUpdate(db, employees, ctx.tenantId, empId, ctx.employeeId, { status: 'active' })
  return (await getEmployee(db, ctx.tenantId, empId))!
}

/** 编辑员工:身份/联系/部门字段。换部门要校验目标部门存在。工号/手机号租户内唯一由库层兜底。 */
export async function updateEmployee(
  db: Db,
  ctx: Ctx,
  empId: string,
  patch: { name?: string; empNo?: string; phone?: string; position?: string; email?: string | null; departmentId?: string },
): Promise<Employee> {
  const emp = await getEmployee(db, ctx.tenantId, empId)
  if (!emp) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)
  if (patch.departmentId && patch.departmentId !== emp.departmentId) {
    const dept = await getDepartment(db, ctx.tenantId, patch.departmentId)
    if (!dept) throw new OrgError('NOT_FOUND', `department ${patch.departmentId} not found`)
    // 员工调离原部门后不再是原部门成员:若其为原部门负责人,清除该部门负责人指针
    await db
      .update(departments)
      .set({ headEmployeeId: null, updatedBy: ctx.employeeId, updatedAt: new Date() })
      .where(and(scope(departments, ctx.tenantId), eq(departments.id, emp.departmentId!), eq(departments.headEmployeeId, empId)))
  }
  await auditedUpdate(db, employees, ctx.tenantId, empId, ctx.employeeId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.empNo !== undefined ? { empNo: patch.empNo } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(patch.departmentId !== undefined ? { departmentId: patch.departmentId } : {}),
  })
  return (await getEmployee(db, ctx.tenantId, empId))!
}

/**
 * 删除员工:★受限软删除,守住不变量3(历史单据要保留操作人)。
 * 只允许删"误建且从未开通登录"的员工——passwordHash 为 null = 从未登录,
 * 也就不可能作为任何业务写操作的 created_by(写操作都以登录者身份发生),删它不会让历史单据的操作人悬空。
 * 额外护栏:不能删租户负责人、不能删他人上级。其余情况一律改用离职(markEmployeeLeft)。
 */
export async function deleteEmployee(db: Db, ctx: Ctx, empId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const emp = await getEmployee(tx, ctx.tenantId, empId)
    if (!emp) throw new OrgError('NOT_FOUND', `employee ${empId} not found`)
    if (emp.passwordHash !== null) {
      throw new OrgError('EMPLOYEE_HAS_LOGIN', '该员工已开通登录,可能已产生业务数据,不能删除;请改用「离职」')
    }
    const owner = await tx
      .select({ ownerEmployeeId: tenants.ownerEmployeeId })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1)
    if (owner[0]?.ownerEmployeeId === empId) throw new OrgError('EMPLOYEE_IS_OWNER', '不能删除租户负责人')
    const sub = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(and(scope(employees, ctx.tenantId), eq(employees.leaderId, empId)))
      .limit(1)
    if (sub[0]) throw new OrgError('EMPLOYEE_HAS_SUBORDINATES', '该员工是其他员工的上级,请先调整其下属汇报线;或改用「离职」')
    // 删除者若是某部门负责人(sole 成员场景可无下属而通过前面守卫),清除该部门负责人指针
    await tx
      .update(departments)
      .set({ headEmployeeId: null, updatedBy: ctx.employeeId, updatedAt: new Date() })
      .where(and(scope(departments, ctx.tenantId), eq(departments.headEmployeeId, empId)))
    // 角色关联是纯关联表(无软删字段),物理删行;再软删员工本身
    await tx.delete(employeeRoles).where(and(eq(employeeRoles.tenantId, ctx.tenantId), eq(employeeRoles.employeeId, empId)))
    await softDelete(tx, employees, ctx.tenantId, empId, ctx.employeeId)
  })
}

export async function changePassword(db: Db, ctx: Ctx, empId: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new OrgError('INVALID_INPUT', 'password must be at least 8 chars')
  await auditedUpdate(db, employees, ctx.tenantId, empId, ctx.employeeId, {
    passwordHash: await hashPassword(newPassword),
    // ★改密码必须连带作废该员工已签发的全部登录令牌。
    //   管理员重置密码的典型场景就是「这个账号可能出事了」——
    //   如果旧令牌还活着,重置密码等于什么也没做:偷到令牌的人 7 天内照常进来。
    //   写法上直接并进同一次 update,不另起一次写(也就自然进了同一条审计)。
    sessionsRevokedAt: new Date(),
  })
}

/**
 * 自助修改本人密码:先 bcrypt.compare 校验原密码,再设新密码。
 * ★只改 ctx.employeeId 本人——不接受 empId 入参,杜绝越权改他人密码(与管理员重置 changePassword 分开:
 * 那个 org:manage 门控、无需原密码;本函数任何登录用户可调,但必须验原密码)。
 */
export async function changeOwnPassword(
  db: Db,
  ctx: Ctx,
  input: { oldPassword: string; newPassword: string },
): Promise<void> {
  if (input.newPassword.length < 8) throw new OrgError('INVALID_INPUT', '新密码至少 8 位')
  if (input.newPassword === input.oldPassword) throw new OrgError('INVALID_INPUT', '新密码不能与原密码相同')
  const rows = await db
    .select({ passwordHash: employees.passwordHash })
    .from(employees)
    .where(and(scope(employees, ctx.tenantId), eq(employees.id, ctx.employeeId)))
    .limit(1)
  const hash = rows[0]?.passwordHash
  if (!hash) throw new OrgError('NOT_FOUND', '当前账号未开通登录')
  if (!(await bcrypt.compare(input.oldPassword, hash))) throw new OrgError('WRONG_PASSWORD', '原密码不正确')
  await auditedUpdate(db, employees, ctx.tenantId, ctx.employeeId, ctx.employeeId, {
    passwordHash: await hashPassword(input.newPassword),
    // ★同 changePassword:改了密码,旧令牌就该作废 —— 否则「我怀疑账号被盗所以改密码」这个动作
    //   完全无效。**含当前这台设备**:改完密码要重新登录一次,这是各家的通行做法,也更安全。
    sessionsRevokedAt: new Date(),
  })
}

const LIST_DEFAULT_LIMIT = 20
const LIST_MAX_LIMIT = 50 // ★契约红线:列表必须分页且有上限
const PICKER_MAX_LIMIT = 500 // 选人下拉硬上限兜底(员工数按公司规模有界,目标 ~200 人)

/** 员工列表:游标分页(按 id 升序,cursor = 上一页最后一条的 id),禁深 OFFSET。q:按姓名/手机号模糊搜索。 */
export async function listEmployees(
  db: Db,
  ctx: Ctx,
  opts: { departmentId?: string; q?: string; cursor?: string; limit?: number } = {},
): Promise<{ items: Employee[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)
  const filters = [scope(employees, ctx.tenantId)]
  if (opts.departmentId) filters.push(eq(employees.departmentId, opts.departmentId))
  const kw = opts.q?.trim()
  if (kw) filters.push(or(ilike(employees.name, `%${kw}%`), ilike(employees.phone, `%${kw}%`))!)
  // 分页查询在筛选基础上加游标;total 只按筛选(不含游标)统计,供前端分页控件显示总数
  const pageConds = opts.cursor ? [...filters, gt(employees.id, opts.cursor)] : filters
  const items = await db
    .select()
    .from(employees)
    .where(and(...pageConds))
    .orderBy(asc(employees.id))
    .limit(limit + 1) // 多取一条探测是否有下一页
  const hasMore = items.length > limit
  if (hasMore) items.pop()
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(employees).where(and(...filters))
  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
    total: Number(totalRows[0]?.value ?? 0),
  }
}

/**
 * 选人下拉专用:返回全租户员工的轻量清单(id/name/empNo/departmentId/status)。
 * 供各业务页「选人下拉」(跟进人 / 协作人 / 审批人 …)使用。
 * ★关键:不做数据权限过滤、不要求 org:view。选人下拉需要员工全集,而能进业务页的
 *   用户(销售等)通常没有 org:view——若复用 listEmployees(org:view 门控)会 403 空白。
 *   仅按租户隔离,登录即可用。员工数按公司规模有界(目标 ~200 人)。
 *   q:可选,按姓名/工号模糊搜索(供 el-select 远程搜索 remote-method 用)。
 *   详见 skill ref-picker-scope-audit。
 */
export async function listEmployeePicker(
  db: Db,
  tenantId: string,
  q?: string,
): Promise<{ id: string; name: string; empNo: string; departmentId: string | null; status: string; avatarUrl: string | null }[]> {
  const conds = [scope(employees, tenantId)]
  const kw = q?.trim()
  if (kw) conds.push(or(ilike(employees.name, `%${kw}%`), ilike(employees.empNo, `%${kw}%`))!)
  return db
    .select({
      id: employees.id,
      name: employees.name,
      empNo: employees.empNo,
      departmentId: employees.departmentId,
      status: employees.status,
      // 通讯录要显示头像;null = 没设过,显示姓名首字
      avatarUrl: employees.avatarUrl,
    })
    .from(employees)
    .where(and(...conds))
    .orderBy(asc(employees.name))
    .limit(PICKER_MAX_LIMIT) // 硬上限兜底,防超大租户全量拉取
}
