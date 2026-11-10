# core/backup — 数据库自动备份

> 平台基础设施(镜像 `core/storage` / `core/scheduler`):**实例级**能力,一次 dump 覆盖整个数据库、所有租户。
> 本轮只有引擎与定时任务,**没有设置页/HTTP 路由**(下一轮)。组合根只需 `registerBackupJobs()`。

## 能力

| 能力 | 入口 |
|---|---|
| 跑一次备份(preflight → dump → 校验定级 → 落地 → 台账 → 轮转) | `service.ts` `runBackupOnce(db, {now?, config?, tools?, force?})` |
| 轮转(算保留计划 → 删对象 → 标 `pruned_at`) | `service.ts` `pruneOldBackups(db, cfg)` |
| 健康度(最近成功时间 / 现存份数 / 占用 / 是否陈旧) | `service.ts` `getBackupHealth(db, cfg, now)` |
| 分层保留计算(**纯函数**) | `retention.ts` `planRetention(rows, limits)` |
| 定级 ok/suspect/failed(**纯函数**) | `verify.ts` `verifyDump(input)` |
| 版本 preflight + 执行 pg_dump/pg_restore | `pg-tools.ts` `checkVersionCompat` / `realPgTools()` |
| **恢复演练**(真恢复进临时库 → 点表 → 删临时库) | `restore-drill.ts` `runRestoreDrill(db, {...})` |
| 定时接线 + 告警 | `automation.ts` `registerBackupJobs()` |

## 数据模型

`db_backup_runs`(1 张表,迁移 `0206`):台账。每次备份一行,含 verdict / 落地位置 / 字节数 / sha256 /
`pg_restore --list` 对象数 / 关键表行数快照 / 定级原因 / pg 版本。

- **★没有 `tenant_id`** —— 对全局公共字段的一处有意例外(同 `common-fields.ts` 里 tenant / permission 那两条)。
  一次 dump 覆盖整个数据库,没有任何租户「拥有」这一行;硬塞 `tenant_id` 会让人以为备份是按租户做的。
- **★没有 `is_deleted`** —— 台账行永不删。对象被轮转清掉时只写 `pruned_at` + `pruned_reason`,
  历史行留着回答「上个月 3 号那份备份后来去哪了」。
- **恢复演练三列(迁移 `0207`)**:`restore_verified_at` / `restore_verdict` / `restore_detail`。
  **★三态不许压成两态**:`NULL` = 还没演练过、`passed` = 真恢复出来过、`failed` = 恢复不出来。
  把 `NULL` 当 `passed` 渲染就是「把没检查过说成检查通过」;当 `failed` 告警则是天天狼来了。
- **★不存 `tier`(日/周/月)与 `pinned`** —— 全部由 `(local_date, verdict)` 现算。存派生状态就会漂移,
  而这种漂移**只在你真要恢复的那天**才暴露。

## 落地位置

**租户配了 OSS/TOS 就传上去,没配就落本地** —— 直接复用 `core/storage` 的 `active_provider`,
不另起一套「备份专用存储配置」(否则客户换存储要改两处,迟早只改一处)。

- 云端:`putObject(keyPrefix='backups', visibility='private')`。
- 本地:**故意不走 `putObject`**。`putObject` 的 local 落点是 `UPLOAD_DIR`(用户上传文件),
  把整库 dump 混进用户附件目录会同时坏两件事 —— `core/storage/migrate.ts` 会把它当业务文件搬上云,
  而部署/运维脚本按「uploads 是用户数据」在处理它。所以本地走独立的 `BACKUP_DIR`。

## 关键不变量

1. **★坏备份永远不能淘汰好备份。** 实现方式不是加判断,而是把 `ok` 与 `suspect|failed` **分开算额度**:
   good 的淘汰只在 good 内部发生,bad 有自己独立的小额度(默认 2 份,仅供排查)。集合分开,
   就没有「坏的顶掉好的」这条路径可走。这一条直接对应需求方提的场景:*库坏了连备三天,把之前正常的备份全顶掉。*
   (`tests/retention.test.ts`、`tests/ledger.test.ts`)
