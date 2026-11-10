// core/storage/providers.ts
// 平台级对象存储 provider 注册表。local(本地磁盘)/ oss(阿里云 OSS)/ tos(火山引擎 TOS)。
// fields 决定「系统设置 → 文件存储」里每个 provider 展示哪些参数;secret 字段(access_key_secret)加密入库。
export type StorageProviderId = 'local' | 'oss' | 'tos'

export type StorageField = {
  key: 'region' | 'bucket' | 'endpoint' | 'publicBase' | 'accessKeyId' | 'accessKeySecret'
  label: string
  required: boolean
  secret?: boolean
  placeholder?: string
}

export type StorageProvider = {
  id: StorageProviderId
  label: string
  fields: StorageField[]
}

export const STORAGE_PROVIDERS: Record<StorageProviderId, StorageProvider> = {
  local: {
    id: 'local',
    label: '本地磁盘',
    fields: [],
  },
  oss: {
    id: 'oss',
    label: '阿里云 OSS',
    fields: [
      { key: 'region', label: 'Region', required: true, placeholder: '如 oss-cn-hangzhou（或 cn-hangzhou）' },
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'accessKeyId', label: 'AccessKey ID', required: true },
      { key: 'accessKeySecret', label: 'AccessKey Secret', required: true, secret: true },
      { key: 'endpoint', label: 'Endpoint（可选，内网/自定义域名）', required: false },
      { key: 'publicBase', label: '公开访问域名（可选，CDN/自定义域名）', required: false, placeholder: 'https://cdn.example.com' },
    ],
  },
  tos: {
    id: 'tos',
    label: '火山引擎 TOS',
    fields: [
      { key: 'region', label: 'Region', required: true, placeholder: '如 cn-beijing' },
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'endpoint', label: 'Endpoint', required: true, placeholder: '如 tos-cn-beijing.volces.com' },
      { key: 'accessKeyId', label: 'AccessKey ID', required: true },
      { key: 'accessKeySecret', label: 'AccessKey Secret', required: true, secret: true },
      { key: 'publicBase', label: '公开访问域名（可选，CDN/自定义域名）', required: false },
    ],
  },
}

export function isStorageProviderId(v: string): v is StorageProviderId {
  return v === 'local' || v === 'oss' || v === 'tos'
}

/** 已解密的 provider 连接参数(内部使用,绝不出接口)。 */
export type ResolvedCreds = {
  region: string
  bucket: string
  endpoint: string
  publicBase: string
  accessKeyId: string
  accessKeySecret: string
}

/**
 * 兼容旧部署:未在库里配存储时,回退读历史 env(FEEDBACK_OSS_*)。
 * 老 base 用 env 配 OSS 的部署,升级后不动设置页也照常走 OSS。
 */
export function legacyOssEnvCreds(): ResolvedCreds | null {
  const region = (process.env.FEEDBACK_OSS_REGION || '').trim()
  const bucket = (process.env.FEEDBACK_OSS_BUCKET || '').trim()
  const accessKeyId = (process.env.FEEDBACK_OSS_ACCESS_KEY_ID || '').trim()
  const accessKeySecret = (process.env.FEEDBACK_OSS_ACCESS_KEY_SECRET || '').trim()
  if (!region || !bucket || !accessKeyId || !accessKeySecret) return null
  return {
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    endpoint: (process.env.FEEDBACK_OSS_ENDPOINT || '').trim(),
    publicBase: (process.env.FEEDBACK_OSS_PUBLIC_BASE || '').trim(),
  }
}
