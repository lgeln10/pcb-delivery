// modules/menu-order/errors.ts
export type MenuOrderErrorCode =
  | 'INVALID_INPUT' // 结构/格式/规模不合法(非数组、非对象、key 含非法字符、条数超限)
export class MenuOrderError extends Error {
  constructor(
    public code: MenuOrderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MenuOrderError'
  }
}
