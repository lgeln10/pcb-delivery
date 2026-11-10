# core/storage — 平台级文件存储

> 平台基础设施(镜像 `core/llm`):全系统的文件上传/下载统一走这里选定的后端。
> 每租户一份配置,在「系统设置 → 文件存储」维护。业务模块只调 `api.ts` 的 `putObject/readObject/deleteObject`,不各自连 OSS/TOS、不各自读 env。

## 能力

| 能力 | 入口 |
|---|---|
| 上传对象(local/OSS/TOS) | `service.ts` `putObject(db, ctx, {bytes, filename, contentType, keyPrefix})` |
| 按 key 读回字节 | `service.ts` `readObject(db, ctx, key)`(本地优先;云端走 SDK 带签名读,私有桶下匿名 HTTP 会 AccessDenied) |
| 删除对象(尽力而为) | `service.ts` `deleteObject(db, ctx, key)` |
| 读/写配置 | `config.ts` `getConfig / setActiveProvider / saveProviderConfig / deleteProviderConfig` |
| 测试连接 | `service.ts` `testProvider(db, ctx, provider)`(上传探针再删) |
| 本地→云 一键迁移 | `migrate.ts` `migrateLocalToActiveCloud(db, ctx)`:把本租户各表引用到的本地文件按**原 key** 重传到当前生效云端,并改写这些行的文件指向(本地文件保留做备份;前提=生效存储为 OSS/TOS;`FILE_COLUMNS` 登记待改写列) |
| HTTP 路由 | `routes.ts` `/api/storage-config/*`(含 `POST /migrate-to-cloud`),全部 `requirePermission('app-settings:manage')` |

## 数据模型

- `storage_configs`(每租户一行):`active_provider` ∈ `local|oss|tos`。
- `storage_provider_configs`(每租户 × provider):`region/bucket/endpoint/public_base/access_key_id` 明文 + `access_key_secret_enc` 密文。

## 关键不变量

- **密钥红线**:`access_key_secret` 只以 AES-256-GCM 密文入库(走 `core/crypto/secret-box`,主密钥 env `CONFIG_ENC_KEY`/`AUTH_SECRET`)。接口只回 `secretSaved` 布尔,**绝不回明文**。解密失败(主密钥变更)回落 local,不泄露。
- **单一生效后端**:`active_provider` 是单值,provider 互斥;启用 oss/tos 前必须参数齐全且已存 secret。
- **env 向后兼容**:库内 `active_provider='local'` 但检测到历史 `FEEDBACK_OSS_*` env 时,回退走 env OSS —— 老部署零改动照常用 OSS。
- **key 前缀语义**:各模块自带前缀(`feedback/`、`contract/templates`、`branding/` 等),core 只负责后端落地。
- **公开前缀是一处定义**:哪些 key 匿名可读由 `public-prefix.ts` 的 `PUBLIC_KEY_PREFIXES` 唯一定义(现为 `branding/`、`website/`)。迁移 0143、`repair-public.ts`、`core/http/app.ts` 的 `/uploads` 静态路由三处都引它。**往里加一个前缀 = 宣布该前缀下的文件任何人免登录可下载**,加之前先确认这句话成立。
- **本地存储模式下公私文件同盘**:`putObject` 的 local 分支不分公私,都写进 `UPLOAD_DIR`。所以 `/uploads/*` 静态路由**必须**按公开前缀收窄 —— 否则 `/api/files/<key>?t=<票据>` 去掉 `?t=`、换成 `/uploads/<key>` 就是一条永不过期的免登录直链,整套票据机制被旁路(2026-08-15 修,护栏见 `core/http/tests/uploads-public-scope.test.ts`)。
- **上传类型判定不信客户端**:文件名与 `Content-Type` 都由客户端提供,一律先过 `checkUpload(bytes, filename, allowedExts)`(`upload-guard.ts`),判据是**扩展名在册 ∧ 内容与扩展名相符**;落库/出站用它返回的归一 `contentType`,不用 `file.type`。各上传口共用这一套,不各写各的:feedback 附件 / website 图 / app-settings logo / 员工头像,以及 2026-08-27 补齐的**报销发票**(`modules/reimbursement/routes.ts` `readInvoiceUploads`)、**付款凭证发票与非发票附件**(`modules/payment-voucher/routes.ts`)。发票口的白名单含 `ofd`(数电票版式原件,ZIP 容器,判据同 xlsx/docx 的 PK 头,归一为 `application/ofd`)。
- **大小上限在调用方,校验必须在落储之前**:`checkUpload` 只看内容,单文件上限由各口自己定(发票 5MB 对齐 `core/ocr` 的 `MAX_INVOICE_BYTES`,附件类 20MB),且**先校验再 `putObject`** —— 反过来写的话,恶意/超大文件在被拒之前已经落了存储。多文件口分两趟(全批校验通过再逐个落储),避免批里混一个坏文件时好文件已存、整个请求却 400,留下孤儿对象。
- **可渲染类型靠出站头兜底**:`/api/files` 与 `/uploads` 的响应带 `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`。SVG 因此只在公开前缀放行(logo/官网图),需求附件那类不可信来源不放行。

## 下载口径(现状 + TODO)

