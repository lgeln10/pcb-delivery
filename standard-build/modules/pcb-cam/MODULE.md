# 模块:pcb-cam(PCB CAM 工程自动化)

> 设计方案(2026-09-05,待实现)。整体落地计划与两仓分工在 pcb 仓 `docs/ROADMAP.md`;本文只讲 AIOS 这一侧。
> 几何/解析/检查全部在外部 **pcb-worker**(Python,独立 compose service)里做;本模块负责编排、持久化、权限、LLM 审单、UI。

> 2026-10-28 独立仓整合：引擎源码现位于本仓 `pcb-worker/`，Compose 直接从该目录构建；服务仍独立运行并通过 `PCB_WORKER_URL` 调用。案例优先从本仓读取，容器中只读挂载至 `/data/pcb-cases`，无需另克隆引擎仓库。

# ============ 上半部:实现层(Claude Code 用)============

## 职责(一句话)

接收客户 PCB 资料包(Gerber/Excellon + 制作要求附件),驱动 pcb-worker 按工厂标准逐 stage 执行 CAM 检查/制作,把需要人判断的点(层识别、审单结果、EQ 问题)停下来给工程师确认,最后交付成果物(钻带、审核版 Gerber、MI 流程单、EQ/DFM 报告、Genesis 脚本草稿)。

## 拥有的实体(写权限唯一归本模块)

PcbCamProject(项目=一个客户订单)、PcbCamJob(一次完整 CAM 运行)、PcbCamStageRun(job 内某 stage 的一次执行 + 报告)、PcbCamEqItem(需人决策的问题点)、PcbCamArtifact(成果物文件索引)、PcbCamFactoryProfile(工厂标准,YAML)

## 只读依赖(其他模块拥有,本模块只读)

- Employee(core/org):操作人展示;数据权限走 `getDataScope`
- core/storage:`putObject / readObject`,私有下载走 `/api/files/<key>?t=`
- core/llm:场景 `pcb_cam`(附件→规格候选、层名兜底、EQ/MI 文案);`vision.describeImage` 读图片附件
- core/scheduler:`registerJob` 驱动 pipeline 推进

## 核心流程

1. **建项目 + 上传**:`POST /projects` → `POST /jobs`(multipart,多文件:zip/7z/rar + PDF/Excel/图片)→ `checkUpload` → `putObject('pcb-cam/<tenant>/<job>/input/…')` → job `pending`
2. **推进(scheduler `pcb-cam:advance`,10s)**:取 `running` 且当前 stage 无 `running` 的 stage_run 的 job,按 pipeline 顺序创建 stage_run(`running`),`fetch pcb-worker POST /jobs/{id}/stages/{stage}`(超时按 stage 配,默认 120s),落 `StageReport` 到 stage_run.report;按报告 status 决定 job 下一状态
3. **停等点**(job → `needs_review`):
   - intake 后:工程师在「层识别确认」页改/确认 layer_map → `POST /jobs/:id/layers/confirm` → 回 `running`
   - order_spec:LLM 候选写 `order_spec_candidate`,工程师确认后写 `order_spec`(见不变量 4)
   - 任一 stage 报告含 `eq_question` 或 `severity=error` 且 `auto_fixable=false` → 生成 EqItem,全部 `pending` 决策完(accept_fix / ignore / manual / ask_customer)才 `POST /jobs/:id/eq/submit` 回 `running`
4. **阻断**(job → `blocked`):net_compare 开短路、gatekeeper 回读不一致、worker 失败超重试 → 只能人工 `retry_stage` 或 `cancel`；B 线 native 默认生成候选终稿，但 profile 的 `release.mode: review` 会让 gatekeeper 进入 `needs_review`，只有样板已验证的 `certified` profile 才能自动放行
5. **交付**:output stage 产物落 artifacts,`GET /jobs/:id/artifacts` 列出,下载走私有文件票据;job `done`
6. **工厂标准**:`pcb-cam:config` 权限管理 FactoryProfile(YAML 文本 + schema_version),job 创建时快照 profile 内容到 job(`profile_snapshot`),运行期不再读 profile 表

## 数据模型(全部 spread `commonFields`;状态 text + CHECK)

