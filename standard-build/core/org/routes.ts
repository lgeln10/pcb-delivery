// core/org/routes.ts — org 模块 HTTP 路由(部门/员工/角色管理)。
// 鉴权:GET 走 org:view,写操作走 org:manage(中间件在 createApp 统一挂)。
// ★员工响应一律过 toEmployeeDTO,绝不返回 password_hash。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { requireAnyPermission, requirePermission } from '../http/middleware'
import { getCurrentEmployee, getDeptSubtree, getLeaderChain, listAccountingEntities, setDepartmentAccountingEntity, type Employee } from './api'
import {
  createDepartment,
  deleteDepartment,
  listDepartmentPicker,
  listDepartments,
  moveDepartment,
  setDepartmentStatus,
  updateDepartment,
} from './logic/department-tree'
import { changeOwnPassword, changePassword, createEmployee, DEFAULT_RESET_PASSWORD, deleteEmployee, getDefaultEmployeePassword, listEmployeePicker, listEmployees, markEmployeeLeft, reinstateEmployee, setDefaultEmployeePassword, setDepartmentHead, setLeader, updateEmployee } from './logic/employee'
import { buildEmployeeImportTemplate, importEmployeesFromWorkbook } from './logic/employee-import'
import { assertAllowedAvatar, clearOwnAvatar, setOwnAvatar } from './logic/avatar'
import {
  assignRoles,
  createRole,
  getEmployeeRoleIds,
  getRolePermissions,
  grantPermission,
  listEmployeeRoleNames,
  listPermissionCatalog,
  listRoles,
  revokePermission,
  revokeRole,
  softDeleteRole,
} from './logic/role'
import { DATA_SCOPES, listMyPermissionCodes } from './logic/data-scope'
import { OrgError } from './logic/errors'
import { limitField } from '../../core/http/pagination'

export function toEmployeeDTO(e: Employee, extras: { roleNames?: string[] } = {}) {
  // 显式挑字段,新增敏感字段时默认不泄露
  return {
    id: e.id,
    name: e.name,
    empNo: e.empNo,
    phone: e.phone,
    position: e.position,
    email: e.email,
    // null = 这个人没设过头像 —— 前端就显示姓名首字,不要在任何一层「兜底成一张图」
    avatarUrl: e.avatarUrl,
    departmentId: e.departmentId,
    leaderId: e.leaderId,
    status: e.status,
    roleNames: extras.roleNames ?? [],
    hasLogin: e.passwordHash !== null, // 前端据此判断能否删除(未开通登录的误建员工才可删)
    createdAt: e.createdAt,
  }
}

const CreateDeptBody = z.object({ name: z.string().min(1), parentId: z.uuid().nullable().optional(), sort: z.number().int().optional(), isAccountingEntity: z.boolean().optional() })
const UpdateDeptBody = z.object({ name: z.string().min(1), sort: z.number().int().optional() })
const MoveDeptBody = z.object({ newParentId: z.uuid().nullable() })
const DeptStatusBody = z.object({ status: z.enum(['active', 'disabled']) })
const DeptEntityBody = z.object({ enabled: z.boolean() })
const DeptHeadBody = z.object({ headEmployeeId: z.uuid().nullable() })
const CreateEmployeeBody = z.object({
  name: z.string().min(1),
  empNo: z.string().optional(), // 选填:留空/空串由系统自动生成(No.00001 递增)
  phone: z.string().min(5),
  position: z.string().optional(),
  departmentId: z.uuid(),
  leaderId: z.uuid().nullable().optional(),
  password: z.string().min(8).optional(),
  email: z.string().nullable().optional(),
})
const UpdateEmployeeBody = z.object({
  name: z.string().min(1).optional(),
  empNo: z.string().min(1).optional(),
  phone: z.string().min(5).optional(),
  position: z.string().optional(),
  email: z.string().nullable().optional(),
  departmentId: z.uuid().optional(),
})
const ResetPasswordBody = z.object({ password: z.string().min(8).optional() })
const ChangePasswordBody = z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(8) })
const DefaultPasswordBody = z.object({ password: z.string().min(8) })
const LeaveBody = z.object({ subordinatesNewLeaderId: z.uuid().nullable().optional() })
const SetLeaderBody = z.object({ leaderId: z.uuid().nullable() })
const AssignRolesBody = z.object({ roleIds: z.array(z.uuid()).min(1) })
const CreateRoleBody = z.object({ name: z.string().min(1), code: z.string().min(1) })
const GrantBody = z.object({ permCode: z.string().min(1), dataScope: z.enum(DATA_SCOPES) })
const ListQuery = z.object({ departmentId: z.uuid().optional(), q: z.string().optional(), cursor: z.uuid().optional(), limit: limitField() })

