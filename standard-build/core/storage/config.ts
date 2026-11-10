// core/storage/config.ts
// 平台文件存储配置的读/写(每租户一行)+ 运行时解析生效 provider 的连接参数。
// 「系统设置 → 文件存储」维护;所有模块的上传/下载都经 service.ts 走这里选定的后端。
// ★密钥红线:access_key_secret 加密后入库,接口只回「是否已配置」布尔,绝不回明文。
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { auditedUpdate, scope, softDelete } from '../db/soft-delete'
import { decryptSecret, encryptSecret, isKeyStoreAvailable } from '../crypto/secret-box'
import { StorageError } from './errors'
import {
  STORAGE_PROVIDERS,
  isStorageProviderId,
  legacyOssEnvCreds,
  type ResolvedCreds,
  type StorageProviderId,
} from './providers'
import { storageConfigs, storageProviderConfigs, type StorageConfig, type StorageProviderConfig } from './model'

async function ensureConfig(db: Db, ctx: Ctx): Promise<StorageConfig> {
  const load = () =>
    db
      .select()
      .from(storageConfigs)
      .where(and(eq(storageConfigs.tenantId, ctx.tenantId), eq(storageConfigs.isDeleted, false)))
      .limit(1)
  const rows = await load()
  if (rows[0]) return rows[0]
  // ★首用同一租户时并发(如一次上传多张发票 Promise.all 各自 putObject)会同时命中「查无→插入」,
  //   唯一索引 storage_configs_tenant_idx 让后到者 23505。onConflictDoNothing 幂等,冲突后回读已存在行。
  const inserted = await db
    .insert(storageConfigs)
    .values({ id: randomUUID(), tenantId: ctx.tenantId, createdBy: ctx.employeeId, updatedBy: ctx.employeeId })
    .onConflictDoNothing()
    .returning()
  if (inserted[0]) return inserted[0]
  const again = await load()
  return again[0]!
}

async function providerRow(db: Db, ctx: Ctx, provider: string): Promise<StorageProviderConfig | undefined> {
  const rows = await db
    .select()
    .from(storageProviderConfigs)
    .where(and(scope(storageProviderConfigs, ctx.tenantId), eq(storageProviderConfigs.provider, provider)))
    .limit(1)
  return rows[0]
}

export type StorageProviderView = {
  id: StorageProviderId
  label: string
  fields: { key: string; label: string; required: boolean; secret: boolean; placeholder: string }[]
  configured: boolean // 必填参数齐全(不含 secret 判断)
  secretSaved: boolean // 库内已存 access_key_secret 密文
  values: { region: string; bucket: string; endpoint: string; publicBase: string; accessKeyId: string }
}

export type StorageConfigDTO = {
  activeProvider: StorageProviderId
  keyStoreReady: boolean // 加密主密钥(env)是否就绪,可往库里存 secret
  legacyEnvOss: boolean // 是否检测到历史 FEEDBACK_OSS_* 环境变量(库未配时回退它)
  providers: StorageProviderView[]
}

function viewOf(id: StorageProviderId, row: StorageProviderConfig | undefined): StorageProviderView {
  const def = STORAGE_PROVIDERS[id]
  const requiredNonSecret = def.fields.filter((f) => f.required && !f.secret)
  const values = {
    region: row?.region ?? '',
    bucket: row?.bucket ?? '',
    endpoint: row?.endpoint ?? '',
    publicBase: row?.publicBase ?? '',
    accessKeyId: row?.accessKeyId ?? '',
  }
  const configured = requiredNonSecret.every((f) => (values[f.key as keyof typeof values] ?? '').trim() !== '')
  return {
    id,
    label: def.label,
    fields: def.fields.map((f) => ({
      key: f.key,
      label: f.label,
      required: f.required,
      secret: !!f.secret,
      placeholder: f.placeholder ?? '',
    })),
    configured,
    secretSaved: !!(row?.accessKeySecretEnc ?? '').trim(),
    values,
  }
}

export async function getConfig(db: Db, ctx: Ctx): Promise<StorageConfigDTO> {
  const cfg = await ensureConfig(db, ctx)
  const cloudIds: StorageProviderId[] = ['oss', 'tos']
  const providers = await Promise.all(cloudIds.map(async (id) => viewOf(id, await providerRow(db, ctx, id))))
  return {
    activeProvider: cfg.activeProvider as StorageProviderId,
    keyStoreReady: isKeyStoreAvailable(),
    legacyEnvOss: !!legacyOssEnvCreds(),
    providers,
  }
}

/** 切换生效 provider。切到 oss/tos 前必须该 provider 参数齐全且已存 secret(或库外 env 兜底不适用)。 */
export async function setActiveProvider(db: Db, ctx: Ctx, provider: string): Promise<StorageConfigDTO> {
  if (!isStorageProviderId(provider)) throw new StorageError('INVALID_INPUT', `未知存储 provider: ${provider}`)
  if (provider !== 'local') {
    const row = await providerRow(db, ctx, provider)
    const view = viewOf(provider, row)
    if (!view.configured || !view.secretSaved) {
      throw new StorageError('STORAGE_NOT_CONFIGURED', `请先填完并保存 ${STORAGE_PROVIDERS[provider].label} 的参数（含 AccessKey Secret）再启用`)
    }
  }
  const cfg = await ensureConfig(db, ctx)
  await auditedUpdate(db, storageConfigs, ctx.tenantId, cfg.id, ctx.employeeId, { activeProvider: provider })
  return getConfig(db, ctx)
}