2. **★两个钉子都永不被轮转淘汰**,总磁盘额度超限时也不砍:
   - `last-known-good` = 最近一份 `ok` —— **状态最新**,但只验到「dump 跑完、清单读得回来」;
   - `last-restore-verified` = 最近一份**真恢复出来过**的 —— 可能旧几天,但它是唯一一份「确定能救你」的。
   两者常常是同一份(那就零额外成本);一旦最新那份还没轮到演练、或演练没过,这两个钉子就分开 ——
   **而那正是你最需要旧那份还在的时候**。砍到一份不剩的备份系统比没有备份更糟,因为面板上还写着「已启用」。
3. **★`backups/` 绝不能进 `PUBLIC_KEY_PREFIXES`。** 那等于宣布整库 dump 免登录可下载,
   一条 URL 就能把全公司数据拖走。护栏:`tests/public-prefix-guard.test.ts`。
4. **★绝不用管道跑 pg_dump。** `pg_dump … | gzip > f` 的退出码来自 `gzip` —— pg_dump 炸了也是 0,
   于是「备份成功」而文件是半截的。一律 `-Fc -f <文件>`,读进程自己的退出码。
   (`-Fc` 自带压缩,本来也不需要外挂 gzip。)
5. **★密码只走子进程 `PGPASSWORD`,不进 argv。** argv 在 `ps aux` 里全机可见。
6. **★本地日历日只由 `config.localDateOf(at, tz)` 算,不用 `toISOString`。** 东八区凌晨 3 点备份时
   UTC 还在前一天,幂等键会算成昨天 —— 同一天跑两次、另一天一次都不跑。而 CI 跑 UTC 恰好正确,
   所以这类错只在生产显形(本仓已有先例)。周/月锚点判定同理用 `getUTCDay`,与机器时区无关。
7. **同一个本地日历日至多一份**还活着的**`ok`**:库层部分唯一索引 `db_backup_runs_ok_per_day_uq`
   (`WHERE verdict='ok' AND pruned_at IS NULL`)+ 进程内 `inFlight` 闸。同一天允许多份坏的 —— 失败重试不该被挡。
   - **★`pruned_at is null` 那半句不能少**(0208 补):不加的话,当天那份被轮转掉或丢失之后,
     **同一天再也备不了第二次** —— 「备份丢了」连带变成「今天不许再有备份」,要熬到过午夜才自愈。
     `runBackupOnce` 的幂等判定同步加了这一条,于是文件一丢、下一个 tick 会自动重备(自愈)。
   - **★冲突判定要沿 `cause` 链找**(`isUniqueViolation`):drizzle 把驱动错误包了一层,
     最外层只剩 `Failed query: insert into …`,既没有 `duplicate key` 也没有索引名。
     只看最外层的话,并发兜底那条路不是返回 `skipped` 而是**直接抛出去**,留下孤儿文件。
   - **★台账写不成时必须收掉刚落地的对象**,且对**任何**写库失败都要收 —— 否则盘上多一份没人认领的
     整库 dump,而 `reconcileMissingLocalObjects` 只认得「账上有、盘上没有」那个方向,看不见这一种。
8. **没有 `DATABASE_URL` → `skipped`,不写 `failed` 行。** 本机 demo/内存库模式不是备份失败;
   反过来会让开发机每天刷一条红,真失败反而被淹没。
9. **版本 preflight 失败要写 `failed` 台账行 + 告警,不许静默。** 见下方「实测过的坑」。
10. **★「查询失败」不等于「表不存在」。** 演练点表时,只有 PG `42P01`(undefined_table)才算
    「这张表没恢复出来」→ `failed`;别的任何查询失败(连接断了、权限不对)一律算**演练跑不了**
    → `skipped`,`restore_verdict` 保持 `NULL`,下周原样再试。
    原先那句 `.catch(() => null)` 把两者混成一件事 —— 一次连接抖动就给一份好备份定罪。
    这是同一类假警报在这个模块里的**第三次**(前两次见下方两节),形状完全一样:
    **把「不知道」渲染成「坏了」。**(`tests/restore-drill.test.ts`)
11. **★告警收件人用 `org/api.listEmployeeIdsWithPermission` 一次查出,不许遍历员工逐个
    `hasPermission`。** 后者是 N+1;更要命的是循环里单人失败只能就地吞掉,于是
    「权限判定系统性坏了」表现成收件人**静默缩成租户主一个人**,日志里一个字都没有。
    算不出收件人时要 `console.error` + 退回租户主 —— 备份告警发不到该看的人手上,
    是比备份失败更糟的一种坏法。
