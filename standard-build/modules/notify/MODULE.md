# 模块:notify(通知渠道)

# ============ 上半部:实现层(实现 agent 用)============

## 职责(一句话)
系统底座的通知能力:在系统管理里配置通知渠道(邮件 SMTP + 飞书群自定义机器人 webhook),并对外提供发信入口供业务模块调用。

## 拥有的实体
NotifyChannelConfig —— `model.ts`(每租户每渠道一行;渠道 = email / feishu,结构预留多渠道)

## 只读依赖
- org:`requirePermission`/权限点;audit:写操作自动留痕(中间件)
- 无业务模块依赖(底座能力,被别的模块单向调用)

## 实现落点
| 内容 | 文件 |
|---|---|
| notify_channel_configs 表 + EmailConfig/FeishuConfig 结构 | `model.ts` |
| 配置 JSON 对称加密(AES-256-GCM) | `crypto.ts` |
| SMTP 发信(nodemailer,有超时) | `email.ts` |
| 飞书群机器人 webhook 发信(fetch+超时,可加签) | `feishu.ts` |
| 配置读写 + 测试发信 + 对外 notifyByEmail/notifyByFeishu | `logic.ts` |
| 对外接口(其它模块只从这引) | `api.ts` |
| HTTP 路由 | `routes.ts` |
| 配置页(邮件 SMTP + 飞书群机器人 + 「企业IM主机器人」tab:只读 im-connect 三平台状态、控制各平台是否作为通知渠道启用 —— 开关写的是 im-connect 的平台 enabled,按钮/查询都以 `im-connect:config` 门控) | `ui/NotifyConfig.vue` |

## 关键不变量(有测试)
1. ★密钥红线:SMTP 密码等敏感配置明文绝不进库/代码。整份配置 JSON 经 AES-256-GCM 加密存 `config_enc`,
   加密主密钥走 env(`CONFIG_ENC_KEY` 或 `AUTH_SECRET`),不进库不进代码。DTO 只回 `passSet` 布尔,永不回明文密码。
2. 每租户每渠道唯一(`(tenant_id, channel_type)` where not deleted 唯一约束)+ 租户隔离 + 软删除。
3. 对外发送入口 `notifyByEmail`:渠道未配置/未启用时静默跳过(返回 false),不阻断业务主流程;
   真正发送失败才抛 `NotifyError('SEND_FAILED')`。外部调用必须带超时(10s)。
4. 错误 message 不含凭证/堆栈;SMTP 明细只进日志。

## 对外接口(api.ts)
邮件:`getEmailConfig / saveEmailConfig / sendTestEmail / notifyByEmail`
飞书:`getFeishuConfig / saveFeishuConfig / sendTestFeishu / notifyByFeishu`;`SECRET_PLACEHOLDER`

> 飞书走「群自定义机器人 webhook」:base 直接 POST 卡片到群,不依赖 getdeployed。webhook 地址本身即凭证(加密入库,
> DTO 只回 `webhookSet`+末 6 位 `webhookHint`),可选「加签」密钥(HMAC-SHA256)。`notifyByFeishu(db, ctx, { title, text, templateColor })`。
> 超级个体工作流(`modules/superindividual` syncAgentRun)跑完会 best-effort 推一张卡片到群。

## 配置(env)
- `CONFIG_ENC_KEY` 或 `AUTH_SECRET`:加密主密钥(缺失则无法保存邮件密码,配置页会提示)
- 邮件账号本身在「系统管理 → 通知配置」页面里配置入库,不走 env

## 常见改动入口
- 加新渠道(短信/钉钉等)→ 放开 `model.ts` 的 `NOTIFY_CHANNELS` 与 CHECK 约束(加迁移),加对应 logic/routes/UI
- 业务模块要发邮件 → 调 `api.ts` 的 `notifyByEmail(db, ctx, { to, subject, text/html })`
- 业务模块要推飞书群 → 调 `api.ts` 的 `notifyByFeishu(db, ctx, { title, text, templateColor })`

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事
通知、提醒、消息、发邮件、收到邮件、推到飞书群、群机器人、系统通知我、有动静告诉我、推送

## 这个系统现在能做什么(★重要:回答用户"能不能通知我"时直接据此回复)
- **邮件通知:已上线。** 配置入口:「系统管理 → 通知配置」,填 SMTP 主机/端口/账号密码即可启用,配好后页面上可"发送测试邮件"验证。
  兼容任意邮件服务商(飞书企业邮/腾讯企业邮/自建 Exchange、Postfix 均可)。
