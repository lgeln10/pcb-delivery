# license — MODULE.md

# ============ 上半部:实现层(实现 agent 用)============

## 职责(一句话)
验签授权文件、计算宽限/只读状态、席位与功能项门控、远程心跳续期/吊销。

## 拥有的实体(写权限唯一归本模块)
无 DB 表——状态源是 Ed25519 签名的 license blob(env `LICENSE_KEY` 或上传后落盘的 `.license.json`)+ 本地心跳缓存文件(`hbstore.ts`),这是本模块与其他模块"拥有实体=DB 表"模式的主要区别,改动时不要下意识去建表。

## 只读依赖
- org/hr-core:在职且未删除的账号数(席位计数 `countActiveSeats`,`state.ts:97`)

## 核心流程
1. 加载/验签:`loadLicense`(`state.ts:57`)读 license blob → `verifyLicense`(`verify.ts:27`)用内嵌公钥(`EMBEDDED_PUBLIC_KEY`,`verify.ts:20`,可被 env `LICENSE_PUBLIC_KEY` 覆盖)验签,得 `LicensePayload`(licenseId/customer/seats/issuedAt/expiresAt/features/graceDays,`verify.ts:7`)。
2. 状态计算:`licenseStatus`(`verify.ts:70`)结合当前时间与心跳缓存,算出 `active/grace/expired/invalid` 四态(`LicenseState`,`verify.ts:54`);`getLicenseStatus`(`state.ts:106`)是给路由用的整合版(含席位数)。
3. 中间件拦截:`licenseWriteGuard`(`guard.ts:24`)在非 active 且超宽限时拦所有写操作(登录/授权接口豁免);`licenseFeatureGuard`(`guard.ts:12`)按路由前缀清单(`AI_PREFIXES`,`guard.ts:9`)拦未采购功能项的接口。
4. 心跳:远程续期/吊销通过 `licenseServerUrl`(`state.ts:28`)定时打卡,断网超 14 天(`HB_GRACE_DAYS`,`state.ts:11`)视为过期。

## 关键不变量(AI 改动不能破坏)
- **过宽限只读但登录/授权豁免**:`licenseWriteGuard`(`guard.ts:26-30`)拦写操作时必须放行登录与授权激活接口本身,否则客户过期后无法上传新授权解除只读——死锁。
- **远程吊销或断网 14 天视为过期**:心跳折叠逻辑(`state.ts:79-94`)必须保证两条路径都能让状态降级为 expired。
- **默认宽限期 7 天**:`payload.graceDays ?? 7`(`verify.ts:76`),厂商签发时可覆盖。
- **只对私有化部署强制**:demo/开发/内部环境未配置授权源(`hasLicenseSource`,`state.ts:32`)且未设 env `LICENSE_REQUIRED=true` 时,`licenseEnforced()`(`state.ts:42`)恒为 false,不强制;客户镜像设 `LICENSE_REQUIRED=true` 则未激活也强制(只读 + 提示上传)。
> 对应测试:`core/license/tests/enforce.test.ts`、`license.test.ts`。

## 对外接口
- `getLicenseStatus(db)` / `isWriteBlocked()` / `assertSeatAvailable(db)` / `licenseHasFeature(feature)` / `licenseEnforced()` / `hasLicenseSource()`(`state.ts`)
- `activateLicense({ license, server? })`(上传授权文件激活,`state.ts:65`)
- `licenseWriteGuard()` / `licenseFeatureGuard()`(Hono 中间件,`guard.ts`)
- `startHeartbeat()`(`heartbeat.ts:36`,`server.ts` 启动时调;配了 `LICENSE_SERVER_URL`/授权文件带 server 才生效)

## 常见改动入口
- 加新的可采购功能项门控 → `guard.ts:9` `AI_PREFIXES` 同款前缀清单 + 前端导航对应隐藏
- 换签名密钥 → `verify.ts:20` `EMBEDDED_PUBLIC_KEY` 或部署时用 env `LICENSE_PUBLIC_KEY` 覆盖
- 改心跳断网容忍天数 → `state.ts:11` `HB_GRACE_DAYS`

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事
授权、激活、License、序列号、到期续费、加人数/席位、买了哪些功能、系统变只读了

## 业务概念词典
| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「怎么激活系统」 | 上传厂商发的授权文件(.lic)一键激活 | 页面顶部红色提示条→「上传授权文件」按钮,选文件即激活,无需重启 | 已具备(轻) |
| 「授权到期了会怎样」 | 到期先进宽限期(默认 7 天,可写只提示),过宽限全系统只读 | 顶部黄条/红条自动提示;只读时仍能登录、看数据、上传新授权 | 已具备(口径说明) |
| 「加不了新账号」 | 在职账号数达席位上限 | 顶部提示条显示已用/上限;新增账号被拦并提示联系升级 | 需换更大席位的授权文件 |
| 「AI 那块菜单怎么没了」 | 未采购「智能体工作台」功能项 | 企业智能体整组导航隐藏 + 相关接口拒绝 | 需含 ai 功能的授权文件 |
| 「远程给客户续期/停用」 | 心跳:系统每天向厂商授权服务打卡 | 远程续期免重新部署即延长;远程吊销立即只读;断网超 14 天视为过期 | 厂商侧操作 |

## 可调旋钮清单
□ 换授权文件(轻 · 顶部提示条上传即生效:续期/扩席位/加功能项都靠换文件)
□ 宽限天数(厂商签发时定,默认 7 天)
□ 功能项清单(厂商签发时定,如 'ai'=企业智能体板块)
□ 心跳服务地址(部署时配或随授权文件带入)

## 本模块约定与边界
- **无菜单页**:唯一可见入口是页面顶部的授权提示条——未激活=红条+「上传授权文件」按钮;宽限期/超席位=黄条;过期=红条只读。状态正常时什么都不显示。
- **超管与普通用户看到的一样**:提示条对全员显示,上传授权也不限角色(未激活时本来就没法用别的)。没有独立的"授权管理页"。
- **只对客户私有化部署强制**:demo/开发/内部环境未配授权则完全不强制、全功能可用。判断"客户问授权"时先确认对方是私有化交付客户。
- 只读拦截口径:过宽限后拦所有写操作,豁免登录和授权激活本身(否则续费后无法操作);读数据永远不拦。
- 授权文件由厂商私钥签发、系统内嵌公钥验签,客户改文件即失效;席位口径=在职且未删除的账号数。
- 与「功能开关」区别:功能开关是客户自己藏菜单(可随时打开);授权功能项是商务采购边界(没买就是没有)。

## 改动代价速查
- 已具备:上传激活、到期宽限+只读、席位上限、AI 功能项门控、心跳远程续期/吊销
- 轻:客户侧换授权文件解决续期/扩容/加功能
- 中:新增可采购功能项(后端加门控前缀+前端隐藏)、授权管理独立页