| 表 | 关键字段 | 说明 |
|---|---|---|
| `pcb_cam_projects` | name, customer_name, factory_profile_id(uuid, nullable), status(active/archived) | 一个客户订单 |
| `pcb_cam_jobs` | project_id, status(**pending/running/needs_review/blocked/done/failed/cancelled**), current_stage(text), review_reason(text), input_keys(jsonb string[]), layer_map(jsonb), layer_map_confirmed_at, order_spec_candidate(jsonb), order_spec(jsonb), profile_snapshot(jsonb), worker_job_id(text), version(integer, 乐观锁) | 一次运行 |
| `pcb_cam_stage_runs` | job_id, stage(text, 见 STAGES), attempt(integer), status(running/ok/needs_review/blocked/failed), report(jsonb StageReport), started_at, finished_at, duration_ms, error_message | 一次 stage 执行 |
| `pcb_cam_eq_items` | job_id, stage_run_id, item_id(text, 来自报告), severity, message, suggested_fix(jsonb), decision(**pending/accept_fix/ignore/manual/ask_customer**), decided_by, decided_at, note | 人决策点 |
| `pcb_cam_artifacts` | job_id, stage_run_id, kind(drill/gerber_review/ipc356/mi_sheet/stackup_svg/eq_report/dfm_report/genesis_script/preview_svg/archive), storage_key, filename, size, content_type | 成果物 |
| `pcb_cam_factory_profiles` | name, yaml(text), schema_version(text), is_default(boolean) | 工厂标准 |

索引:jobs(tenant_id, status, updated_at);stage_runs(job_id, stage, attempt) 唯一;eq_items(job_id, decision);artifacts(job_id, kind)。
`STAGES = ['intake','order_spec','align','drill','inner','outer','mask','silk','net_compare','panel','output','gatekeeper']`(顺序即 pipeline 顺序)。

## 关键不变量(AI 改动时绝不能破坏)

1. **stage 顺序单调**:同一 job 的 stage_runs 按 STAGES 顺序推进;不存在「后一 stage 有 ok 记录而前一 stage 无 ok 记录」;同一 (job, stage) 同时最多一条 `running`
2. **停等必须由人解锁**:job 处于 `needs_review` / `blocked` 时 scheduler 不推进;从 `needs_review` 回 `running` 只有三条路:layers/confirm、order_spec/confirm、eq/submit(且此时该 job 无 `pending` 的 eq_items)
3. **推进幂等**:scheduler 重入/多实例同时跑不会为同一 (job, stage, attempt) 发起两次 worker 调用 —— 靠 `UPDATE … WHERE status='running' AND version=?` 乐观锁 + stage_runs 唯一索引兜底
4. **LLM 不直接成为事实**:`order_spec_candidate`(LLM 写)与 `order_spec`(人确认写)分离;pipeline 只读 `order_spec`;layer_map 同理,`layer_map_confirmed_at` 为空时 align 及之后 stage 不得执行
5. **产物租户隔离**:所有 storage_key 前缀 `pcb-cam/<tenant_id>/<job_id>/`;下载接口先 `scope` 校验 job 归属再签票据
6. **外部调用有界**:worker 调用必带超时;失败落 stage_run `failed` + error_message(不含堆栈),重试上限 2 次后 job `failed`;不吞异常
7. **profile 快照**:job 运行期参数只来自 `profile_snapshot`,改 factory_profiles 不影响已创建 job
8. **禁物理 DELETE**:job/artifact 只软删;取消是状态 `cancelled`

> 每条不变量在 `tests/pcb-cam.test.ts` 有对应断言(worker 用 `worker-client` 的 fake 实现)。

## 接口契约

**HTTP(`/api/pcb-cam`,全部在 requireAuth 之后)**

| 方法 路径 | 权限 | 说明 |
|---|---|---|
| GET /projects | view | 游标分页,默认 20 上限 50 |
| POST /projects | operate | 建项目 |
| POST /projects/:id/jobs | operate | multipart 上传 + 建 job(幂等键:客户端传 `Idempotency-Key`) |
| GET /jobs/:id | view | job + 最新各 stage_run 摘要 + eq 统计 |
| GET /jobs/:id/events | view | SSE:stage 状态变化(轮询 DB 3s 推送,15s 心跳) |
| GET /jobs/:id/layers | view | layer_map(含置信度、识别依据) |
| POST /jobs/:id/layers/confirm | operate | 写 layer_map + confirmed_at,job 回 running |
| POST /jobs/:id/order-spec/confirm | operate | candidate → order_spec |
| GET /jobs/:id/stages/:stage/report | view | StageReport 全文 |
| GET /jobs/:id/layers/:layer.svg | view | 代理 worker 的 SVG(缓存到 storage) |
| GET /jobs/:id/eq | view | eq_items |
| POST /jobs/:id/eq/:itemId/decide | approve | 单条决策 |
| POST /jobs/:id/eq/submit | approve | 校验无 pending 后回 running |
| POST /jobs/:id/stages/:stage/retry | approve | blocked/failed 重跑(attempt+1) |
| POST /jobs/:id/cancel | approve | |
| GET /jobs/:id/artifacts | view | 列表(带下载票据 URL) |
| GET /jobs/:id/artifacts.zip?group=deliverables\|all | view | 一键打包(服务端 zip,按类型分目录;默认只打交付物) |
| GET/POST/PUT /factory-profiles | config | YAML 管理 |