12. **体量超 `BACKUP_MAX_UPLOAD_BYTES` 只落本地,并把这件事记进 `upload_skipped`。**
    `putObject` 只吃 `Buffer`(`core/storage` 没有流式口),几个 G 的 dump 整个进内存会在内存紧张的机器上
    把进程打挂。★这个行为必须能被查出来,不能只写在日志里 —— 否则表现成「以为在上云,其实一直在本地」。
    - 同理,**存储配置读不出来时的回落也要留痕**(`resolveActiveBackend` 失败 → `console.error`):
      主密钥换了、配置被删,表现都是「备份悄悄从上云退回单机」,而面板上一切正常。

## ⚠️ `ok` ≠ 验证过能恢复

`ok` 只代表:pg_dump 退出码 0、`pg_restore --list` 读得回来、体量/行数没异常突降 ——
**没有真的 restore 过一遍**。真恢复过的那份另有标记:`restore_verdict='passed'`(每周演练,见下节)。

所以面板与对外沟通要区分三种状态,别压成两种:
**没演练过(`NULL`)/ 演练通过(`passed`)/ 演练没过(`failed`)**。

对应地,这道校验闸**拦得住**和**拦不住**的分别是:

| | 表现 | 这道闸 |
|---|---|---|
| ① 库坏了 / 服务挂了 / dump 不完整 | pg_dump 非零退出,或清单读不出 | **拦得住** |
| ② 库很健康,数据错了(误删一批客户、跑错一条 UPDATE、迁移写坏字段) | pg_dump 与 pg_restore 全都正常 | **拦不住** |

**★「上一份有、这一份没有」的表不算信号**:快照是「行数最多的前 N 张表」,一张表掉出名单最常见的
原因是**别的表涨上来把它挤出去了**,与它自己有没有被删无关 —— 用 top-N 的缺席去判「表被 drop」,
判据本身不成立(2026-08-17 生产实测误报过)。表真的没了,恢复演练点表时会实打实查不到,那才是有判据的地方。

**★对照基准是「最近一份非 failed」,`suspect` 也算。** 直觉上「拿可疑的那份当基准」不对,但反过来更糟:
基准只认 `ok` 的话,任何**持续性的正常变化**(迁移删了张大表、归档清掉一批历史日志)都会让此后
**每一次**备份都相对那个冻住的旧基准判 suspect —— 天天同一条告警,而 suspect 不参与好备份额度,
`last-known-good` 也跟着冻住。**一条永远在响的告警等于没有告警。**
代价是一次真实骤降只报一次(次日起成为新常态),可以接受:缓慢渗漏本来就低于阈值、两种口径都测不出。

对 ② 只有两件事有用:**行数/体量突降的粗筛**(只抓得住大批量删除)与**分层保留给出的时间跨度**。
「滚动三天」之所以不够,正是因为 ② 常常过了三天才被发现(月底对账、客户投诉才知道上周数据没了)。

**★别在 UI 上把 `ok` 写成「已验证可恢复」——「已验证」是 `restore_verdict='passed'` 那一列的事。** 把「没检查过」渲染成「检查通过」是这类功能唯一的致命失败模式
(同 `document` 模块 AI 预审那条不变量)。

行数快照用 `pg_stat_user_tables.n_live_tup`,**只取 `public` schema**,是**估计值**(准度依赖 autovacuum/analyze)。
★「只取 public」这半句是被误报教出来的:`relname` 不带 schema,而演练拿这名字去 `public` 下点表,
于是 `drizzle.__drizzle_migrations` 必然「查不到」—— 2026-08-17 生产实测,20 张表 19 张行数分毫不差,
只因为这一张判了 failed。**假警报比没有警报更糟,它教会人忽略这个告警。**
两边现在都钉死在 `public`(快照的 where、演练探测语句里显式写的 `public."表名"`),口径必须同源。
选它而不是逐表 `count(*)`:零业务耦合(不硬编码表名,表改名也不失灵)、开销恒定(大库上 20 次
`count(*)` 可能要几十秒)。因此阈值放到 80%,它只用来粗筛,不是精确对账。

