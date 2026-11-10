# 模块:core/llm(平台级 LLM 基础设施 —— 场景模型路由、密钥、兜底、思考开关)

# ============ 上半部:实现层 ============

## 职责(一句话)
平台级 LLM 基础设施:每租户维护「主模型 + 各场景模型覆盖 + 各自备用模型 + 各供应商加密 key」,
所有业务模块的 AI 能力都从这里按场景解析出生效模型 + 自动兜底,不各自读 env、不各自配置。

## 核心概念
- **主模型(default)**:全系统 AI 的默认模型。存 `llm_configs`(provider/model + fallback_provider/fallback_model)。
- **供应商注册表(providers.ts)**:`sixam`(SixAM 智能云,自营中转,**默认供应商**)/ `bailian` / `ark` /
  `deepseek` / `hunyuan`,全部 OpenAI 兼容。env 兜底:`LLM_PROVIDER`/`LLM_MODEL`(兼容旧 `FEEDBACK_*`)。
- **出口改写(transport.ts)**:`registerLLMTransport` 注册器 —— ai-gateway 启动时把「走统一网关」注册进来,
  不注册就直连各家(core 不 import modules,方向约束)。
- **场景(scene)**:每个 AI 消费者一个 key(见 `scenes.ts` 的 `LLM_SCENES`:销售助理/合同生成/图片识别/向量化…)。
  每场景可在 `llm_scene_configs` 里**字段级覆盖** provider/model + 各自备用;**留空即继承主模型**。
  - `capability`:`chat` 未配 → 继承主 model;`vision`/`embedding` 未配 → 用 `defaultByProvider` 的能力默认模型
    (原来散在 knowledge/vision、knowledge/embed 的硬编码模型已集中到此),**不会**误用文本主模型。
- **备用模型(兜底)**:每个槽(主模型/场景)可配备用。主选返回**可重试**错误(429/5xx/超时,见 `classifyLLMError`)
  或未配置 key 时,自动切备用再试一次;确定性错误(400/401)不切,直接暴露。★vision/embedding **不继承**主模型的
  chat 备用(能力不符),只认场景自配的备用。

## 关键接口(core/llm/api.ts)
- `buildTenantLLMCaller(db, ctx, scene='default')` → 带兜底的 `LLMCaller`(内部 `makeResilientCaller`)。
- `resolveLLMRuntimeConfig(db, ctx, scene='default')` → 主选运行时配置(自建 OpenAI 的模块用;签名向后兼容)。
- `resolveLLMRuntimeConfigWithFallback(db, ctx, scene)` + `runWithLLMFallback(configs, run)` → 自建调用也能兜底
  (crm-assistant / knowledge-vision / knowledge-embed 用)。
- `scene` 一律默认 `'default'`,老调用方不传也照常用主模型。
- 配置读写:`getConfig`/`updateConfig`(主模型+备用)/`upsertSceneConfig`/`deleteSceneConfig`;路由 `core/llm/routes.ts`。
- `listEffectiveRoutes(db, ctx)` → 每个场景**实际生效**的模型(智能体管理页「模型接入」用)。
- 用量流水(usage.ts):`recordUsage`/`usageByScene`/`usageByDay` —— 埋点整段吞错不影响业务,不记 prompt/response 正文。
- `describeImage`(vision.ts):图片 → 文字的旁路转录;`wrapUntrusted`(untrusted.ts):外部可写文本进提示词的统一围栏。
- 计费代理(billing.ts):SixAM 智能云账户余额/用量/月对账单/资金台账,`/api/llm/billing/*` 只读实时代理,不落库不缓存。

## 关键不变量
1. 密钥红线:AES-256-GCM 加密入库,明文永不返回;库内优先、env 兜底。
2. 场景解析纯字段级 coalesce over 主模型,可预测;未知/`default` 场景 = 主模型。
3. 兜底只在「可重试」错误时切,不浪费在确定性错误上;备用与主选完全相同则视为无备用。
4. 数据/超时:单次尝试封 45s 超时 + maxRetries:0(SDK 默认 10 分钟 + 自动重试是隐患;
   备用切换与退避重试是本机制显式行为,非 SDK 自动重试)。
5. **深度思考默认关,且必须显式下发**:方舟 doubao-seed 系列是混合推理模型,`thinking` 默认 auto=**开着**,
   交互式场景实测慢 10–50 倍(销售助理 234s vs 4.3s;端到端开着会 90.3s 撞穿 deadline 报「调用失败」)
   且不提升正确性。故所有 chat 调用点一律过 `thinking.ts` 的 `withThinking`,按该场景生效开关下发
   `enabled`/`disabled`,**不依赖模型默认**。开关三态继承同不变量 2(场景 null → 主模型)。
   方舟允许填**接入点 ID**(`ep-xxxx`),模型名读不出能力,故不做白名单——一律下发,回 400 且报错提到
   thinking 才脱掉重试一次并在进程内记住。

## 突发流量削峰 + 退避重试(throttle.ts,治 429/request too fast)
- **仅火山方舟(ark)** 走削峰:进程内并发信号量 + 最小调用间隔(env `ARK_MAX_CONCURRENCY`/`ARK_MIN_INTERVAL_MS`,按 apiKey 指纹分桶),平滑上游突发限流。
- **全供应商**退避重试:可重试错误按指数退避 + jitter,优先遵循响应 `Retry-After`;包住 caller/embed/vision/crm-llm 四类调用点,embed/vision 补了超时。
- ★主选→备用**共享同一 deadline**:切换兜底不重置总预算,防 55s+55s 叠加超 nginx 60s 反代超时。