**pcb-worker(内部,`PCB_WORKER_URL`,默认 `http://pcb-worker:8000`)**

- `GET /health`
- `POST /jobs/{job_id}/stages/{stage}` body:`{input_keys, layer_map, order_spec, profile: yaml, prior_reports: {...}}`(worker 通过共享卷/storage 读文件)→ `StageReport`(schema 在 pcb 仓 `engine/model/report.py`,本模块 `worker-types.ts` 手写同构 type + zod,契约测试双向对齐)
- `GET /jobs/{job_id}/layers/{layer}.svg`

**op 词汇表(CAM 操作名)**:唯一定义在 pcb 仓 `engine/adapters/base.py` 的 `CamOp`(38 个,每个带章节/页码/所属 stage/lite 状态),菜单路径与 COM 草稿在 pcb 仓 `docs/genesis_op_mapping.md`,`tests/test_cam_ops.py` 保证两者一致。本模块只透传:`ReportItem.fix.op` 是 `CamOp` 的值,UI 按它显示「需 Genesis 做什么」;本模块**不得**自造 op 名。

**权限码(`permissions.ts`)**:`pcb-cam:menu`(菜单)、`pcb-cam:view`、`pcb-cam:operate`(上传/确认层/确认规格)、`pcb-cam:approve`(EQ 决策/重跑/取消/放行)、`pcb-cam:config`(工厂标准)。前端菜单级 + 按钮级两层门控。

**错误码(补进 `core/http/errors.ts`)**:`PCB_JOB_NOT_FOUND 404`、`PCB_INVALID_STATE 409`、`PCB_EQ_PENDING 409`、`PCB_LAYERS_UNCONFIRMED 409`、`PCB_WORKER_UNAVAILABLE 503`、`PCB_UPLOAD_INVALID 422`、`PCB_PROFILE_INVALID 422`

## 关键权衡

- **为什么不在 Node 里做几何**:没有成熟的 Gerber/Excellon + 几何库;Python gerbonara+shapely 是唯一活跃选择。已获 yibing 批准作为「技术栈已定」的例外,以独立 service 隔离
- **为什么 scheduler 轮询而不是 worker 回调**:与平台其他长任务(core/backup)一致;worker 保持无状态、不需要知道 AIOS 鉴权;代价是最多 10s 延迟,可接受
- **为什么 SSE 而不是前端轮询**:stage 时间线要即时;实现按 askai 的 `streamSSE + 心跳`,后端仍是轮询 DB,不引入新基建
- **为什么 profile 快照**:CAM 结果必须可复现;工厂改标准不能改变历史 job 的判定
- **LLM 只出候选**:附件里的数值(钻孔表、板厚)幻觉风险高,worker 会把候选与 Excellon 实测比对,不一致出 EQ;人确认后才成事实

## 对外接口(其他模块只能用这些)

- 暂无。`agent-catalog` 里登记为 `NOT_EXPOSED`(理由:CAM 操作需工程师逐步确认,不适合数字员工无人值守调用;M4 后视情况开放只读查询)

## 常见改动入口

- 加/删 stage → `stages.ts` 的 `STAGES` + worker 同步 + 迁移改 CHECK
- 改停等规则(哪些报告项要人看)→ `logic.ts` 的 `deriveJobStatusFromReport`
- 改 worker 超时/重试 → `worker-client.ts` 顶部常量
- 加成果物类型 → `model.ts` kind CHECK + `ui/JobDetail.vue` 下载列表
- 改 EQ 决策类型 → `model.ts` decision CHECK + `ui/EqReview.vue`
- 换 LLM 场景/提示词 → `llm.ts`;场景 key 在 `core/llm/scenes.ts`
- MI 流程单模板 → `mi/flows.ts`(按板型枚举工序链,数据源 pcb 仓 `knowledge/rules/mi_flow_templates.yaml`)

