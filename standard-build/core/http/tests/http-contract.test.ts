// ★HTTP 契约测试(QUALITY_GUARDRAILS:鉴权中间件 + 契约测试)。
// 覆盖:默认拒绝(401)/ 越权(403)/ 错误体不漏堆栈SQL / 422 字段定位 /
//       列表上限经 HTTP 生效 / 唯一冲突 409 / 核心业务流经 HTTP 全通。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { createOrgTestDb, type OrgTestDb } from '../../org/tests/helpers'
import { OrgError } from '../../org/logic/errors'
import { AuthError } from '../../auth/errors'
import { createApp, syncAllPermissions } from '../app'
import { mapError } from '../errors'
import type { AppEnv } from '../middleware'
import { signToken } from '../../auth/token'
import { seedDemo } from '../../../seed/demo'
import { createEmployee } from '../../org/logic/employee'
import { assignRoles, createRole, grantPermission } from '../../org/logic/role'

const SECRET = 'http-test-secret'
let t: OrgTestDb
let app: Hono<AppEnv>
let demoApp: Hono<AppEnv>
let bossToken: string
let salesToken: string // 销售:有 partner:view(SELF)/partner:create,无 finance/org 权限
let roleManagerToken: string
let tenantId: string

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  t = await createOrgTestDb()
  await syncAllPermissions(t.db)
  const seeded = await seedDemo(t.db) // 复用演示数据:老板 + 销售小张 + 客户 + 账
  tenantId = seeded.tenantId
  app = createApp(t.db, { secret: SECRET })
  demoApp = createApp(t.db, {
    secret: SECRET,
    demoCredentials: { phone: seeded.bossPhone, password: seeded.bossPassword },
  })

  const boss = await api('POST', '/api/auth/login', { body: { phone: seeded.bossPhone, password: seeded.bossPassword } })
  bossToken = boss.json.token
  const sales = await api('POST', '/api/auth/login', { body: { phone: '13800000002', password: 'demo-pass-123' } })
  salesToken = sales.json.token

  const ownerCtx = { tenantId: seeded.tenantId, employeeId: boss.json.employee.id, entityId: seeded.rootEntityId }
  const roleManager = await createEmployee(t.db, ownerCtx, {
    name: '角色管理员',
    empNo: 'ROLE-MANAGER',
    phone: '13800000009',
    departmentId: seeded.rootEntityId,
    password: 'demo-pass-123',
  })
  const role = await createRole(t.db, ownerCtx, { name: '仅角色管理', code: 'role-manager-only' })
  await grantPermission(t.db, ownerCtx, role.id, 'org:manage', 'ALL')
  await assignRoles(t.db, ownerCtx, roleManager.id, [role.id])
  const managerLogin = await api('POST', '/api/auth/login', {
    body: { phone: roleManager.phone, password: 'demo-pass-123' },
  })
  roleManagerToken = managerLogin.json.token
})
afterAll(async () => {
  await t.close()
})

describe('鉴权契约:默认拒绝', () => {
  it('健康检查不需要 token → 200;push/demo 反映本实例配了什么(未配为 false)', async () => {
    const r = await api('GET', '/api/health')
    expect(r.status).toBe(200)
    // push 存在的理由:没配密钥时推送是**静默停用**的,不报错也没现象,
    // 没有这个字段就无从判断「部署到底有没有把密钥放上去」。
    // 测试环境没有 APNS_* 环境变量,故恒 false。★只回布尔,绝不把密钥内容带出来。
    // demo 存在的理由:前端启动要据此决定发不发 demo-login。普通应用没注册那条路由,
    // 盲发就是每次打开在控制台留一条 404。
    expect(r.json).toEqual({ ok: true, demo: false })
  })

  it('demo 位必须区分两种实例:配了演示凭据的应用回 true', async () => {
    // 两个实例回同一个值(恒 true / 恒 false)这个字段就白加了 —— 前端照样会盲发或永不发。
    const r = await demoApp.request('/api/health')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, demo: true })
  })

  it('未带 token 访问任何 /api/* → 401(含未知路径)', async () => {
    for (const path of ['/api/org/employees', '/api/me', '/api/pcb-cam/projects', '/api/no-such-route']) {
      const r = await api('GET', path)
      expect(r.status, path).toBe(401)
      expect(r.json.error.code).toBeTruthy()
    }
  })

  it('伪造/过期 token → 401;登录密码错 → 401 且不区分账号是否存在', async () => {
    expect((await api('GET', '/api/me', { token: 'garbage.token' })).status).toBe(401)
    const wrong = await api('POST', '/api/auth/login', { body: { phone: '13800000001', password: 'nope-nope' } })
    const ghost = await api('POST', '/api/auth/login', { body: { phone: '19999999999', password: 'nope-nope' } })
    expect(wrong.status).toBe(401)
    expect(ghost.status).toBe(401)
    expect(wrong.json.error.code).toBe(ghost.json.error.code) // 防枚举:同一错误码
  })

  it('合法签名但员工已不存在的旧 token → 401 EMPLOYEE_NOT_ACTIVE', async () => {
    const token = signToken({ employeeId: randomUUID(), tenantId }, SECRET)
    const response = await api('GET', '/api/me', { token })

    expect(response.status).toBe(401)
    expect(response.json.error.code).toBe('EMPLOYEE_NOT_ACTIVE')
  })

  it('登录响应不含 password_hash;/api/me 不含 password_hash', async () => {
    const me = await api('GET', '/api/me', { token: bossToken })
    expect(me.status).toBe(200)
    expect(JSON.stringify(me.json)).not.toContain('password')
  })

  it('演示能力签发安全会话;普通应用不注册演示登录路由', async () => {
    const response = await demoApp.request('/api/auth/demo-login', { method: 'POST' })
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result).toEqual({
      token: expect.any(String),
      employee: {
        id: expect.any(String),
        name: '王老板',
        tenantId,
        phone: '13800000001',
      },
    })
    expect(JSON.stringify(result)).not.toContain('password')
    expect(
      (await demoApp.request('/api/me', { headers: { Authorization: `Bearer ${result.token}` } })).status,
    ).toBe(200)

    const unavailable = await api('POST', '/api/auth/demo-login', { token: bossToken })
    expect(unavailable.status).toBe(404)
  })
})