## ⚠️ 实测过的坑之二:发版会删掉备份目录(2026-08-17 真出过)

**症状**:当天备好的 dump 没了,而台账那行 `pruned_at` 仍是 null —— 健康度报「现存 1 份」,
盘上一份都没有。**备份系统撒的谎比没有备份更危险。**

**真因**:`.github/workflows/ci-deploy.yml` 的部署是 `rsync -az --delete`,
排除了 `.git/node_modules/.env/secrets/.storage`,**唯独没排 `backups/`**。
`uploads/` 当时侥幸没事,只因为 base 那台机的 `.env` 把 `UPLOAD_DIR` 指到了部署目录之外 ——
**它的默认值就是 `<cwd>/uploads`**,任何没改过那个 env 的部署,发一次版就清空用户上传的文件。

> ★我最初查错了脚本:读的是 `demo_deploy.sh`(它确实没有 `--delete`),而真正在跑的是 CI 那条。
> 教训是**别从脚本推断,去服务器上看文件还在不在**。

**两道修法都做了**:
1. 工作流补 `--exclude 'uploads' --exclude 'backups'`,护栏 `tests/deploy-excludes-guard.test.ts`
   钉住(删掉 exclude 会转红,已反向验证过)。
2. `reconcileMissingLocalObjects()`:台账说在、盘上找不到的**本地**备份自动标记丢失,
   每次轮转前先跑。这样即便换个原因(手工清理、换盘、改 `BACKUP_DIR`)再丢一次,
   面板也不会继续撒谎。**只对 `location='local'` 判定** —— 云端读不到可能只是网络抖动,
   把它当「丢了」会误杀好备份。

**传播到客户分支时**:各分支自己的 ci-deploy.yml 要一起改;走镜像部署(火山 CR)的客户不受这条影响,
但要确认 `BACKUP_DIR` 挂在持久卷上而不是容器层。

## ⚠️ 实测过的坑:宿主机 pg_dump 版本

**pg_dump 拒绝导出比自己新的服务端。** 2026-08-17 实测本机 `pg_dump 16.11` 打 `postgres:17` 容器:

```
pg_dump: error: aborting because of server version mismatch
pg_dump: detail: server version: 17.11; pg_dump version: 16.11
```

而 base 那台机当时正是 **宿主机 pg_dump 16.14 + 库 PG 17.10** —— 照直上线,第一天就会天天失败。
已在该机装 `postgresql-client-17`(`pg_dump 17.11`)。`checkVersionCompat` 因此存在:
判据是 `pg_dump 主版本 >= 服务端主版本`,不通过就写 `failed` 台账行并告警,报错文案直接说清装哪个包。

> **传播到客户分支时先查这一条**:unix / product/fund / product/hotel / product/cosmo 各自的
> pg_dump 与库版本要对齐,否则那台机每天一条 failed。`BACKUP_PG_DUMP` 可指定具体路径
> (如 `/usr/lib/postgresql/17/bin/pg_dump`)。

## 配置(env)

| env | 默认 | 说明 |
|---|---|---|
| `BACKUP_ENABLED` | `1`(**开**) | `0/false/off` 关。默认站在「开」这一侧:备份最经典的死法是「以为在备,其实从来没开过」 |
| `BACKUP_DIR` | `<cwd>/backups` | 本地落点。**★发版脚本必须排除它** —— 见下方「发版会删掉备份目录」。生产建议直接设成部署目录之外的绝对路径(base 的 `UPLOAD_DIR` 就是这么干的) |
| `BACKUP_HOUR` | `3` | 本地几点跑 |
| `BACKUP_TZ` | `TZ` → `Asia/Shanghai` | 算本地日历日/小时用 |
| `BACKUP_KEEP_DAILY` | `3` | 滚动日备份数(至少 1) |
| `BACKUP_KEEP_WEEKLY` | `1` | 周日那份日备**提升**为周备,不额外 dump |
| `BACKUP_KEEP_MONTHLY` | `1` | 每月 1 日那份提升为月备 |
| `BACKUP_KEEP_BAD` | `2` | suspect/failed 合计留几份(仅供排查) |
| `BACKUP_MAX_TOTAL_BYTES` | 不限 | 总额度。超限的牺牲顺序:坏备份 → 月备 → 周备 → 最老的日备;`last-known-good` 永不砍 |
| `BACKUP_MAX_UPLOAD_BYTES` | 512MB | 超过就只落本地(见不变量 10) |
| `BACKUP_STALE_ALERT_DAYS` | `2` | 连续这么多天没成功就告警 |
| `BACKUP_PG_DUMP` / `BACKUP_PG_RESTORE` | `pg_dump` / `pg_restore` | 同机多版本客户端时指定路径 |
| `BACKUP_STORAGE_TENANT_ID` | 最早创建的租户 | 上云时用谁的对象存储配置 |
| `BACKUP_DRILL_ENABLED` | `1`(**开**) | 每周恢复演练开关 |
| `BACKUP_DRILL_WEEKDAY` | `0`(周日) | 演练在周几跑 |
| `BACKUP_DRILL_HOUR` | `5` | 演练几点跑(排在备份点之后,让当天那份先备完) |
| `BACKUP_DRILL_MAX_BYTES` | 2GB | dump 超过这个大小就跳过演练(临时库约等于原库大小)。★超限是 `skipped` 不是 `failed` |

