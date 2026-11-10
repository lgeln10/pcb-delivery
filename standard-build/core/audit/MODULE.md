# audit — MODULE.md

# ============ 上半部:实现层(实现 agent 用)============

## 职责(一句话)
记录租户内所有写操作的审计留痕,只增不改不删。来源枚举支持 http/system/login 三种,但**当前唯一生产者是 HTTP 中间件(source='http')**——login/system 只是模型预留,尚无调用方。

## 拥有的实体(写权限唯一归本模块)
`auditLogs`(`model.ts:7`,人/时间/动作/目标/入参(脱敏)/结果/IP,索引支持按人/按时间/按结果查询)

## 只读依赖
无——中间件在鉴权后直接写,不依赖其他模块数据。

## 核心流程
1. HTTP 写请求鉴权通过后,中间件自动调 `recordAuditSafe`(`logic.ts:57`)落一条审计记录,业务模块零接入。
2. `sanitizeDetail`(`logic.ts:12`)递归脱敏:入参中 key 含 password/token/secret/authorization 的字段整体剔除,不入库。
3. 查询侧 `listAudit`(`logic.ts:88`)按结果/动作关键词/时间范围/操作人筛选 + 游标分页。

## 关键不变量(AI 改动不能破坏)
- **Append-only**:模块内无 update/delete 接口,历史记录任何人改不了(架构保证,非软删除口径)。
- **写入 best-effort,绝不阻断业务**:`recordAuditSafe`(`logic.ts:57`)吞掉记录失败的异常,审计故障不能导致业务写操作失败;`recordAudit`(`logic.ts:40`)是会抛错的版本,仅供明确需要感知失败的调用方。
- **脱敏红线**:`sanitizeDetail` 对 password/token/secret/authorization 子串字段一律剔除后才落库,不存在"先存后脱敏"的时间窗口。
> 对应测试:`core/audit/tests/audit.test.ts`(append-only 与脱敏断言)。

## 对外接口
- `recordAudit(db, entry)` / `recordAuditSafe(db, entry)`:写入一条审计记录(`AuditEntry` 类型,`logic.ts:25`)
- `listAudit(db, ctx, filter)`:分页查询(`AuditFilter` 类型,`logic.ts:75`)
- `resolveActorName(db, tenantId, employeeId)`(写入前解析姓名快照)/ `sanitizeDetail(value)`(脱敏,中间件与调用方共用)——均经 `api.ts` 导出

## 常见改动入口
- 加新的审计来源(除 http/system/login)→ `AuditEntry` 的来源枚举 + 各来源的调用点
- 加脱敏字段关键词 → `sanitizeDetail`(`logic.ts:12`)的 key 匹配列表
- 加导出/归档/保留期限 → 当前无此能力,需新建(见下半部「日志保留多久/导出」)

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事

操作记录、日志、审计、谁改的、谁删的、什么时候动过、留痕、追责、登录记录

## 业务概念词典

| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「查查这条是谁改的」 | 每个写操作自动留痕:人/时间/动作/目标/入参/结果/IP | 审计日志 页 | 轻 |
| 「筛某段时间/某类操作」 | 页面筛选栏:按结果(成功/失败)、动作关键词、时间范围筛选 + 分页;按操作人/目标筛选接口已支持但页面未开入口 | 审计日志 · 筛选栏 | 轻 |
| 「看操作详情」 | 点行看详情:入参已自动脱敏(密码/密钥类字段不入库) | 审计日志 · 详情抽屉 | 轻 |
| 「日志会不会被人删改」 | 只增不改不删(append-only),系统无任何编辑/删除接口 | —(架构保证) | — |
| 「员工离职了记录还在吗」 | 写入时存姓名快照,改名/删人后仍可读 | 审计日志 | — |
| 「查登录记录」 | 模型预留了 login 来源,但登录事件当前**没有接入**审计(登录接口在审计中间件之前,无生产者) | 未实现 | 中 |
| 「日志保留多久/导出」 | 目前永久保留、无导出/归档清理 | 未实现 | 中 |

## 可调旋钮清单

□ 审计日志页筛选维度(轻 · 页面现有:结果/动作/时间;操作人/目标接口(`AuditFilter`)已支持,页面筛选栏未开)
□ 动作语义化/人类可读摘要(中 · 现为「方法+路由」基线,targetType/summary 字段已预留富化)
□ 日志导出 / 保留期限与归档清理(中 · 未实现)

## 本模块约定与边界

- **自动留痕口径**:HTTP 中间件在鉴权后自动记录每个写操作(非查询请求),业务模块零接入。来源枚举分 http/system/login,但登录事件与系统任务**目前尚未接入**(接口已备好 `recordAudit`,无调用方)。审计写入 best-effort:记录失败绝不阻断业务。
- **脱敏红线**:入参里含 password/token/secret/authorization 的字段一律剔除,不入库。
- **与 org 的关系**:查看权限(audit:view)在「角色与权限」页授予;审计只读,谁都改不了历史。
