// 演示自动驾驶:seed 登记的任务替人过层确认 / 审单 / 问题点,直到停点;真实任务(没登记)不受影响
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { syncPermissions } from '../../../core/org/api'
import type { Ctx } from '../../../core/db/client'
import { PCB_CAM_PERMISSIONS } from '../permissions'
import { PCB_CAM_STAGES } from '../stages'
import { advanceAll, demoAutopilotSize, registerDemoAutopilot, runDemoAutopilot } from '../automation'
import { FakeWorkerClient } from '../worker-client'
import { createJob, createProject, getJob, storagePrefix } from '../logic'
import { findCasesDir } from '../seed'
import { existsSync } from 'node:fs'

let t: OrgTestDb
let ctx: Ctx
beforeAll(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db, '演示自动驾驶')).ownerCtx
  await syncPermissions(t.db, PCB_CAM_PERMISSIONS)
})
afterAll(async () => t.close())

async function newJob(): Promise<string> {
  const p = await createProject(t.db, ctx, { name: 'demo' })
  const jobId = crypto.randomUUID()
  return (await createJob(t.db, ctx, p.id, { jobId, inputKeys: [`${storagePrefix(ctx.tenantId, jobId)}input/board.zip`] })).id
}
const drillEq = (stage: 'drill') => ({
  stage, status: 'needs_review' as const, summary: '', artifacts: [],
  items: [{ id: 'x', kind: 'extra_hole', severity: 'error' as const, message: '多余孔', fix: { type: 'delete', params: {}, auto_fixable: false, applied: false } }],
})

describe('demo autopilot', () => {
  it('单仓布局能找到随引擎纳入的三份真实案例', () => {
    const cases = findCasesDir()
    expect(cases).not.toBeNull()
    for (const id of ['C09_real_6l_3oz', 'C11_real_4l_altium', 'C12_real_4l_protel99']) {
      expect(existsSync(`${cases}/${id}/input/profile.yaml`)).toBe(true)
    }
  })
  it('停点 eq:drill:自动过层确认和审单,停在钻孔问题点;停点 none 一路到 done;未登记的任务停在层确认', async () => {
    const w = new FakeWorkerClient().on('drill', () => drillEq('drill'))
    const stopDrill = await newJob()
    const toEnd = await newJob()
    const real = await newJob()
    registerDemoAutopilot(stopDrill, { ctx, stopAt: 'eq:drill' })
    registerDemoAutopilot(toEnd, { ctx, stopAt: 'none', orderSpec: { thickness_mm: 1.6 } })
    expect(demoAutopilotSize()).toBe(2)
    for (let i = 0; i < PCB_CAM_STAGES.length * 3; i++) await advanceAll(t.db, w, 20)
    const a = await getJob(t.db, ctx, stopDrill)
    expect([a.status, a.currentStage, a.reviewReason]).toEqual(['needs_review', 'drill', 'eq'])
    const b = await getJob(t.db, ctx, toEnd)
    expect(b.status).toBe('done')
    expect((b.orderSpec as { thickness_mm?: number }).thickness_mm).toBe(1.6)
    const c = await getJob(t.db, ctx, real)
    expect([c.status, c.reviewReason]).toEqual(['needs_review', 'layers'])
    expect(demoAutopilotSize()).toBe(1) // done 的自动注销;停点的还在(不再动)
    expect(await runDemoAutopilot(t.db)).toBe(0)
  })
})
