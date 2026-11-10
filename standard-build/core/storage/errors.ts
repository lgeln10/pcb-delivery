// core/storage/errors.ts — 存储配置/上传下载错误。message 不含密钥/堆栈。
export type StorageErrorCode = 'INVALID_INPUT' | 'STORAGE_NOT_CONFIGURED' | 'STORAGE_PROVIDER_ERROR'

export class StorageError extends Error {
  constructor(
    public code: StorageErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'StorageError'
  }
}