**磁盘量级参考**(2026-08-17 生产实测):base 整库 27 MB,`-Fc` 后 dump **1.4 MB**、耗时 554ms →
默认 6 份约 **8.4 MB**。演练期间会额外短暂占用一个约等于原库大小的临时库。
在这个量级上「怕占磁盘」不构成约束;`BACKUP_MAX_TOTAL_BYTES` 是给大客户留的闸。

## 定时任务

| job | 间隔 | 做什么 |
|---|---|---|
| `db-backup` | 1h | 到 `BACKUP_HOUR` 且当天还没备成功就备一次;非 `ok` 发告警(**带原因原文**) |
| `db-backup-stale-check` | 1h | 在 `BACKUP_HOUR+1` 点判「连续 N 天没成功」并告警 |
| `db-backup-restore-drill` | 1h | 每周 `BACKUP_DRILL_WEEKDAY` 的 `BACKUP_DRILL_HOUR` 跑一次恢复演练 |

- **★为什么是「每小时 tick + 自己判小时」而不是 24h 间隔**:`core/scheduler` 是 `setInterval` 语义,
  24h 是从**进程启动那一刻**起算的 —— 发一次版就把备份时间挪到白天,再发一次又挪走,永远漂。
- **★陈旧巡检比失败告警更重要**:备份最常见的坏法不是失败,是**从某天起干脆不跑了**
  (被关掉 / 进程没起来 / 时区被改),那种情况下一条失败告警都不会有。
- 告警收件人 = 租户主 + 持有 `app-settings:manage` 的人;`sourceType='db_backup'`,落点「系统设置」
  (备份那一屏下一轮做在那里)。★加一种 sourceType **必须同时在 `notification-target.ts` 配落点** ——
  `inapp-notify/tests/notification-link.test.ts` 有一条不变量是「每种 sourceType 都点得开」,
  漏配就变红(本轮真踩了一次:原打算「先不配落点」,被那条测试拦下了)。
- 告警正文**必带定级原因原文**。教训来自 AI 能力回归那三次连红:告警卡片只列了「常见原因」清单,
  真因的原始错误串一次都没带出来,于是三次告警三次没人动。
- core 往下够 `modules/inapp-notify` 这一笔与 `core/http/app.ts`、`core/data-catalog/registry.ts` 同形:
  **接线文件可以往下够,logic 文件不行。**

### 恢复演练(`restore-drill.ts`)

把**最近一份还活着的 ok 备份**真的恢复进临时库 → 按备份时的行数快照点几张表 → 删掉临时库。
验它而不是验老备份,因为那正是真出事时你会去恢复的那一份。

**★这个文件会在生产数据库服务器上建库、删库,四条硬约束:**
1. 临时库名恒为 `aios_restore_drill_<毫秒时间戳>`,**删库前再断言一次名字匹配该模式** ——
   变量拼错、参数传反时宁可抛错,也不能删到别的库。