- **飞书群通知:已上线(群自定义机器人 webhook)。** 在飞书群加「自定义机器人」拿到 webhook 地址,填到「通知配置 → 飞书群机器人」(可选加签密钥)→ 启用 → 发测试消息验证。
  注意:这是「往群里发消息」;要「在飞书/钉钉/企业微信里和 AI 对话、私聊收系统通知」是另一处能力(im-connect 智能体接入),不在本模块。
- **已自动接好的通知事件(配好渠道即生效,不用再提需求):**
  - 审批(合同/报销/请假等所有走审批流的单据):轮到某人审批时给审批人发邮件;通过/驳回后给提交人发结果邮件;终审通过后抄送人知会(邮件,飞书群也发一张卡片)。
  - 智能体工作流跑完:自动推一张结果卡片到已配置的飞书群。
  - CRM 跟进催填「群点名」:催促档开了群点名时,把当天没填跟进的销售点名到已配置的飞书群(crm-dashboard 模块接线)。
- 密码/webhook 等凭证加密入库,页面永不回显明文,只显示"已设置"。

## 业务概念词典
| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「能不能邮件通知我」 | 邮件通知能力 | 已上线 → 系统管理→通知配置 | 已具备(直接告知用法) |
| 「配一下发邮件的账号」 | SMTP 配置 | 通知配置页(可测试发信) | 轻 |
| 「用飞书通知 / 推到飞书群」 | 飞书群机器人渠道 | 已上线 → 通知配置→飞书群机器人 | 已具备(配 webhook 即用) |
| 「审批轮到我/批完了要通知」 | 审批事件邮件通知 | 已接线,配好邮件渠道即自动生效 | 已具备 |
| 「XX 业务事件发生时通知我」 | 新业务事件触发发信 | 在对应业务模块接线 notifyByEmail/notifyByFeishu | 中 |
| 「发短信」 | 短信渠道 | 暂未上线 | 中 |
| 「钉钉/企业微信/飞书私聊里收系统通知」 | IM 私聊转发站内信 | 已具备,走 im-connect(智能体接入,站内信自动转发到个人 IM),不是本模块的群机器人渠道 | 已具备(去 im-connect 配) |
| 「钉钉群机器人通知」 | 新群渠道 | 暂未上线(本模块群渠道只有飞书) | 中 |

## 可调旋钮清单
□ 邮件渠道启用/停用(轻 · 通知配置页开关)
□ SMTP 服务商/账号/发件人名称(轻 · 通知配置页)
□ 飞书群机器人 webhook 地址 + 加签密钥(轻 · 通知配置页)
□ 哪些业务事件触发通知(中 · 在对应业务模块接线,本模块只提供发送能力)
□ 新渠道:短信/钉钉等(中 · 加渠道类型+迁移+UI)

## 本模块约定与边界
- **本模块 = 外发渠道**:管「系统怎么把消息发出去」(邮件 SMTP、飞书群机器人)及「系统管理 → 通知配置」页。
- **站内铃铛不归这里**:顶栏铃铛/未读角标/站内消息列表是 inapp-notify 模块(无独立菜单,顶栏通知中心)。用户说"通知"要先分清:发到邮箱/飞书群=本模块;系统里铃铛提醒=站内通知。
- 渠道未配置/未启用时,业务发信静默跳过,绝不阻断业务主流程(如审批照常流转,只是没邮件)。
- 邮件账号在页面配置入库(加密),不走服务器环境变量。

## 聊需求时要主动追问的点
- 用户要的"通知"是否已被覆盖?邮件/飞书群/审批事件通知均已具备,直接告知用法,不当新需求。
- 要"某业务事件自动通知"→ 澄清是哪个事件、通知谁、走邮件还是飞书群还是站内铃铛。
- 要短信/钉钉 → 说明暂未上线,属新渠道开发。

## 改动代价速查
- 已具备:邮件通知、飞书群通知、审批事件邮件/抄送知会、CRM 催填群点名(均配置即用);IM 私聊收通知在 im-connect
- 轻:配 SMTP / 飞书 webhook、开关渠道
- 中:新业务事件接线自动发信、加新渠道(短信/钉钉)