describe('权限契约:越权 403', () => {
  it('工程员(无 org:manage)访问组织管理接口 → 403', async () => {
    expect((await api('GET', '/api/org/employees', { token: salesToken })).status).toBe(403)
    expect((await api('GET', '/api/org/roles', { token: salesToken })).status).toBe(403)
    expect(
      (await api('POST', '/api/org/departments', { token: salesToken, body: { name: '越权部门' } })).status,
    ).toBe(403)
  })

  it('仅有 org:manage 的角色管理员可加载角色页所需的只读数据', async () => {
    const roles = await api('GET', '/api/org/roles', { token: roleManagerToken })
    expect(roles.status).toBe(200)
    const catalog = await api('GET', '/api/org/permissions', { token: roleManagerToken })
    expect(catalog.status).toBe(200)
    expect(catalog.json.items.length).toBeGreaterThan(0)
    const rolePermissions = await api('GET', `/api/org/roles/${roles.json.items[0].id}/permissions`, {
      token: roleManagerToken,
    })
    expect(rolePermissions.status).toBe(200)
    expect((await api('GET', '/api/org/employees', { token: roleManagerToken })).status).toBe(403)
  })

  it('老板(超管短路)全部放行', async () => {
    expect((await api('GET', '/api/org/employees', { token: bossToken })).status).toBe(200)
    expect((await api('GET', '/api/pcb-cam/projects', { token: bossToken })).status).toBe(200)
  })

  it('选人下拉 /api/org/employees/picker:工程员(无 org:view)可访问且拿到员工全集', async () => {
    // ★核心回归(skill ref-picker-scope-audit):对比上面 /api/org/employees → 403,
    //   选人下拉必须登录即可用,且不被数据权限收窄——否则销售给线索/商机选跟进人时下拉空白。
    const picker = await api('GET', '/api/org/employees/picker', { token: salesToken })
    expect(picker.status).toBe(200)
    // 与老板看到的员工总数一致(全集,不因销售 SELF 而缩水)
    const bossList = await api('GET', '/api/org/employees?limit=9999', { token: bossToken })
    expect(picker.json.items.length).toBe(bossList.json.total)
    expect(picker.json.items.length).toBeGreaterThan(1)
    expect(picker.json.items[0]).toHaveProperty('name')
    expect(picker.json.items[0]).toHaveProperty('empNo')
    expect(JSON.stringify(picker.json)).not.toContain('password') // 不漏敏感字段
    // q:远程搜索(供 el-select remote-method 用)——按姓名/工号过滤,结果不超过全集
    const searched = await api('GET', '/api/org/employees/picker?q=小张', { token: salesToken })
    expect(searched.status).toBe(200)
    expect(searched.json.items.length).toBeGreaterThan(0)
    expect(searched.json.items.length).toBeLessThan(picker.json.items.length)
    expect(searched.json.items.every((e: { name: string }) => e.name.includes('小张'))).toBe(true)
  })

  it('选部门下拉 /api/org/departments/picker:销售(无 org:view)可访问且拿到部门全集', async () => {
    // ★回归(skill ref-picker-scope-audit):对比 /api/org/departments → 403(需 org:view),
    //   选部门下拉必须登录即可用——否则财务在预算页按部门设预算时下拉空白。
    expect((await api('GET', '/api/org/departments', { token: salesToken })).status).toBe(403)
    const picker = await api('GET', '/api/org/departments/picker', { token: salesToken })
    expect(picker.status).toBe(200)
    const bossList = await api('GET', '/api/org/departments', { token: bossToken })
    expect(picker.json.items.length).toBe(bossList.json.items.length) // 全集,与老板一致
    expect(picker.json.items.length).toBeGreaterThan(0)
    expect(picker.json.items[0]).toHaveProperty('name')
    expect(picker.json.items[0]).toHaveProperty('parentId')
  })
})