2. 建/删库走**独立的短命连接**(连 maintenance 库),不碰应用连接池 —— CREATE DATABASE 不能在事务里跑。
3. **删库放 `finally`**,任何一步炸了都要收干净;删之前先 `pg_terminate_backend` 踢掉残留连接
   (否则 DROP DATABASE 会因为还有人连着而失败)。每周漏一个和原库同样大的库,磁盘会被慢慢吃光。
4. **★「演练跑不了」与「备份恢复不出来」必须分开报**:没有 CREATE DATABASE 权限、dump 超过体量上限、
   对象取不到 → `skipped`(**不写 `restore_verdict`,不告警**);只有真恢复不出来才是 `failed` + 告警。
   混为一谈的话,交付到权限受限的客户环境就会每周一条假警报,人很快学会忽略它。

**判 `failed` 的只有两条**:`pg_restore` 非零退出;或快照说有数据的表恢复出来是空的/查不到。
**行数对不上不判失败**,只记进 `notes` —— 快照是 `n_live_tup` 估计值,本来就不精确。

幂等:最近那份已演练过就直接 skip(连临时库都不建),所以同一小时内多跑几次也不会重复演练。

## 测试覆盖 / 没覆盖

`tests/` 106 条:`retention`(分层保留 + 坏备份不淘汰好备份 + 两个钉子 + 额度裁剪牺牲顺序)、
`restore-drill`(通过/不通过判定 + **「跑不了」不报成「坏了」** + **临时库在通过/失败/抛异常三条路上都被删** +
删前先踢连接 + 全程只有一条 drop 且必须匹配演练库名 + 幂等)、
`verify`(定级三档 + 小表不误报 + 第一份不判 suspect)、`config`(env 解析 + **显式设 TZ 的时区用例** +
DSN 解析 + 版本 preflight)、`ledger`(真迁移 + 库层 CHECK + 一天一份 ok 的唯一索引 + 轮转真删文件 +
台账行只标 `pruned_at` + 健康度 + **台账与磁盘对账** + **丢失后同一天可重备** + **冲突判定沿 cause 链**)、`public-prefix-guard`、
`deploy-excludes-guard`(发版 rsync 必须排除 `uploads/` 与 `backups/`)。

**★单测跑不到真 pg_dump/pg_restore,也建不了第二个库** —— 测试库是 PGlite(进程内 Postgres)。
所以执行层抽成 `PgTools` 接口、演练的库连接抽成 `openClient` 依赖,测试都塞假的。
真路径靠一次性 docker 冒烟验过(pg16→pg16 happy path、pg16→pg17 拒绝、错库名 → failed、
二进制不存在 → null),**那个脚本不进仓**(需要 docker)。

**2026-08-17 生产实测**:base 上真跑了一次备份(`ok`,1.4 MB,554ms,清单 1121 个对象),
又把那份 dump 真恢复进临时库对账 —— `leads=100 / partners=29 / employees=16 / approval_instances=17`
与生产库完全一致,临时库已删。

## 下一轮(本轮刻意没做)

- 系统设置页一屏:状态(最近成功备份 / 上次演练结果 / 现存份数 / 占用)+ 手动备份/演练按钮 + 下载。
- ~~真 restore 校验~~ **已落地**(`restore-drill.ts`,每周)。
- 恢复流程本身(目前是运维手动 `pg_restore`);以及去重(同 sha256 不重复存)。
- `core/storage` 的流式上传口,以取代不变量 10 那个体量闸。
- **异地副本**:base 现在没配 OSS,备份与数据库在同一块盘上 —— 违反 3-2-1,是当前最大的单点。
  配上 OSS 即自动解决(代码已支持)。
- **不可变/防删**:轮转要删旧备份,所以应用握着删除权 = 应用被攻破则库与备份一起没。
  正解是 OSS 对象锁,或改成拉取式备份。

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事

备份、数据备份、数据库备份、自动备份、定时备份、每天备份、数据会不会丢、数据丢了怎么办、
恢复数据、还原、回滚到前几天、误删了能不能找回、备份到阿里云、备份放服务器上、
备份保留几天、备份占多少空间、备份有没有在跑、备份成功了吗、数据安全、容灾

## 业务概念词典

| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「每天自动备份数据库」 | 每天固定时间 pg_dump 整库一次,失败会告警 | 已默认开启(env `BACKUP_ENABLED`) | 轻 |
| 「备份放到我们的阿里云上」 | 租户已配 OSS/TOS 时自动上传到对象存储 | 系统设置 → 文件存储(备份复用同一处配置) | 轻 |
| 「没有云存储就放服务器」 | 落在服务器的 `BACKUP_DIR` 目录 | 默认行为,无需配置 | 轻 |
| 「只保留最近三天」 | 滚动 3 份日备 | env `BACKUP_KEEP_DAILY` | 轻 |
| 「几点备份」 | 默认凌晨 3 点(按客户时区) | env `BACKUP_HOUR` / `BACKUP_TZ` | 轻 |
| 「别占太多磁盘」 | 总额度上限,超了按「坏备份→月备→周备→最老日备」顺序下线 | env `BACKUP_MAX_TOTAL_BYTES` | 轻 |
| 「备份坏了怎么办 / 别把好备份顶掉」 | 校验定级 + 好坏备份**分开算额度**,坏的永远淘汰不了好的 | 引擎内置,无旋钮 | 轻 |
| 「上周的数据没了,现在才发现」 | 靠周备/月备的时间跨度,不靠三天窗口 | 默认留 1 周备 + 1 月备 | 轻 |
| 「备份有没有在跑 / 上次什么时候备的」 | 台账 + 「连续 N 天没成功就发站内信」 | 告警已有;**看板下一轮**(现在只能查库) | 中 |
| 「我要恢复到某一天」 | 目前是运维手工 `pg_restore` 那份 dump | **未做自助恢复**,需开发 | 重 |
| 「确认备份真能恢复」 | 每周把最近一份备份真恢复进临时库再删掉,结果记在台账 | 已默认开启(`BACKUP_DRILL_*`);**看板下一轮** | 轻 |
| 「备份也要能下载下来存一份」 | 从页面下载 dump 文件 | **未做**,下一轮随设置页一起 | 中 |
| 「备份要加密」 | dump 文件本身加密存放 | **未做**,需开发 | 中 |
| 「连文件附件一起备」 | 本模块**只备数据库**,不备 uploads/ 里的附件 | 未做,需另设计 | 重 |

## 可调旋钮清单

□ 开关(轻 · 默认开)
□ 每天几点、按哪个时区(轻)
□ 保留份数:日 / 周 / 月 / 坏备份(轻 · 默认 3/1/1/2)
□ 总磁盘额度(轻 · 默认不限)
□ 落地位置:跟随「文件存储」的生效后端;超过体量上限时只落本地(轻)
□ 陈旧告警天数(轻 · 默认 2 天)
□ pg_dump/pg_restore 路径(轻 · 同机多版本 PG 客户端时用)
□ 备份状态看板 + 手动备份 + 下载(中 · 下一轮)
□ 恢复演练开关 / 周几 / 几点 / 体量上限(轻 · 默认每周日 5 点开)
□ 自助恢复 / dump 加密 / 附件一起备(重 · 未做)

## 本模块约定与边界

- **只备数据库,不备附件。** 客户说「数据备份」时往往同时想到上传的文件;`uploads/` 与 OSS 里的
  附件**不在本模块范围内**。答复客户前先确认他指的是哪一种。
- **「备份成功」不等于「验证过能恢复」——这是两个不同的标记。** 备份成功只代表 dump 跑完、
  清单读得回来、体量行数没异常突降;**每周的恢复演练**才会真恢复一遍并单独记一个结论。
  ★对客户只能说「最近一次恢复演练是 X 月 X 日通过的」,不能拿备份成功当验证过。
  还没轮到演练的那几份是「没验过」,**不是**「验过没问题」,也**不是**「验过有问题」。
- **恢复目前是人工的**:运维拿那份 `-Fc` 格式的 dump 跑 `pg_restore`。没有页面上的一键恢复。
- **两种「数据出问题」要分开谈**:库损坏(备份会失败、会告警)与数据被改错(备份照样成功)。
  后者只能靠周备/月备的时间跨度找回,所以**别把保留期压到只剩三天**。
- **备份不分租户**:一次 dump 是整个数据库。多租户部署里不能只给某一个客户单独备份/恢复。
- 上云复用「系统设置 → 文件存储」的配置,不单独填一套密钥;因此换存储后新备份自动跟着走,
  但**旧备份仍在旧位置**。