export type SaveProviderInput = {
  region?: string
  bucket?: string
  endpoint?: string
  publicBase?: string
  accessKeyId?: string
  accessKeySecret?: string // 省略则保留原密文;传空串不允许覆盖成空
}

/** 保存某 provider 的连接参数。secret 加密后 upsert;未传 secret 时保留原密文。 */
export async function saveProviderConfig(db: Db, ctx: Ctx, provider: string, input: SaveProviderInput): Promise<StorageConfigDTO> {
  if (provider !== 'oss' && provider !== 'tos') throw new StorageError('INVALID_INPUT', `不支持配置的 provider: ${provider}`)
  const existing = await providerRow(db, ctx, provider)

  let secretEnc = existing?.accessKeySecretEnc ?? ''
  if (input.accessKeySecret !== undefined) {
    const s = input.accessKeySecret.trim()
    if (s) secretEnc = encryptSecret(s) // 主密钥缺失 → 抛 KEY_STORE_UNAVAILABLE(400)
    // 传了空串:视为「不改」,保留原密文(不清空);要清空走 delete
  }

  const fields = {
    provider,
    region: (input.region ?? existing?.region ?? '').trim(),
    bucket: (input.bucket ?? existing?.bucket ?? '').trim(),
    endpoint: (input.endpoint ?? existing?.endpoint ?? '').trim(),
    publicBase: (input.publicBase ?? existing?.publicBase ?? '').trim().replace(/\/$/, ''),
    accessKeyId: (input.accessKeyId ?? existing?.accessKeyId ?? '').trim(),
    accessKeySecretEnc: secretEnc,
  }

  if (existing) {
    await auditedUpdate(db, storageProviderConfigs, ctx.tenantId, existing.id, ctx.employeeId, fields)
  } else {
    await db.insert(storageProviderConfigs).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      ...fields,
    })
  }
  return getConfig(db, ctx)
}

/** 清除某 provider 配置(软删)。若它正生效则回落 local。 */
export async function deleteProviderConfig(db: Db, ctx: Ctx, provider: string): Promise<StorageConfigDTO> {
  const existing = await providerRow(db, ctx, provider)
  if (existing) await softDelete(db, storageProviderConfigs, ctx.tenantId, existing.id, ctx.employeeId)
  const cfg = await ensureConfig(db, ctx)
  if (cfg.activeProvider === provider) {
    await auditedUpdate(db, storageConfigs, ctx.tenantId, cfg.id, ctx.employeeId, { activeProvider: 'local' })
  }
  return getConfig(db, ctx)
}

/** 解析某指定 provider 的已解密连接参数(供「测试连接」用);未配置/解密失败返回 null。 */
export async function resolveProviderCreds(db: Db, ctx: Ctx, provider: string): Promise<ResolvedCreds | null> {
  const row = await providerRow(db, ctx, provider)
  if (!row || !row.accessKeySecretEnc.trim()) return null
  try {
    return {
      region: row.region,
      bucket: row.bucket,
      endpoint: row.endpoint,
      publicBase: row.publicBase,
      accessKeyId: row.accessKeyId,
      accessKeySecret: decryptSecret(row.accessKeySecretEnc),
    }
  } catch {
    return null
  }
}

export type ActiveBackend = { provider: StorageProviderId; creds: ResolvedCreds | null }

/**
 * 解析当前租户生效的存储后端 + 已解密连接参数。
 * 顺序:库内 active_provider(oss/tos,解密 secret)→ 若为 local 但检测到历史 env OSS → 用 env OSS → 否则 local。
 * 解密失败(主密钥变更/密文损坏)则回落 local,绝不泄露明文。
 */
export async function resolveActiveBackend(db: Db, ctx: Ctx): Promise<ActiveBackend> {
  const cfg = await ensureConfig(db, ctx)
  const active = cfg.activeProvider as StorageProviderId

  if (active === 'oss' || active === 'tos') {
    const row = await providerRow(db, ctx, active)
    if (row && row.accessKeySecretEnc.trim()) {
      try {
        return {
          provider: active,
          creds: {
            region: row.region,
            bucket: row.bucket,
            endpoint: row.endpoint,
            publicBase: row.publicBase,
            accessKeyId: row.accessKeyId,
            accessKeySecret: decryptSecret(row.accessKeySecretEnc),
          },
        }
      } catch {
        // 主密钥变更/密文损坏 → 回落 local,不抛明文
      }
    }
    return { provider: 'local', creds: null }
  }

  // active=local:兼容历史 env OSS 部署
  const envOss = legacyOssEnvCreds()
  if (envOss) return { provider: 'oss', creds: envOss }
  return { provider: 'local', creds: null }
}
