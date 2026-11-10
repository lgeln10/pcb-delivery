// 租户第一行 LLM 配置**跟随 env**。
//
// ★为什么要有这条:`LLM_PROVIDER` / `LLM_MODEL` 这两个环境变量原本只被 `activeProvider()`
//   那条 env 兜底路读,而所有走 `resolveLLMRuntimeConfig` 的场景(Ask AI / 个人助手 /
//   销售助理 / 视觉…)都从库里那一行取 —— 那一行插进去时吃的是**建表默认值 bailian**。
//   于是运维在 compose 里写了 `LLM_PROVIDER=eazytec`,系统照样解析成百炼,
//   然后报「未配置 阿里百炼 的 API Key」。2026-08-19 江南自托管上实打踩到。
//   配了等于没配,而报错还指向一个人家压根没打算用的供应商 —— 典型的静默失效。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { getConfig, resolveLLMRuntimeConfig, updateConfig } from '../config'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ctx: Ctx
const saved = { p: process.env.LLM_PROVIDER, m: process.env.LLM_MODEL }

beforeEach(async () => {
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db)).ownerCtx
})
afterEach(async () => {
  process.env.LLM_PROVIDER = saved.p
  process.env.LLM_MODEL = saved.m
  await t.close()
})

describe('★租户第一行 LLM 配置跟随 env', () => {
  it('设了 LLM_PROVIDER/LLM_MODEL → 第一行就是它,不是建表默认的 bailian', async () => {
    process.env.LLM_PROVIDER = 'deepseek'
    process.env.LLM_MODEL = 'deepseek-chat'
    const cfg = await getConfig(t.db, ctx)
    expect(cfg.provider, 'env 配了却还是 bailian = 那两个环境变量等于没写').toBe('deepseek')
    expect(cfg.model).toBe('deepseek-chat')
  })

  it('没设 env → 默认自营中转 sixam(显式种子,不吃建表默认值 bailian)', async () => {
    delete process.env.LLM_PROVIDER
    delete process.env.LLM_MODEL
    expect((await getConfig(t.db, ctx)).provider).toBe('sixam')
  })

  it('★env 里写了个不认识的 provider → 忽略,回默认(sixam)。不能把非法值写进库', async () => {
    process.env.LLM_PROVIDER = 'not-a-provider'
    expect((await getConfig(t.db, ctx)).provider).toBe('sixam')
  })

  it('★已经有行的租户不被 env 覆盖 —— 那是人在设置页里选的', async () => {
    delete process.env.LLM_PROVIDER
    await getConfig(t.db, ctx) // 先建行(bailian)
    await updateConfig(t.db, ctx, { provider: 'ark', model: 'doubao-pro-32k' })
    process.env.LLM_PROVIDER = 'deepseek'
    expect((await getConfig(t.db, ctx)).provider, 'env 反过来覆盖了人的选择').toBe('ark')
  })

  it('场景解析真的用上了这一行 —— 这才是当初炸的那一跳', async () => {
    process.env.LLM_PROVIDER = 'deepseek'
    process.env.LLM_MODEL = 'deepseek-chat'
    process.env.DEEPSEEK_API_KEY = 'k-for-test'
    const r = await resolveLLMRuntimeConfig(t.db, ctx, 'askai')
    expect(r.provider).toBe('deepseek')
    expect(r.model).toBe('deepseek-chat')
  })
})
