// core/llm/tests/provider-key.test.ts
// 平台 LLM 各供应商 api-key:AES-GCM 加密往返、加密存库 + env 兜底、DTO 不泄明文、租户隔离。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import type { Ctx } from '../../db/client'
import { decryptSecret, encryptSecret } from '../../crypto/secret-box'
import { deleteProviderKey, getConfig, resolveProviderApiKey, saveProviderKey } from '../config'

let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-master-secret-for-encryption-0123456789'
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.ARK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db, '密钥公司')).ownerCtx
})
afterAll(async () => t.close())

describe('LLM 供应商 api-key 加密存储', () => {
  it('加密可往返,密文不含明文', () => {
    const plain = 'sk-secret-12345'
    const blob = encryptSecret(plain)
    expect(blob).not.toContain(plain)
    expect(blob.startsWith('v1:')).toBe(true)
    expect(decryptSecret(blob)).toBe(plain)
  })

  it('保存后 resolveProviderApiKey 解密返回原值;getConfig 只暴露布尔、不含明文', async () => {
    await saveProviderKey(t.db, ctx, 'bailian', 'sk-bailian-xyz')
    expect(await resolveProviderApiKey(t.db, ctx, 'bailian')).toBe('sk-bailian-xyz')
    const cfg = await getConfig(t.db, ctx)
    expect(cfg.savedKeyStatus.bailian).toBe(true)
    expect(cfg.keyStoreReady).toBe(true)
    expect(JSON.stringify(cfg)).not.toContain('sk-bailian-xyz')
  })

  it('再次保存为替换(upsert)', async () => {
    await saveProviderKey(t.db, ctx, 'bailian', 'sk-new-1')
    expect(await resolveProviderApiKey(t.db, ctx, 'bailian')).toBe('sk-new-1')
  })

  it('DeepSeek 渠道:保存/解密/DTO 状态', async () => {
    await saveProviderKey(t.db, ctx, 'deepseek', 'sk-deepseek-abc')
    expect(await resolveProviderApiKey(t.db, ctx, 'deepseek')).toBe('sk-deepseek-abc')
    const cfg = await getConfig(t.db, ctx)
    expect(cfg.savedKeyStatus.deepseek).toBe(true)
    expect(cfg.providers.some((p) => p.id === 'deepseek')).toBe(true)
  })

  it('未存库时回退 env key', async () => {
    process.env.ARK_API_KEY = 'env-ark-key'
    expect(await resolveProviderApiKey(t.db, ctx, 'ark')).toBe('env-ark-key')
    const cfg = await getConfig(t.db, ctx)
    expect(cfg.savedKeyStatus.ark).toBe(false)
    expect(cfg.envKeyStatus.ark).toBe(true)
    delete process.env.ARK_API_KEY
  })

  it('清除库内 key 后回退 env;savedKeyStatus 转 false', async () => {
    process.env.DASHSCOPE_API_KEY = 'env-bailian-key'
    await deleteProviderKey(t.db, ctx, 'bailian')
    expect(await resolveProviderApiKey(t.db, ctx, 'bailian')).toBe('env-bailian-key')
    expect((await getConfig(t.db, ctx)).savedKeyStatus.bailian).toBe(false)
    delete process.env.DASHSCOPE_API_KEY
  })

  it('未知 provider 拒绝保存', async () => {
    await expect(saveProviderKey(t.db, ctx, 'unknown', 'x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('租户隔离:A 存的 key,B 取不到', async () => {
    delete process.env.DASHSCOPE_API_KEY
    const ctxB = (await seedTenant(t.db, '另一密钥公司')).ownerCtx
    await saveProviderKey(t.db, ctx, 'bailian', 'sk-A-only')
    expect(await resolveProviderApiKey(t.db, ctxB, 'bailian')).toBeUndefined()
  })
})
