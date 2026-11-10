# 模块:inapp-notify(站内通知)

# ============ 上半部:实现层(实现 agent 用)============

## 职责(一句话)
站内通知能力:其他模块调写接口推通知给指定员工;员工在**顶栏铃铛**(最新 20 条)或**收件箱整页**查看与标已读;提供未读数轮询接口供角标使用。

★整页自 2026-08-15 起是**一页两区的「收件箱」**(菜单与底部 tab 都叫这个名):
上半区「需要你处理」由 `modules/attention` 提供(跨模块聚合队列,本模块只负责挂它并统一刷新),
下半区「知会」才是本模块的通知流(全量/翻页/筛未读)。设计见 `docs/design/ATTENTION_INBOX.md`。

## 拥有的实体(写权限唯一归本模块)
- `inapp_notifications`：通知条目(recipient_id / type / title / body / source_type / source_id / is_read / read_at)。
  `source_type + source_id` 记录来源单据,便于前端点击跳转到对应页面。

## 只读 / 协作依赖
本模块是被动基础设施,由其他模块主动调用写接口:
- `modules/feedback`:`sendInappNotify`(需求状态变更通知,source_type='feature_request')
- `modules/superindividual`(automation run 完成通知,source_type='automation_run')
- 此后调用方已遍布各业务模块(审批/线索/商机/合作伙伴/日程/考勤/CRM 督导/备份/AI 网关等),
  来源全集即 model.ts 的 14 种 `source_type`,不再逐家列
- 可扩展:任意模块引入 `inapp-notify/api.ts` 的 `createNotification` 写一条

## 实现落点
| 内容 | 文件 |
|---|---|
| 通知表 + 索引(recipient+is_read+created_at) | `model.ts` |
| 创建/列表/标已读/全部已读/未读数 | `logic.ts` |
| 对外写接口(供其他模块调) | `api.ts`(`createNotification` / `registerNotificationSink` / `resolveNotificationsBySource`) |
| HTTP 路由(铃铛与整页共用) | `routes.ts` |
| 铃铛面板(顶栏,最新 20 条) | `ui/NotificationBell.vue` |
| 收件箱整页(菜单「业务 → 收件箱」+ 手机底部 tab;两区 + 统一刷新 + 全部已读) | `ui/NotificationsPage.vue` |
| **点击后果表**(三档,两个视图 + 推送 sink 共用,别各写一份) | `notification-target.ts`(纯函数,server.ts 也 import) |
| 把结果转成 setNavContext + si:navigate | `ui/notification-link.ts` |
| 「知会」正文详情抽屉(markdown 渲染) | `ui/NotificationDetail.vue`(用 `core/ui-kit` 的 MarkdownView) |
| **时间显示**(同上) | `ui/notification-format.ts` |
| **推送自检**(同上) | `ui/PushSelfTest.vue` |

## 接口(HTTP,供铃铛前端使用)
- `GET /api/inapp-notify/count` — 当前用户未读数(铃铛角标轮询用)
- `GET /api/inapp-notify/` — 我的通知列表(游标分页,limit≤50);`unreadOnly=true` 只看未读
  - ★未读过滤**必须在 SQL 里**做:游标分页下「一页恰好全是已读」会让前端自筛的未读页显示成空,
    而下面其实还有未读。查询参数用 `z.enum(['true','false'])` 解析,**不能**用 `z.coerce.boolean()`
    —— `Boolean('false')` 是 `true`,表现为「切回全部」也只剩未读。
- `PATCH /api/inapp-notify/:id/read` — 标单条已读
- `PATCH /api/inapp-notify/read-all` — 全部标已读

## 对外写接口(供模块间调用,见 api.ts)
- `createNotification(db, input)` — 推一条站内通知给指定 recipient
- `registerNotificationSink(fn)` — 组合根注册外发出口,同步 fan-out 每条通知(server.ts 已接两路:im-connect 的 `notifyByIM` 私聊转发 + push 的 `pushToEmployee` 手机推送;未配置各自静默)
- `resolveNotificationsBySource(...)` — 来源单据状态变了、通知已失效时收口(标已读+改文案),免得假警报永远挂着

