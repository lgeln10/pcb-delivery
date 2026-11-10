// core/storage/tests/storage-config.test.ts
// 平台文件存储配置:CRUD + 加密不外泄 + 生效后端解析 + 本地上传 + env 兜底 + 启用前置校验。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import type { Ctx } from '../../db/client'

// 存储在模块加载时读 UPLOAD_DIR;主密钥就绪才能加密 secret。先设 env 再动态 import。
const UP = join(tmpdir(), `storage-test-${randomUUID()}`)
process.env.UPLOAD_DIR = UP
process.env.CONFIG_ENC_KEY = 'test-master-key-0123456789'
delete process.env.PUBLIC_BASE_URL
delete process.env.NGINX_SERVER_NAME
for (const k of ['FEEDBACK_OSS_REGION', 'FEEDBACK_OSS_BUCKET', 'FEEDBACK_OSS_ACCESS_KEY_ID', 'FEEDBACK_OSS_ACCESS_KEY_SECRET']) delete process.env[k]

let cfgMod: typeof import('../config')
let svc: typeof import('../service')
let t: OrgTestDb
let ctx: Ctx

beforeAll(async () => {
  cfgMod = await import('../config')
  svc = await import('../service')
  t = await createOrgTestDb()
  ctx = (await seedTenant(t.db, '存储公司')).ownerCtx
})
afterAll(async () => t.close())

describe('core/storage 配置', () => {
  it('默认 local;providers 含 oss/tos 且未配置', async () => {
    const c = await cfgMod.getConfig(t.db, ctx)
    expect(c.activeProvider).toBe('local')
    expect(c.keyStoreReady).toBe(true)
    expect(c.providers.map((p) => p.id).sort()).toEqual(['oss', 'tos'])
    const oss = c.providers.find((p) => p.id === 'oss')!
    expect(oss.configured).toBe(false)
    expect(oss.secretSaved).toBe(false)
  })

  it('未配置就启用 oss → 报 STORAGE_NOT_CONFIGURED', async () => {
    await expect(cfgMod.setActiveProvider(t.db, ctx, 'oss')).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' })
  })

  it('保存 oss 参数:configured/secretSaved 置真,但接口绝不回明文 secret', async () => {
    const c = await cfgMod.saveProviderConfig(t.db, ctx, 'oss', {
      region: 'oss-cn-hangzhou',
      bucket: 'my-bucket',
      accessKeyId: 'AKID',
      accessKeySecret: 'SUPER-SECRET',
      publicBase: 'https://cdn.example.com/',
    })
    const oss = c.providers.find((p) => p.id === 'oss')!
    expect(oss.configured).toBe(true)
    expect(oss.secretSaved).toBe(true)
    expect(oss.values.accessKeyId).toBe('AKID')
    expect(oss.values.publicBase).toBe('https://cdn.example.com') // 尾斜杠已归一
    // DTO 里任何字段都不含明文 secret
    expect(JSON.stringify(c)).not.toContain('SUPER-SECRET')
  })

  it('保存后可启用 oss;resolveActiveBackend 解出明文 creds', async () => {
    const c = await cfgMod.setActiveProvider(t.db, ctx, 'oss')
    expect(c.activeProvider).toBe('oss')
    const backend = await cfgMod.resolveActiveBackend(t.db, ctx)
    expect(backend.provider).toBe('oss')
    expect(backend.creds?.accessKeySecret).toBe('SUPER-SECRET')
    expect(backend.creds?.bucket).toBe('my-bucket')
  })

  it('只更新非 secret 字段(不传 secret)→ 原密文保留', async () => {
    await cfgMod.saveProviderConfig(t.db, ctx, 'oss', { bucket: 'renamed-bucket' })
    const backend = await cfgMod.resolveActiveBackend(t.db, ctx)
    expect(backend.creds?.bucket).toBe('renamed-bucket')
    expect(backend.creds?.accessKeySecret).toBe('SUPER-SECRET') // 未随之丢失
  })

  it('清除 oss 配置 → 正在生效则回落 local', async () => {
    const c = await cfgMod.deleteProviderConfig(t.db, ctx, 'oss')
    expect(c.activeProvider).toBe('local')
    expect(c.providers.find((p) => p.id === 'oss')!.secretSaved).toBe(false)
  })
})

describe('core/storage 上传(local)', () => {
  it('putObject 默认私有:写本地磁盘,但返回内部标记(不给匿名可访问地址)', async () => {
    const r = await svc.putObject(t.db, ctx, { bytes: Buffer.from('hi'), filename: '报 表.txt', contentType: 'text/plain', keyPrefix: 'feedback' })
    expect(r.key.startsWith('feedback/')).toBe(true)
    expect(r.url).toBe(`storage:private/${r.key}`) // 出站中间件再换成带票据的 /api/files/...
    expect(existsSync(join(UP, r.key))).toBe(true)
    const back = await svc.readObject(t.db, ctx, r.key)
    expect(back.toString()).toBe('hi')
  })

  it('putObject 声明 public(官网图/系统 logo):仍返回 /uploads 直链,匿名可读', async () => {
    const r = await svc.putObject(t.db, ctx, { bytes: Buffer.from('png'), filename: 'logo.png', contentType: 'image/png', keyPrefix: 'branding', visibility: 'public' })
    expect(r.key.startsWith('branding/')).toBe(true)
    expect(r.url.startsWith('/uploads/branding/')).toBe(true)
    expect(existsSync(join(UP, r.key))).toBe(true)
  })
})