## 注册清单(实现时逐项打勾)

- [ ] `core/http/app.ts`:PERMISSIONS 进 ALL_PERMISSION_DEFS;`.route('/api/pcb-cam', …)` 在 requireAuth 之后
- [ ] `core/http/errors.ts` CODE_STATUS
- [ ] `core/db/migrations/NNNN_pcb_cam.sql` + `meta/_journal.json`
- [ ] `src/nav-catalog.ts` 单行条目
- [ ] `src/App.vue` SectionKey / lazyPage / NAV_ICONS / 模板分支
- [ ] `src/api/client.ts` DTO + apiPcbCam*
- [ ] `core/agent-catalog/registry.ts` NOT_EXPOSED
- [ ] `server.ts` registerPcbCamJobs()
- [ ] `core/llm/scenes.ts` 加 `pcb_cam`
- [ ] `docker-compose.yml` pcb-worker + `.env.docker.example` PCB_WORKER_URL
- [ ] `seed/` 演示项目;`modules/user-guide/manifest.ts` 章节

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事

CAM、工程资料、审单、做资料、gerber、钻带、MI、流程单、EQ、问客、拼板、开料、Genesis

## 业务概念词典(客户大白话 → 系统位置)

| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「客户发来一包资料,先看看能不能做」 | 审单:解析 Gerber + 读制作要求 + 与工厂制程能力比对 | 新建项目 → 上传 → 层确认 → 审单结果 | 轻 |
| 「这个孔到底是金属化还是非金属化」 | 钻孔属性判定 + 与分孔图核对 | 钻孔 stage 报告 / EQ | 轻 |
| 「问客户」 | EQ(Engineering Question)问题点 | EQ 页 → ask_customer → 导出 EQ 报告 | 轻 |
| 「出流程单」 | MI 工艺流程单(按板型自动排工序) | 成果物 → mi_sheet | 轻 |
| 「资料做好了没」 | job 状态 done 且 gatekeeper 通过 | 任务详情 stage 时间线 | — |
| 「我们厂的规矩不一样」 | 工厂标准 profile(预大、最小线宽、命名、拼板参数) | 工厂标准配置页 | 轻(改数值)/中(加新规则类型) |
| 「拼板怎么拼」 | 拼板方案(个数/利用率/工艺边) | panel stage 报告 + 预览 | 中 |
| 「直接出生产文件」 | 需要 Genesis 执行器接入(M5 进场后) | GenesisAdapter | 重 |

## 可调旋钮清单(这个模块天生能改什么)

□ 预大量 / 最小线宽线距 / 令环 / 阻焊桥 / 字符尺寸等阈值(轻 · 工厂标准 YAML)
□ 层命名规则与输出文件名(轻 · 工厂标准 YAML)
□ 哪些报告项要停下来人看(中 · logic.ts 规则)
□ EQ 报告模板与话术(轻 · llm.ts 提示词)
□ MI 流程单板型→工序链(轻 · mi/flows.ts 数据)
□ 拼板 panel 尺寸/工艺边/阻流块(轻 · YAML)
□ 接入工厂 Genesis 自动执行修复(重 · 需进场调脚本)

## 聊需求时要主动追问的点(引导客户说清楚)

- 客户资料主要是 Gerber 还是 ODB++/源文件?→ 决定是否要做转换环节(demo 只收 Gerber)
- 工厂有没有现成的制程能力表和 MI 规范?→ 决定 profile 是抄还是从头整理
- 工程师希望哪些环节全自动、哪些必须人看?→ 决定停等规则
- Genesis 是哪个版本、能不能给脚本接口?→ 决定 M5 能不能做自动修复
- 内网能不能访问大模型?→ 决定审单是 AI 读附件还是人工填表

## 改动代价速查(聊的时候管理客户预期)

- 轻(配置级):阈值、命名、流程单模板、EQ 话术、拼板参数
- 中(加流程节点/规则):新增检查项、新增停等点、新增成果物类型、新板型流程
- 重(动模型/外部系统):接 Genesis 执行器、ODB++ 输入、多工厂租户隔离策略、自动修复几何