export function orgRoutes(db: Db) {
  const view = requirePermission(db, 'org:view')
  const manage = requirePermission(db, 'org:manage')
  // 角色页导航由 org:manage 门控；读取角色/权限目录时兼容只授管理权限的角色管理员。
  const roleRead = requireAnyPermission(db, ['org:view', 'org:manage'])
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  // ── 部门 ──
  return new Hono<AppEnv>()
    .get('/departments', view, async (c) => c.json({ items: await listDepartments(db, ctxOf(c)) }))
    // 选部门下拉全集:登录即可用,不门控 org:view(选部门下拉需要部门全集,
    // 而财务等业务角色通常没有 org:view)。详见 skill ref-picker-scope-audit。
    .get('/departments/picker', async (c) => c.json({ items: await listDepartmentPicker(db, ctxOf(c).tenantId) }))
    // 财务独立核算账套列表(标题栏组织切换器用):只需 org:view
    .get('/accounting-entities', view, async (c) =>
    c.json({ items: await listAccountingEntities(db, ctxOf(c).tenantId) }),
  )
    .post('/departments', manage, async (c) => {
    const body = CreateDeptBody.parse(await c.req.json())
    return c.json(await createDepartment(db, ctxOf(c), body), 201)
  })
    .patch('/departments/:id', manage, async (c) => {
    const body = UpdateDeptBody.parse(await c.req.json())
    return c.json(await updateDepartment(db, ctxOf(c), c.req.param('id'), body))
  })
    .post('/departments/:id/accounting-entity', manage, async (c) => {
    const body = DeptEntityBody.parse(await c.req.json())
    await setDepartmentAccountingEntity(db, ctxOf(c), c.req.param('id'), body.enabled)
    return c.json({ ok: true })
  })
    .post('/departments/:id/move', manage, async (c) => {
    const body = MoveDeptBody.parse(await c.req.json())
    await moveDepartment(db, ctxOf(c), c.req.param('id'), body.newParentId)
    return c.json({ ok: true })
  })
    .post('/departments/:id/status', manage, async (c) => {
    const body = DeptStatusBody.parse(await c.req.json())
    await setDepartmentStatus(db, ctxOf(c), c.req.param('id'), body.status)
    return c.json({ ok: true })
  })
    .post('/departments/:id/head', manage, async (c) => {
    const body = DeptHeadBody.parse(await c.req.json())
    await setDepartmentHead(db, ctxOf(c), c.req.param('id'), body.headEmployeeId)
    return c.json({ ok: true })
  })
    .delete('/departments/:id', manage, async (c) => {
    await deleteDepartment(db, ctxOf(c), c.req.param('id'))
    return c.json({ ok: true })
  })
    .get('/departments/:id/subtree', view, async (c) =>
    c.json({ ids: await getDeptSubtree(db, ctxOf(c).tenantId, c.req.param('id')) }),
  )

  // ── 员工 ──
    .get('/employees', view, async (c) => {
    const q = ListQuery.parse(c.req.query())
    const { items, nextCursor, total } = await listEmployees(db, ctxOf(c), q)
    const roleNamesByEmployee = await listEmployeeRoleNames(db, ctxOf(c), items.map((employee) => employee.id))
    return c.json({
      items: items.map((employee) => toEmployeeDTO(employee, { roleNames: roleNamesByEmployee.get(employee.id) ?? [] })),
      nextCursor,
      total,
    })
  })
    // 选人下拉全集:登录即可用,不门控 org:view、不做数据权限过滤(选人下拉需要员工全集,
    // 而销售等业务角色通常没有 org:view)。详见 skill ref-picker-scope-audit。
    .get('/employees/picker', async (c) =>
    c.json({ items: await listEmployeePicker(db, ctxOf(c).tenantId, c.req.query('q')) }))
    .get('/employees/import-template', manage, async () => {
    const body = buildEmployeeImportTemplate()
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="employee-import-template.xlsx"',
      },
    })
  })
    // 新建/导入员工默认登录密码(明文,建员工页展示 + 可改)。org:manage 可读写。
    .get('/default-employee-password', manage, async (c) =>
      c.json({ password: await getDefaultEmployeePassword(db, ctxOf(c)) }),
    )
    .put('/default-employee-password', manage, async (c) => {
      const body = DefaultPasswordBody.parse(await c.req.json())
      return c.json({ password: await setDefaultEmployeePassword(db, ctxOf(c), body.password) })
    })
    .post('/employees', manage, async (c) => {
    const body = CreateEmployeeBody.parse(await c.req.json())
    return c.json(toEmployeeDTO(await createEmployee(db, ctxOf(c), body)), 201)
  })
    .post('/employees/import', manage, async (c) => {
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new OrgError('INVALID_INPUT', '请上传 Excel 文件')
    const buffer = Buffer.from(await file.arrayBuffer())
    return c.json(await importEmployeesFromWorkbook(db, ctxOf(c), buffer))
  })
    .patch('/employees/:id', manage, async (c) => {
    const body = UpdateEmployeeBody.parse(await c.req.json())
    return c.json(toEmployeeDTO(await updateEmployee(db, ctxOf(c), c.req.param('id'), body)))
  })
    .delete('/employees/:id', manage, async (c) => {
    await deleteEmployee(db, ctxOf(c), c.req.param('id'))
    return c.json({ ok: true })
  })
    .post('/employees/:id/reset-password', manage, async (c) => {
    const body = ResetPasswordBody.parse(await c.req.json().catch(() => ({})))
    await changePassword(db, ctxOf(c), c.req.param('id'), body.password ?? DEFAULT_RESET_PASSWORD)
    return c.json({ ok: true })
  })
    .post('/employees/:id/leave', manage, async (c) => {
    const body = LeaveBody.parse(await c.req.json().catch(() => ({})))
    await markEmployeeLeft(db, ctxOf(c), c.req.param('id'), body)
    return c.json({ ok: true })
  })
    .post('/employees/:id/reinstate', manage, async (c) => {
    await reinstateEmployee(db, ctxOf(c), c.req.param('id'))
    return c.json({ ok: true })
  })
    .post('/employees/:id/leader', manage, async (c) => {
    const body = SetLeaderBody.parse(await c.req.json())
    await setLeader(db, ctxOf(c), c.req.param('id'), body.leaderId)
    return c.json({ ok: true })
  })
    .get('/employees/:id/leader-chain', view, async (c) =>
    c.json({ items: (await getLeaderChain(db, ctxOf(c).tenantId, c.req.param('id'))).map((e) => toEmployeeDTO(e)) }),
  )
    .get('/employees/:id/roles', view, async (c) => c.json({ ids: await getEmployeeRoleIds(db, ctxOf(c), c.req.param('id')) }))
    .post('/employees/:id/roles', manage, async (c) => {
    const body = AssignRolesBody.parse(await c.req.json())
    await assignRoles(db, ctxOf(c), c.req.param('id'), body.roleIds)
    return c.json({ ok: true })
  })
    .delete('/employees/:id/roles/:roleId', manage, async (c) => {
    await revokeRole(db, ctxOf(c), c.req.param('id'), c.req.param('roleId'))
    return c.json({ ok: true })
  })

  // ── 角色/授权 ──
    .get('/roles', roleRead, async (c) => c.json({ items: await listRoles(db, ctxOf(c)) }))
    .get('/permissions', roleRead, async (c) => c.json({ items: await listPermissionCatalog(db) }))
    .get('/roles/:id/permissions', roleRead, async (c) => c.json({ items: await getRolePermissions(db, ctxOf(c), c.req.param('id')) }))
    .post('/roles', manage, async (c) => {
    const body = CreateRoleBody.parse(await c.req.json())
    return c.json(await createRole(db, ctxOf(c), body), 201)
  })
    .delete('/roles/:id', manage, async (c) => {
    await softDeleteRole(db, ctxOf(c), c.req.param('id'))
    return c.json({ ok: true })
  })
    .post('/roles/:id/permissions', manage, async (c) => {
    const body = GrantBody.parse(await c.req.json())
    await grantPermission(db, ctxOf(c), c.req.param('id'), body.permCode, body.dataScope)
    return c.json({ ok: true })
  })
    .delete('/roles/:id/permissions/:permCode', manage, async (c) => {
    await revokePermission(db, ctxOf(c), c.req.param('id'), c.req.param('permCode'))
    return c.json({ ok: true })
  })
}