## 权限
本模块无独立权限点:通知推送由其他模块的写操作鉴权;读取仅需 requireAuth(已登录),不额外设权限。
导航项 `notifications` 因此进了 `core/org/nav-permission-guard.ts` 的 UNGATED_ALLOWLIST ——
后端按 `recipient_id = 当前登录者` 取数,任何人只可能看到发给自己的那些,「能不能看自己的通知」立不成权限码。

## 核心不变量
- 通知条目按 `(tenant_id, recipient_id, is_read, created_at)` 索引,查询高效;读取只返回本人通知(logic 层过滤 recipient_id=ctx.employeeId)。
- `is_read=false` 创建,标已读后置 `is_read=true` + `read_at=now()`,幂等(已读再标为 no-op)。
- `source_type` 现有 **14 种**(见 model.ts `INAPP_NOTIFY_SOURCE_TYPES`),**2026-08-21 起有库层 CHECK**
  (迁移 0295,`NOT VALID` —— 只约束新写入,不回扫存量:存量里可能留着早已废弃的类型,
  为一条护栏让迁移在客户机上炸掉不值得)。此前这一列是裸 `text NOT NULL`,于是没登记的类型
  照样写得进去 —— 客户移交通知的 `'partner'` 就是这么活成死链的(枚举、落点表、CHECK 三处都没有它,
  点了什么都不发生且全链路不报错)。
- **★点击后果分三档(2026-08-21)**,表在 `notification-target.ts`,铃铛与整页共用:
  | 档 | 含义 | 点击 | 谁 |
  |---|---|---|---|
  | `read` | **正文就是内容**(日报/周报/晨检/告警清单) | **不跳**:手机就地展开、桌面开抽屉,正文按 markdown 渲染 | key_opportunity · followup_nag · partner_conflict · db_backup · review_report · ai_budget |
  | `navigate` | 有落地页,但没有单条可定位 | 跳到那一屏 | attendance_alert · feature_request · automation_run |
  | `deeplink` | 能定位到具体单据 | 跳过去并打开它 | approval · lead · opportunity · calendar_event · partner |
  改之前只有「跳/不跳」两态,而「不跳」是靠**忘了写 case** 实现的 —— 于是两类坏死同时存在:
  正文即内容的通知被跳走(正文在列表里只显示 2–3 行,报告永远读不到),没登记的类型变成死链。
- **每一种 source_type 都要在 `notification-target.ts` 里有归属**(显式 `read` 也算),否则点了没反应且不报错;
  `tests/notification-link.test.ts` 会对这条对账(少配一种就变红)。落点页没权限时不跳,只标已读
  —— App.vue 的 `si:navigate` 只接受当前用户可见的菜单 key,不会把人带到打不开的页面。
- **别借用别的 source_type**。借用过两次,两次都造成错跳:AI 预审对账周报借 `approval` 且
  `sourceId` 传的是 tenantId(被当成审批实例 id 去开抽屉,查不到就静默落列表);AI 网关预算告警借
  `automation_run`(跳去工作流列表)。现在各有自己的 `review_report` / `ai_budget`,
  `tests/notification-link.test.ts` 扫源码钉住不许改回去。
- **推送落点**:`notificationPushSection()` 把 `read` 类换算成**收件箱页**(`notifications`,不挂权限)——
  这类推送点开要读的是正文本身,送到某张业务列表反而读不到它。

## 常见改动入口
- 新增 source_type → **三处都要改**:`model.ts` 的 `INAPP_NOTIFY_SOURCE_TYPES` + 表定义里的 CHECK
  + `notification-target.ts` 配点击后果 + **一条迁移**(照抄 0295 的写法改 CHECK 取值)。
  漏配落点会被 `tests/notification-link.test.ts` 拦下;漏改 CHECK 会在真库写入时炸(demo 的内存库也会)。
