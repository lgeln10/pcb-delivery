# core/db — 公共字段 + 软删除/审计机制 + 迁移 + 三个标准实现模板

| 内容 | 文件 | 说明 |
|---|---|---|
| 8 公共字段列组 | `common-fields.ts` | 新业务表 spread `commonFields`;tenant/permission 例外见文件注释 |
| 软删除/隔离/审计助手 | `soft-delete.ts` | `scope()` 查询前缀、`softDelete()`、`auditedUpdate()`(created_by 不可变) |
| 状态字段统一约定 | `status-convention.ts` | text + CHECK,常量同源;所有"作废"叫 void |
| 迁移 | `migrations/` | **手写幂等 SQL,别跑 `db:generate`** —— 见下方「怎么加一条迁移」 |
| 测试基建 | `test-helpers.ts` | PGlite 进程内真 Postgres |

## 标准实现模板(★拷贝,不要 import)

| 模板 | 解决什么 | 谁拷贝 |
|---|---|---|
| `templates/tree/` | parent_id+path 双字段、防环、迁移级联重算、并发锁 | org 部门树(已拷)、finance 科目树、将来 BOM 树 |
| `templates/polymorphic-link/` | (doc_type, doc_id) 弱关联 + 孤儿检查 | document 附件/日志/关联、finance 凭证来源 |

为什么是模板不是共享基类:共享基类制造跨模块依赖,改基类炸所有树;模板拷贝让各模块自包含,
但防环/级联/孤儿检查这些**高风险易错逻辑**都源自同一份带测试的正确实现(见 docs/DATA_MODEL.md §3)。

拷贝步骤:整个模板目录拷进你的模块 → 换表名/锁 key → 模板测试一起拷走改造 → 跑绿。

## 怎么加一条迁移(★别跑 `db:generate`)

`npm run db:generate` 在这个仓里**已经不能用了**。实测(2026-07-30):它会卡在 TTY 交互提示,问
「`ocr_invoice_tasks` 是新建的,还是从 `follow_ups` / `feedback_provider_keys` 改名来的?」——
因为 `migrations/meta` 的快照停在 **0037**,而模型早已走到 150 条之后,两边差了一百多张表的历史。
硬答下去会生成**重建既有表**的 SQL。0149/0150 的文件头注释也写着同一条惯例。

手写三步:

1. 写 `core/db/migrations/01XX_你的改动.sql`,**全部 DDL 用幂等写法**
   (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS`),
   多条之间用 `--> statement-breakpoint` 分隔。为什么必须幂等:见下一节最后一条 —— 补跑漏跑迁移时,
   只有幂等的 DDL 才敢抬 `when` 重跑。
2. 在 `migrations/meta/_journal.json` 的 `entries` **末尾**追加
   `{ "idx": 1XX, "version": "7", "when": <当前最大值 + 60000>, "tag": "<文件名去掉 .sql>", "breakpoints": true }`。
3. 跑 `npx vitest run core/db/migration-journal-guard.test.ts` —— 它会拦住 `when` 不递增和 tag 对不上文件。

> 快照不用管(它已经没在维护了)。测试用 PGlite 从零跑全部 SQL,所以迁移写错会在测试里直接炸。

## ⚠️ 迁移 journal 的 when 必须严格递增

drizzle 的 migrate 开跑前只取一次库里 `__drizzle_migrations` 的最大 `created_at` 当基准(**循环期间不更新**),
之后只执行 `_journal.json` 里 `when` **严格大于**该基准的条目。所以某条的 `when` 一旦低于它前面任何一条,
凡是已迁过前面那条的库,这条就**永远**不会执行 —— 而全新库(基准为空)反倒一条不落。于是本地、CI、
新装客户全绿,只有老生产库缺表缺列,极难自查(本仓已因此出过三次事故:最近一次是 unix 上 0188/0189/0190 漏跑,`partners.grade_id`
不存在把销售助理整个打挂;cosmo 上另有 0188–0198/0209 漏跑,靠幂等补跑迁移救回)。

- **新增迁移**:`when` 取当前 journal 最大值 + 一档,条目放 `entries` 末尾。cherry-pick 到 fork 时
  尤其容易踩 —— fork 的 journal 尾部时间戳与 base 不同,照抄 base 的 `when` 就会倒挂。
- **已经漏跑到生产**:把漏掉的条目 `when` 抬到最大值之上并移到末尾。★但**别把「重跑幂等」当默认前提** ——
  2026-07-28 逐条查过存量倒挂条目的 SQL(见 `MIGRATION_JOURNAL_AUDIT.md`):`product/manufacturing`
  26 条倒挂里 **20 条重跑不安全**、`product/cosmo` 11 条里 **9 条不安全**,形态是裸 `CREATE TABLE` /
  `CREATE INDEX` / `ALTER TABLE ADD COLUMN` / `ADD CONSTRAINT`(都没有 `IF NOT EXISTS`)。
  对**已经跑过**这些迁移的库,抬 `when` 让它重跑会直接报「已存在」把发版打挂。
  所以处置前先在客户库上查水位 `SELECT max(created_at) FROM __drizzle_migrations;`:
  `when` 低于水位且**对象已存在** → 不能抬(要么保持现状,要么先改成幂等 DDL);
  `when` 低于水位但**对象不存在** → 确属漏跑,抬 `when` 补跑即可。
  改完跑 `core/db/migration-journal-guard.test.ts` 复核。
- 该护栏测试会在合并前直接变红,不必靠人工核对。