/** GET /api/me(只需登录,不需要 org:view) */
export function meRoute(db: Db) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(toEmployeeDTO(await getCurrentEmployee(db, c.get('ctx')))))
    .get('/permissions', async (c) => {
      const ctx = c.get('ctx')
      const codes = await listMyPermissionCodes(db, ctx.tenantId, ctx.employeeId)
      // null = 超管,前端收到 null 视为拥有一切;否则返回实际拥有的权限码集合
      return c.json({ codes })
    })
    // 自助修改本人密码:只需登录,自动作用于当前登录人(不接受 empId),须验原密码
    .post('/change-password', async (c) => {
      await changeOwnPassword(db, c.get('ctx'), ChangePasswordBody.parse(await c.req.json()))
      return c.json({ ok: true })
    })
    // 自助设置本人头像(个人设置页)。同样不接受 empId —— 永远只写当前登录人那一行。
    .post('/avatar', async (c) => {
      const form = await c.req.parseBody()
      const file = form['file']
      if (!(file instanceof File)) throw new OrgError('INVALID_INPUT', '缺少上传文件')
      const bytes = Buffer.from(await file.arrayBuffer())
      // 先读字节再判类型:判据看内容,客户端声明的 file.type 不参与决策;落库用归一后的类型。
      const contentType = assertAllowedAvatar(bytes, file.name || '', file.size)
      return c.json(await setOwnAvatar(db, c.get('ctx'), { bytes, filename: file.name || 'avatar', contentType }), 201)
    })
    // 移除头像 = 回到「没有头像」(显示姓名首字),不是换回某张默认图
    .delete('/avatar', async (c) => c.json(await clearOwnAvatar(db, c.get('ctx'))))
}