- 现状(2026-07 起):桶**保持私有**,文件按用途分两类。
  - **私有**(默认;合同/财务发票/报销/付款/HR 档案/审批附件/需求附件):`putObject` 返回内部标记
    `storage:private/<key>` 入库(不是可访问地址)。出站时由 `core/http/private-files.ts` 的中间件统一换成
    `/api/files/<key>?t=<票据>`;票据 = HMAC(租户+key+过期时刻),15 分钟有效,不查库。
    `/api/files` 校验票据后:云端 302 到预签名 URL,本地读盘返回。**前端各展示点无需改动**(拿到的就是可直接用的地址)。
  - **公开**(`visibility: 'public'`;仅官网图片 `website/` 与系统 logo `branding/`):上传打 public-read ACL,
    存直链——登录页未登录就要显示 logo,官网访客/爬虫要读图,它们走不了票据。
- ~~TODO(私有桶)~~:**已落地**(见上)。私有下载端点 = `/api/files/<key>?t=<票据>`;签名与校验在 `core/storage/private-url.ts`。

## 已知边界

- TOS SDK(`@volcengine/tos-sdk`)懒加载:未启用 TOS 不加载、不需安装即可跑 local/OSS 与全部测试;生产 `npm install` 会装。
- 切换 provider 后,旧 provider 已上传文件的 URL 仍指向旧后端;`readObject` 本地优先 + 云端 SDK 带签名读兜底以缓解。本地→云可用「文件存储」页的一键迁移(`migrateLocalToActiveCloud`)批量搬迁并改写指向;云↔云、删本地备份暂不做。
- 迁移新增文件列须登记:业务模块若新增「存文件 URL/附件 JSON」的列,要加进 `migrate.ts` 的 `FILE_COLUMNS`,否则该列不会被迁移改写。

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事

文件存不下、附件、图片、上传、下载、存到阿里云、用 OSS、用火山、对象存储、换存储、桶、bucket、AccessKey、文件放服务器还是云上、迁到云、CDN

## 业务概念词典

| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「文件存阿里云」 | 启用阿里云 OSS 作为生效存储,上传下载都走它 | 系统设置 → 文件存储 → 阿里云 OSS + 开关 | 轻 |
| 「文件存火山」 | 启用火山引擎 TOS 作为生效存储 | 系统设置 → 文件存储 → 火山引擎 TOS + 开关 | 轻 |
| 「存回本地/存服务器上」 | 关掉云存储开关,回落服务器本地磁盘 | 系统设置 → 文件存储 | 轻 |
| 「填 OSS/TOS 的密钥」 | AccessKey ID + Secret,Secret 加密入库(只显示"已保存") | 系统设置 → 文件存储 | 轻 |
| 「用自己的域名访问文件」 | 配公开访问域名(CDN/自定义域名),文件 URL 用它拼 | publicBase 字段 | 轻 |
| 「测一下通不通」 | 用已存参数上传一个探针再删,验证凭证/桶权限 | 文件存储 → 测试连接 | 轻 |
| 「这些资料要保密/不能被人直接下」 | 已是默认行为:桶保持私有,内部附件一律经 `/api/files` 带票据下载(15 分钟时效),仅 logo/官网图匿名可读 | 内建默认,无需配置 | 已具备 |
| 「以前存本地的文件也搬到云上」 | 本地→云一键迁移:按原 key 重传 + 改写库内所有指向,本地文件保留做备份 | 系统设置 → 文件存储 → 「一键迁移本地文件到云存储」 | 轻 |
| 「接另一家云存储」 | provider 注册表加一条(需其 SDK/协议) | providers.ts + service.ts | 中 |

## 可调旋钮清单

□ 生效存储后端(轻 · 本地磁盘 / 阿里云 OSS / 火山引擎 TOS,单选互斥)
□ 各 provider 连接参数(轻 · region/bucket/endpoint/公开域名/AccessKey,Secret 加密存)
□ 测试连接(轻 · 探针上传+删除验证凭证)
□ 私有桶 + 签名下载(已内建默认:内部文件一律 `/api/files` 票据下载,票据 15 分钟;非旋钮、无需配置)
□ 本地→云一键迁移 / 修复公开文件访问权限(轻 · 文件存储页两个按钮,均可重复运行)
□ 新增其他云存储供应商(中)

## 本模块约定与边界

- **★平台统一口径**:全系统所有文件上传/下载(需求附件、合同模板/成品/扫描件、企业 logo 等)统一走这里选定的存储后端(putObject/readObject),各模块不自设存储、不各自读环境变量、不各自连 OSS/TOS。改一处,全系统文件落地生效。
- **密钥红线**:AccessKey Secret 用 AES-256-GCM 加密入库,明文永不返回;需服务器配了加密主密钥(AUTH_SECRET / CONFIG_ENC_KEY)才能保存。
- **向后兼容**:历史用环境变量(FEEDBACK_OSS_*)配 OSS 的部署,升级后不动设置页也照常走 OSS。
- **下载现状**:桶私有;内部文件一律经 `/api/files` 带票据下载(票据 15 分钟有效,过期刷新页面自动重签)。
  仅系统 logo 与官网图片是匿名可读的公开对象。
- **存量修复**:迁移 `0143` 把库里私有文件的绝对 URL 改写成内部标记;私有桶启用前上传的 logo/官网图没打过
  public-read ACL,用「系统设置 → 文件存储 → 修复公开文件访问权限」一键补(可重复运行)。
- **切换存储不自动搬旧文件**:换后端后,之前上传的文件链接仍指向旧后端;只有新上传走新后端。本地→云可用「一键迁移本地文件到云存储」批量搬+改写指向;云↔云迁移暂不做。
- 配置读写需系统设置管理权限(app-settings:manage),无独立菜单。
