// core/db/client.ts
// 数据库类型定义。所有模块的 logic/api 函数都接收这个 Db 类型,显式传入,不用全局单例。
// 生产环境用 node-postgres(core/auth 接入期再装);测试环境用 PGlite(进程内真 Postgres)。
// 两者都是 drizzle 的 PgDatabase,业务代码无感。
import type { PgDatabase } from 'drizzle-orm/pg-core'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, any, any>

// 操作者上下文:所有写操作显式携带,用于 tenant 隔离 + created_by/updated_by 审计。
// 来源:core/auth 解析登录态后构造(本期由调用方/测试直接构造)。
export type Ctx = {
  tenantId: string
  employeeId: string
  // 当前账套实体(财务独立核算部门 id)。由 HTTP 中间件按 X-Accounting-Entity 头解析,缺省=根部门。
  // 仅 finance 模块消费(按 entity 隔离多套账);其余模块忽略。非 HTTP 调用方(测试/seed)可不设,
  // finance logic 用 entityOf() 断言兜底。
  entityId?: string
  // 服务令牌(svc_…)解析出的权限码白名单。仅当调用方是 svc 令牌时存在：
  // requirePermission 用它封顶(越出 scopes 一律 403)；普通登录态为 undefined，走常规权限判定。
  scopes?: string[]
}