## 常见改动入口
- 加 AI 场景 → `scenes.ts` 加一条 `LLM_SCENES`(vision/embedding 类给 `defaultByProvider`)+ 消费者调用传该 scene key。
  - ★**消费者是自托管 agent(dsh)的话,那一条必须带 `viaAgentHost: true`。** 判据不是「重不重要」,
    是「这个场景走不走 `caller.ts`」—— 走 dsh 的模型名在 spawn 时烤进 cordis profile,由 dsh 自己去调网关,
    我们的调用层一次都不执行,于是那里的「网关上没这条路由 → 退到主模型」**够不着它**。
    不标的后果:网关上没规则时每轮 400,而页面把它显示成「配了主模型就能用」。
    `modules/ai-gateway/tests/logic.test.ts` 有两条双向护栏(漏标、乱标各一条)。
- 某场景确实需要推理(如审批预审/商机晨检)→ 别改代码,去「系统设置 → AI 大模型」把该场景的「深度思考」调成「开启」。
- 加供应商 → `providers.ts`(须 OpenAI 兼容)。
- 调削峰参数 → env `ARK_MAX_CONCURRENCY` / `ARK_MIN_INTERVAL_MS`(见 `.env.example`);其它供应商要限流时在 `throttle.ts` 扩 provider 分桶。

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事

AI、大模型、换个模型、接豆包/通义/DeepSeek、AI 的 key、模型密钥、AI 不回话了、AI 报错没配置

## 业务概念词典

| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「换成豆包/通义/DeepSeek」 | 切换当前生效的 AI 供应商 | 系统设置 → AI 大模型 tab | 轻 |
| 「用更强/更便宜的模型」 | 模型代号可直接填(如 qwen-max / deepseek-reasoner / 方舟接入点) | 系统设置 → AI 大模型 | 轻 |
| 「图片识别/向量化用别的模型」「销售助理单独用更强模型」 | 某场景单独指定模型(留空继承主模型) | 系统设置 → AI 大模型 → 场景模型 | 轻 |
| 「主模型挂了自动换备用」「429 太多加个兜底」 | 给主模型/某场景配备用模型,异常自动切 | 系统设置 → AI 大模型 → 备用模型 | 轻 |
| 「填 AI 的 key」 | 各供应商 API Key 加密入库(明文只进不出,页面只显示"已保存") | 系统设置 → AI 大模型 | 轻 |
| 「AI 助手说没配置」 | 未填 key 且服务器环境变量也没配;只影响 AI 功能,不影响其他 | 系统设置 → AI 大模型 | 轻 |
| 「AI 反应太慢」「让 AI 想深一点再答」 | 深度思考开关(默认关,开着交互场景会慢 10–50 倍);按主模型或按场景开 | 系统设置 → AI 大模型 → 深度思考 | 轻 |
| 「AI 用了多少钱 / 余额还剩多少 / 要对账单」 | SixAM 智能云账户:余额、充值记录、按日用量、月对账单(可导 CSV),实时取自中转站 | 系统设置 → AI 大模型 → 智能云账户 | 轻 |
| 「接一个新的 AI 平台」 | 供应商注册表加一条(须 OpenAI 兼容协议) | providers.ts | 中 |

## 可调旋钮清单

□ 供应商切换(轻 · 现有:SixAM 智能云(自营中转,默认)/ 阿里百炼(通义千问)/ 火山方舟(豆包)/ 深度求索 DeepSeek / 腾讯混元)
□ 模型代号(轻 · 自由填写,留空用供应商默认)
□ 场景模型覆盖 + 各自备用模型(轻 · 留空继承主模型)
□ 深度思考开关(轻 · 默认关;主模型总开关 + 场景三态覆盖,某场景要推理就在这里开)
□ 各供应商 API Key(轻 · 加密存库,可清除后回退服务器环境变量)
□ 新增 OpenAI 兼容供应商(中);接非 OpenAI 协议的平台(重)

## 本模块约定与边界

- **★平台统一口径**:全系统所有 AI 能力(需求助手、CRM 智能助手、线索 AI、合同 AI、邮件线索抽取、知识库向量/图片识别等)统一走这里的租户级配置(buildTenantLLMCaller / resolveLLMRuntimeConfig)拿供应商/模型/密钥——各模块不自设 AI 配置、不各自读环境变量。改一处,全系统 AI 生效。
- **密钥红线**:key 用 AES-256-GCM 加密入库,明文永不返回;库内 key 优先,服务器环境变量兜底;未配齐只在调用时报清晰错误,不影响启动。
- **与需求助手(feedback)的关系**:LLM 配置历史上在需求配置页,已整体迁到「系统设置 → AI 大模型」(core/llm 是现行唯一口径,feedback 仅兼容再导出);「需求配置」页只剩 DevTool 密钥等自己的配置。
- **网关模式下「AI 大模型」页的模型配置不生效**:服务器配了 `TB_*` 时,模型路由在
  「系统管理 → AI 网关 → 场景路由」改;设置页会把不生效的输入**锁上**(可手动解锁提前配,
  作为撤网关后的兜底)—— 两处编辑面共用 `core/ui-kit/ModelRoutingNotice.vue` 那一份说法(2026-08-22 线上教训)。
- 配置读写需系统设置管理权限(app-settings:manage),无独立菜单。
