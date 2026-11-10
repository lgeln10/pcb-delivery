// core/org/logic/errors.ts
// org 模块统一业务错误。code 给调用方/前端做分支,message 给人看(不含内部堆栈/SQL)。
export type OrgErrorCode =
  | 'NOT_FOUND'
  | 'PARENT_NOT_FOUND'
  | 'CYCLE_DETECTED'
  | 'DEPT_HAS_ACTIVE_EMPLOYEES'
  | 'DEPT_HAS_CHILDREN'
  | 'EMPLOYEE_NOT_ACTIVE'
  | 'EMPLOYEE_HAS_LOGIN'
  | 'EMPLOYEE_HAS_SUBORDINATES'
  | 'EMPLOYEE_IS_OWNER'
  | 'BUILTIN_ROLE_PROTECTED'
  | 'SUPERADMIN_GRANT_FORBIDDEN' // 内置超管角色只能由超管授出(见 role.ts 的 assignRoles)
  | 'PERMISSION_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'WRONG_PASSWORD' // 自助改密时原密码不正确
  | 'NESTED_ACCOUNTING_ENTITY' // 独立核算节点不得嵌套(祖先/子孙已有独立核算)
  | 'ROOT_ENTITY_LOCKED' // 根部门恒为独立核算,不可关闭
  | 'DEPT_IS_ACCOUNTING_ENTITY' // 财务独立核算账套禁止物理删除(防孤儿账套)
  | 'ACCOUNTING_ENTITY_FORBIDDEN' // 当前权限数据范围不可访问指定账套

export class OrgError extends Error {
  constructor(
    public code: OrgErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OrgError'
  }
}
