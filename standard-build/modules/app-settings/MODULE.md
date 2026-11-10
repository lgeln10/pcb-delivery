# 模块:app-settings(系统设置)

# ============ 上半部:实现层(实现 agent 用)============

## 职责(一句话)
存储每租户一行的全局配置:品牌(系统名称 + 企业 Logo,替换左上角品牌区与标签页标题)+ **系统时区**
(全系统「几点发提醒 / 今天算哪一天」的唯一口径)+ **本公司开票信息**(AI 预审核对发票买方抬头的依据)。

## 拥有的实体(写权限唯一归本模块)
- `app_settings`：每租户唯一一行(软删过滤),存 `system_name`(系统名,空串回落默认)+ `logo_url`
  (null 表示用默认图标)+ `timezone`(IANA 名,迁移 0150,默认 `Asia/Shanghai`)+
  `invoice_title` / `invoice_tax_no`(开票抬头全称 + 税号,迁移 0210,均可空 = 不启用抬头核对)。

## 开票信息(跨模块契约)
- `getTenantInvoiceTitle(db, tenantId)`(经 `api.ts`)供 reimbursement / payment-voucher 提交侧
  的 AI 预审信号采集:发票买方**完整税号(≥15 位)不等 = 红**,抬头名称不符 = 黄;**两个字段都空
  = 规则不跑**,不产生任何误报。税号入库前统一大写 + 格式校验(15-20 位数字/大写字母)——
  配错税号会让每张票都标红,所以在保存入口就拦。

## 系统时区(★跨模块契约)
- **为什么不能用进程时区**:`date.getHours()` 读的是容器起在哪个时区(镜像默认 UTC)。「几点发提醒」
  是业务口径,必须按租户配置算 —— 否则配 9:00 会在北京时间 17:00 才发(本仓真踩过,靠 Dockerfile 钉
  `TZ=Asia/Shanghai` 只是权宜)。进程 TZ 现在只影响日志时间戳,不参与任何业务判定。
- **谁在用**:`getTenantTimezone(db, tenantId)` + 纯函数 `zonedHour / zonedDate / zonedMonth / zonedDateTime / zonedWeekday /
  zonedDayStart / zonedTimeToUtc / zonedWallClockToUtc`(见 `time.ts`,零依赖走 Intl),经 `api.ts` 供全系统有时间基准的模块用:
  crm-dashboard(填报催促/老板日报/商机晨检/关键商机通知的到点与按天幂等)、lead / opportunity(「下一步动作」默认 9 点)、
  crm-assistant(纯日期按当地零点解析、**带时分的相对时间按当地钟面解析** `zonedWallClockToUtc`),
  以及 attendance / calendar / payroll / hr-core / finance / contract / reimbursement / payment-voucher / visit-stats 等(以 `grep app-settings/api` 为准)。
- **「下一步动作时间」的默认时刻**:`next-time.ts` 是唯一定义(`withDefaultNextTime` + 两个默认常量),
  lead / opportunity / partner 三条写入路径共用。此前 lead 与 opportunity 各有一份逐字重复的实现、
  **partner 一份都没有** —— 客户跟进因此存的是当地零点。
- **跨租户任务的写法**:定时任务扫全库时**不能**在 SQL 里按小时/日期预筛(各租户当地时刻不同),
  只筛「已开启」,到点与否逐租户判;幂等标记(按天)也按各自当地日写。

## 实现落点
| 内容 | 文件 |
|---|---|
| 单表 + 唯一约束(tenant_id WHERE !is_deleted) | `model.ts` |
| 时区换算纯函数(Intl,含夏令时两趟修正) | `time.ts`(有单测 `tests/time.test.ts`) |
| 「下一步动作」默认时刻唯一定义 | `next-time.ts`(单测 `tests/next-time.test.ts`) |
| 护栏:扫「不按系统时区算时间基准」的写法 | `tz-guard.ts`(单测 `tests/tz-guard.test.ts`) |
| 对外只读接口(其它模块只从这引) | `api.ts`(`getTenantTimezone` + 换算函数) |
| 读 / upsert / Logo 上传 | `logic.ts` `getSettings` / `saveSettings` + `storage.ts` `storeLogo` |
| 「系统设置」页容器 + 各寄宿 tab 的挂载/门控 | `ui/AppSettings.vue`(各 tab 组件也放本目录 `ui/`,归属见下半部) |
| 路由 | `routes.ts` |
| 错误码 | `errors.ts` |
| 权限点 | `permissions.ts` |