describe('错误响应契约', () => {
  it('组织业务 EMPLOYEE_NOT_ACTIVE → 403,不使用会话失效语义', () => {
    const mapped = mapError(new OrgError('EMPLOYEE_NOT_ACTIVE', 'employee not active'))

    expect(mapped.status).toBe(403)
    expect(mapped.body.error.code).toBe('EMPLOYEE_NOT_ACTIVE')
  })

  it('鉴权层 AuthError(离职/租户停用)→ 401,前端才能走统一清会话登出', () => {
    const left = mapError(new AuthError('EMPLOYEE_NOT_ACTIVE', 'employee not active'))
    const suspended = mapError(new AuthError('TENANT_SUSPENDED', 'tenant suspended or not found'))

    expect(left.status).toBe(401)
    expect(suspended.status).toBe(401)
    expect(suspended.body.error.code).toBe('TENANT_SUSPENDED')
  })

  it('422 校验错误定位到字段;响应体永不含堆栈/SQL', async () => {
    const r = await api('POST', '/api/org/departments', { token: bossToken, body: { name: '' } })
    expect(r.status).toBe(422)
    expect(r.json.error.code).toBe('VALIDATION')
    const paths = r.json.error.fields.map((f: { path: string }) => f.path)
    expect(paths).toContain('name')
    const raw = JSON.stringify(r.json)
    expect(raw).not.toMatch(/stack|select |insert |drizzle/i)
  })

  it('唯一约束冲突 → 409 DUPLICATE(不漏库错误细节)', async () => {
    // 伙伴编码改由系统生成后无法经 HTTP 造撞码,改用「员工手机号租户内唯一」验同一条错误映射
    const depts = await api('GET', '/api/org/departments', { token: bossToken })
    const deptId = depts.json.items[0].id
    const body = { name: '撞号员工', empNo: 'DUP-EMP-1', phone: '13800000001', departmentId: deptId } // seed 老板手机号
    const r = await api('POST', '/api/org/employees', { token: bossToken, body })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('DUPLICATE')
    expect(JSON.stringify(r.json)).not.toMatch(/constraint "|employees_tenant_phone/i)
  })

})

describe('列表契约经 HTTP', () => {
  it('?limit=9999 被钳到 ≤50', async () => {
    const r = await api('GET', '/api/org/employees?limit=9999', { token: bossToken })
    expect(r.status).toBe(200)
    expect(r.json.items.length).toBeLessThanOrEqual(50)
    expect(r.json).toHaveProperty('nextCursor')
  })
})

describe('组织与审计经 HTTP', () => {
  it('建部门→建员工', async () => {
    const dept = await api('POST', '/api/org/departments', { token: bossToken, body: { name: '工程二部' } })
    expect(dept.status).toBe(201)
    const emp = await api('POST', '/api/org/employees', {
      token: bossToken,
      body: { name: '小李', empNo: 'S099', phone: '13800000999', departmentId: dept.json.id },
    })
    expect(emp.status).toBe(201)
  })

  it('审计:写操作经 HTTP 自动留痕(脱敏);非管理员无 audit:view → 403', async () => {
    expect((await api('GET', '/api/audit', { token: salesToken })).status).toBe(403)
    await api('POST', '/api/org/departments', { token: bossToken, body: { name: '审计留痕部门' } })
    const audit = await api('GET', '/api/audit', { token: bossToken })
    expect(audit.status).toBe(200)
    const row = audit.json.items.find((a: any) => a.action.includes('/api/org/departments') && a.result === 'success')
    expect(row).toBeTruthy()
    expect(row.actorName).toBeTruthy()
    expect(row.detail?.name).toBe('审计留痕部门')
    expect(JSON.stringify(audit.json.items)).not.toContain('password')
  })
})