- 新增通知类型(type) → `model.ts` `INAPP_NOTIFY_TYPES` + CHECK(需迁移)
- 新模块推通知 → 在该模块引入 `api.ts` 的 `createNotification` 并在业务事件后调用

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事
站内消息、铃铛、小红点、消息提醒、未读提示、通知中心、系统里通知我

## 业务概念词典
| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「系统里有个铃铛提醒我」 | 站内通知能力 | 已上线 → 顶栏铃铛(未读角标 30 秒自动刷新,点开看列表/标已读/全部已读) | 已具备 |
| 「需求通过了发我个通知」 | 需求管理状态变更推站内通知 | 已接线(需求管理模块自动推) | 已具备 |
| 「自动化/工作流跑完告诉我」 | 智能体工作流完成推站内通知 | 已接线(企业智能体模块自动推) | 已具备 |
| 「领导批了合同在系统里提醒我」 | 审批事件推站内通知 | 已接线(source_type='approval') | 已具备 |
| 「点通知直接跳到那张单子」 | 通知带来源单据跳转 | 已具备(线索/商机还会直接打开那条的详情) | 已具备 |
| 「要有个通知中心能翻历史」 | 收件箱整页的「知会」区 + 翻页 + 只看未读 | 已上线(菜单「业务 → 收件箱」;手机底部第四个 tab) | 已具备 |
| 「通知要实时弹出来」 | WebSocket 实时推送 | 现为 30 秒轮询 | 重 |

## 可调旋钮清单
□ 铃铛未读数刷新频率(轻 · 前端轮询间隔,当前 30 秒)
□ 新业务事件推站内通知(中 · 在对应业务模块接线 createNotification + 扩来源类型迁移)
□ 按 type 分类筛选(轻 · 整页已有「全部/未读」,再加分类只是多一组按钮 + 一个查询参数)

## 聊需求时要主动追问的点

- 用户说「通知我」,先分清要落在哪层:系统内铃铛(本模块)/邮箱·飞书群(notify)/IM 私聊、手机横幅(站内信自动同步,分别是 im-connect 和 push 的出口)
- 要通知的业务事件是否已在 14 种来源里?在的话是已具备,直接告知在哪看,别当新需求收
- 「要实时弹出来」是秒级必须,还是半分钟内能接受?现为 30 秒轮询,秒级(WebSocket)是重改动

## 本模块约定与边界
- **本模块 = 站内消息**:顶栏铃铛(最新 20 条,随手扫一眼)+ 收件箱整页的「知会」区(全量/翻页/筛未读)。每条站内信还会由组合根 sink 自动同步外发:IM 私聊转发(im-connect)+ 手机推送(push),各自未配置时静默,不用另提需求。
- **整页底部不再有推送自检**:那两行只留在铃铛面板里(2026-08-15 按需求撤掉整页那份,别再加回来)。
  两个视图共用同一批数据与同一套落点/时间/自检代码 —— 新增行为要改共用文件,别只改一边。
- **发到系统外不归这里**:发邮件/推飞书群是 notify 模块(「系统管理 → 通知配置」页);IM 私聊是 im-connect;手机推送是 push。用户说"通知我"要先分清:系统内铃铛=本模块;邮箱/飞书群=通知配置;IM 私聊/手机横幅=站内信自动同步的出口。
- 通知只有本人能看到(按收件人隔离);已读/未读状态一人一份,可单条标已读或一键全部已读。
- 本模块是被动基础设施:哪个业务事件推通知,由该业务模块决定。现已接 14 种来源:审批、线索、商机、重点商机、跟进催填、考勤预警、日程提醒、合作伙伴(移交/冲突)、需求状态变更、智能体工作流完成、数据库备份告警、AI 预审对账周报、AI 网关预算告警。

## 改动代价速查
- 已具备:铃铛 + 整页(翻页/筛未读)+ 未读角标 + 已读管理;点击跳来源单据;需求/工作流/审批/线索/商机/考勤预警等事件自动推
- 轻:按 type 分类筛选
- 中:新事件接入(业务模块调 createNotification + 扩 source_type 迁移 + 配落点)
- 重:WebSocket 实时推送替代轮询
