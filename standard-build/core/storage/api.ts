// core/storage/api.ts — 平台文件存储基础设施对外唯一入口。
// 业务模块要落地文件:走 putObject / readObject / deleteObject,不各自读 env、不各自连 OSS/TOS。
export {
  STORAGE_PROVIDERS,
  isStorageProviderId,
  type StorageProviderId,
  type StorageProvider,
} from './providers'
export { StorageError, type StorageErrorCode } from './errors'
export {
  getConfig,
  setActiveProvider,
  saveProviderConfig,
  deleteProviderConfig,
  resolveActiveBackend,
  resolveProviderCreds,
  type StorageConfigDTO,
} from './config'
export { putObject, readObject, deleteObject, testProvider, UPLOAD_DIR, type StoredFile, type PutInput, type FileVisibility } from './service'
// 上传类型校验:客户端给的 filename/Content-Type 一律不可信,先过 checkUpload 再 putObject,
// 并用它返回的 contentType(理由见 upload-guard.ts 头注释)。三处上传口共用一套判定,不各写各的。
export { checkUpload, extOf, looksLikeMarkup, KNOWN_UPLOAD_EXTS, type UploadCheck } from './upload-guard'
// 公开/私有那条线的唯一定义:只有这几个前缀下的对象匿名可读(logo 未登录要显示、官网图爬虫要读)。
export { PUBLIC_KEY_PREFIXES, isPublicStorageKey } from './public-prefix'
// 私有文件内部标记(storage:private/<key>):业务模块拿到附件 URL 后若要在服务端读字节,用它解出 key 再 readObject。
export { isPrivateMarker, keyFromPrivateMarker, privateMarker, normalizeStoredFileUrl } from './private-url'
export { migrateLocalToActiveCloud, type MigrationSummary } from './migrate'
export { repairPublicObjectAcl, type PublicAclRepairSummary } from './repair-public'
export { storageRoutes } from './routes'
