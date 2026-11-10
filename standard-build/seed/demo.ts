// seed/demo.ts
// 演示数据:空库即可登录,并有一条 PCB CAM 演示项目。
import type { Ctx, Db } from '../core/db/client'
import { bootstrapTenant } from '../core/org/logic/bootstrap'
import { createDepartment } from '../core/org/logic/department-tree'
import { createEmployee } from '../core/org/logic/employee'
import { seedPcbCamDemo } from '../modules/pcb-cam/seed'

/** 演示老板的登录名/密码(本机演示与 SEED_DEMO 试用库共用;DEMO_LOGIN=true 时 /api/auth/demo-login 用它自动登录) */
export const DEMO_BOSS_PHONE = '13800000001'
export const DEMO_BOSS_PASSWORD = 'demo-pass-123'

export async function seedDemo(db: Db): Promise<{ tenantId: string; rootEntityId: string; bossPhone: string; bossPassword: string }> {
  const { tenant, rootDept, owner } = await bootstrapTenant(db, {
    tenantName: 'PCB 演示',
    owner: { name: '王老板', empNo: 'BOSS', phone: DEMO_BOSS_PHONE, password: DEMO_BOSS_PASSWORD },
  })
  const ctx: Ctx = { tenantId: tenant.id, employeeId: owner.id, entityId: rootDept.id }
  const engineering = await createDepartment(db, ctx, { name: '工程部', parentId: rootDept.id })
  // 无角色的工程员:用来验收「没有组织管理权的人进不了账号页,但选人下拉仍可用」。
  await createEmployee(db, ctx, {
    name: '小张',
    empNo: 'ENG01',
    phone: '13800000002',
    password: DEMO_BOSS_PASSWORD,
    departmentId: engineering.id,
  })
  await seedPcbCamDemo(db, ctx, { casesDir: null })
  return { tenantId: tenant.id, rootEntityId: rootDept.id, bossPhone: DEMO_BOSS_PHONE, bossPassword: DEMO_BOSS_PASSWORD }
}