## 接口
- `GET /api/app-settings/` — 无需额外权限(全员登录后读,前端壳层渲染品牌用)
- `PATCH /api/app-settings/` — `app-settings:manage` 守卫,保存系统名 + logo URL + `timezone` + 开票信息(`timezone`/`invoiceTitle`/`invoiceTaxNo` 可不传 = 不动现值)
- `POST /api/app-settings/logo` — `app-settings:manage` 守卫,上传 Logo 文件(存本地 /uploads),返回可访问 URL

## 权限
- `app-settings:manage`：配置系统名称/Logo/系统时区/开票信息(对应系统管理→「系统设置」页;页内 AI 大模型、文件存储两个寄宿 tab 也认这个码)。GET 读接口全员可用,不设专门权限。

## Logo 存储
- 文件走平台 `core/storage`,key 前缀 `branding/`,`visibility:'public'`(登录页未登录就要显示 logo,走不了票据)。
- 只允许 png/jpg/jpeg/webp/gif/svg,大小上限 2 MB(`assertAllowedLogo`)。
- ★类型判定看**内容**不看声明:`assertAllowedLogo(bytes, filename, size)` 内部走 `core/storage` 的
  `checkUpload`(扩展名在册 ∧ 内容与扩展名相符),返回归一后的 `contentType` 供落库。
  原实现是 `ALLOWED_LOGO_TYPES.includes(file.type)` —— `file.type` 客户端说了算、扩展名根本不看,
  而 logo 落的是公开直链:声明 image/png 传一份 .html 上来就得到一条同源免登录的 HTML 地址(2026-08-15 修)。
  svg 仍放行(logo 多为矢量图),安全性由出站的 `nosniff` + `Content-Security-Policy: sandbox` 保证。

## 核心不变量
- 每租户最多一行(软删部分唯一索引兜底),upsert 写法防重复行。
- **时区只接受运行时认得的 IANA 名**(`isValidTimezone`,保存即校验;`GMT+8`/`北京时间` 一律拒)——
  写坏了所有定时提醒的「几点」都会错且极难自查。读取侧(`getTenantTimezone`)再兜一层:值坏/无行
  一律回落 `Asia/Shanghai`,绝不让判定崩在一个不认识的时区上。
- **默认时刻只在「没说时分」时出场**:判定 = 该时刻正好是租户时区的当天零点;用户明确给的钟点
  一律原样保留。改默认值改 `next-time.ts` 一处,别在各模块里另写 —— 三条写入路径必须同口径,
  否则「同一句话记在客户上和记在商机上,提醒时间不一样」。
- 系统名最长 60 字符(zod + 数据库 text,无额外 CHECK,前端 maxlength 兜底)。
- Logo URL 须通过 `assertAllowedLogo` 格式/大小校验后才写入。

## 常见改动入口
- 增加配置项(如主题色/登录页背景) → `model.ts` 新列 + `logic.ts` DTO + `routes.ts` SaveBody 扩展 + `AppSettings.vue` UI
- 换 OSS/TOS 存储**不改代码**:系统设置 → 文件存储 tab 里切 provider(core/storage 平台级配置),`storeLogo` 走 `putObject` 自动跟随

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事
系统名称、换个 Logo、品牌设置、页面标题、公司名、系统设置、后台设置、时区/几点发提醒、开票抬头/税号、菜单顺序、文件存到哪/OSS

