# 模块:feature-toggle(功能开关 —— 整租户下架功能,前端隐藏口径)

租户级「功能开关」:管理员在 **系统设置 → 功能开关** tab 里,用 checkbox 开关**菜单组 / 菜单 / 功能**。
关闭的功能对**所有用户**从导航消失、从「角色与权限」页消失。

## 关键不变量

1. **缺省即启用**:`feature_toggles` 无行 = 启用;关闭写一行 `enabled=false`。禁用集 = `enabled=false` 的 `feature_key`。
2. **三类 key**:`group:<组key>` / `menu:<菜单key>` / `perm:<权限码>`(格式 `^(group|menu|perm):[\w:.-]+$`)。
   `group`/`menu` 的 key 取自 `src/nav-catalog.ts`;`perm` 取自权限目录(`apiListPermissionCatalog`)。
3. **防自锁**:`PROTECTED_KEYS`(系统管理组 / 系统设置 / 账号管理 / 角色权限 / 对应权限码)永不可关闭——
   服务端 `setToggle` 硬拒(`PROTECTED_KEY` 409),前端 checkbox 也置灰。
4. **纯前端口径**:本模块只做存储 + 读取,**不参与后端鉴权**(不改 `hasPermission`)。隐藏发生在:
   - 导航:`App.vue` 的 `groups` 过滤掉禁用的 `group:`/`menu:`/(菜单关联的)`perm:`(对所有人含超管)。
   - 权限页:`RolePermissions.vue` 从目录剔除禁用的 `perm:`。
   - 功能按钮:`client.ts` 的 `apiMyPermissions` 对**非超管**减去禁用的 `perm:` 码(超管 codes=null 不减,按钮仍显示)。
   ⚠️ 代价:关闭功能的**后端接口仍可调用**;**超管功能按钮仍可点且能用**(无 403)。要真拦截需另做后端改动。

## 表

- `feature_toggles`:commonFields + `feature_key`(text)+ `enabled`(bool,默认 true)。唯一 `(tenant_id, feature_key)`。

## 路由

- `GET /api/feature-toggles` → `{ disabledKeys }`(任意登录用户,导航要用)。
- `PUT /api/feature-toggles` body `{ key, enabled }`(需 `feature-toggle:manage`)。

## 权限

- `feature-toggle:manage`(module 归 `app-settings`,在「角色与权限」页落「系统管理」分组)。

# ============ 下半部:需求层(需求 agent 用)============

## 客户会怎么称呼这个模块的事
功能开关、模块开关、隐藏菜单、关掉某个功能、精简系统、这个客户不用的功能藏起来、菜单太多想删

## 业务概念词典
| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「我们用不到进销存,别让员工看到」 | 关闭 `menu:inventory`,导航对所有人消失 | 「系统设置」页 → 功能开关 tab 勾掉 | 轻 |
| 「整个财务模块先不上」 | 关闭 `group:finance-mgmt`(整组菜单) | 功能开关 tab 分组勾掉 | 轻 |
| 「这个按钮不想让人点」 | 关闭对应 `perm:xxx`,非超管按钮隐藏、权限页也不再出现该项 | 功能开关 tab 功能区勾掉 | 轻 |
| 「怎么超管还能点/后端还能调」 | 纯前端隐藏口径,不做后端拦截 | 见下方约定 | 中 |
| 「设置页怎么关不掉」 | 核心入口防自锁,永不可关 | PROTECTED_KEYS,checkbox 置灰 | — |

## 可调旋钮清单
□ 开/关任一菜单组/菜单/功能(轻 · 系统设置→功能开关 tab,即时生效,缺省全启用)
□ 谁能改开关(轻 · feature-toggle:manage 权限;读取禁用集任何登录用户都行)
□ 防自锁清单(中 · PROTECTED_KEYS 改代码)

## 本模块约定与边界
- ★**关键口径:只做前端隐藏,不做后端 403**。三类 key:`group:<组>` / `menu:<菜单>` / `perm:<权限码>`;隐藏发生在导航过滤(对所有人含超管)、角色权限页剔除、非超管的按钮权限集减除。关闭后**后端接口仍可调用、超管的功能按钮仍可点且能用**——客户要"关了后端也拦",是另一档需求(改 core 鉴权,中)。
- **防自锁**:系统管理组/系统设置/账号管理/角色权限及对应权限码(PROTECTED_KEYS)永不可关——服务端硬拒(PROTECTED_KEY 409),前端 checkbox 也置灰,双保险。
- 开关入口不在独立菜单页,在「系统设置」页的功能开关 tab;租户级统一,不能按角色/部门分别配(那是重改动)。
- 与角色权限的边界:权限管"谁能用",功能开关管"这租户整体要不要露出";按人/角色收权限找「角色与权限」页,整租户下架功能才用本模块。

## 改动代价速查
- 轻:开关某菜单组/菜单/功能(即时生效,前端隐藏)
- 中:要「关了后端也拦」(hasPermission 接入禁用集,改 core)
- 重:按角色/按部门分别配开关(现在是租户级统一)