## 业务概念词典
| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「把系统名字改成我们公司的」 | 改系统名(左上角品牌区+浏览器标签页标题) | 系统管理→系统设置→品牌设置 | 已具备(轻) |
| 「上传公司 Logo」 | 上传图片替换默认图标(PNG/JPG/WEBP/SVG/GIF,≤2MB) | 系统设置→品牌设置,传完点保存即时生效 | 已具备(轻) |
| 「提醒时间不对/系统按几点算今天」 | 系统时区(IANA 名,默认北京时间);全部定时提醒的「几点发/今天算哪天」按它算 | 系统设置→品牌设置·系统时区(带「此刻几点」预览) | 已具备(轻) |
| 「让 AI 核对发票抬头是不是我们公司」 | 开票抬头全称+税号;配置后报销/付款预审核对买方抬头(税号不符红/名称不符黄),留空不启用 | 系统设置→品牌设置·开票信息 | 已具备(轻) |
| 「把某些菜单/功能藏起来不给人用」 | 功能开关(菜单组/菜单/功能逐项开关) | 系统设置→功能开关 tab(feature-toggle 模块的界面) | 已具备(轻) |
| 「调整左边菜单的顺序」 | 拖拽排一级/二级菜单,保存后全员统一生效 | 系统设置→菜单排序 tab(menu-order 模块的界面) | 已具备(轻) |
| 「配一下 AI 用哪个大模型 / 填 API Key」 | 平台级 LLM 供应商/模型/密钥配置 | 系统设置→AI 大模型 tab(core/llm 的界面) | 已具备(轻) |
| 「文件/图片存到自己的云上(OSS)」 | 平台级对象存储 provider 切换:本地磁盘 / 阿里云 OSS / 火山引擎 TOS,全系统上传下载即时跟随 | 系统设置→文件存储 tab(core/storage 的界面) | 已具备(轻) |
| 「换主题色/登录页背景」 | 新增品牌配置项 | 未做 | 中 |

## 可调旋钮清单
□ 系统名称(轻 · 最长 60 字,留空回落默认)
□ 企业 Logo(轻 · 上传/更换/移除;实际落到「文件存储」选定的 provider,公开直链)
□ 系统时区(轻 · 品牌设置内选 IANA 时区,影响全系统定时提醒/按天判定)
□ 开票抬头 + 税号(轻 · 留空 = 不启用发票买方抬头核对)
□ 功能开关逐项启停(轻 · 功能开关 tab,核心入口防自锁不可关)
□ 菜单排序(轻 · 菜单排序 tab,拖拽一级/二级,全员统一)
□ AI 供应商/模型/各家 API Key(轻 · AI 大模型 tab)
□ 对象存储 provider:本地磁盘 / 阿里云 OSS / 火山引擎 TOS(轻 · 文件存储 tab,secret 加密入库)

## 本模块约定与边界
- **「系统设置」页是多 tab 容器**,app-settings 模块自己只管「品牌设置」tab(系统名+Logo+系统时区+开票信息);其余 tab 是别的模块寄宿在这页,各带各的权限码(没码看不到该 tab):
  - **功能开关** tab → feature-toggle 模块(`feature-toggle:manage`):关掉的菜单组/菜单从导航消失、功能从权限配置页消失;前端隐藏口径(超管按钮仍可点,后端不拦);核心入口(系统设置/账号/角色权限)防自锁不可关。
  - **菜单排序** tab → menu-order 模块(`menu-order:manage`):拖拽排一级/二级菜单,全员统一顺序;只重排不隐藏。
  - **AI 大模型** tab → core/llm(`app-settings:manage`):平台口径 = **全系统 AI 能力(需求助手/CRM/合同等)统一用这里生效的供应商(阿里百炼/火山方舟/DeepSeek)+ 模型 + API Key,不另设配置、不要求客户改服务器环境变量**(页面保存的 Key 加密入库,env 仅作兜底来源显示);配了 SixAM 智能云 key 时另有余额/用量/对账单卡片。
  - **文件存储** tab → core/storage(`app-settings:manage`):对象存储 provider(本地磁盘/阿里云 OSS/火山引擎 TOS)切换与迁移。
  - **需求配置**(`feedback:configure`)、**发票识别 OCR**(`reimbursement:config`)、**企业IM接入**(`im-connect:config`)、**企业信息查验·企查查**(`company-lookup:config`)四个 tab 分别寄宿自 feedback / reimbursement / im-connect / company-lookup。
- 品牌读取全员可见(渲染壳层用),改动需系统设置管理权限。★整页导航入口由 `app-settings:manage` 门控:只持某 tab 权限(如仅 `feature-toggle:manage`)的人在导航里看不到「系统设置」。
- 客户提"通知配置"不在这页,是系统管理下另一独立菜单(notify 模块)。

## 改动代价速查
- 已具备:改系统名/Logo、系统时区、开票抬头核对、功能开关、菜单排序、AI 大模型配置、对象存储切 OSS/TOS(均页面即改即生效)
- 中:新增品牌配置项(主题色/登录页背景)
- 重:多语言品牌、按部门/子公司差异化品牌
