# 模块:core/org(组织 + 权限)★地基根

> 实体定义/不变量/设计决策的真相源在 `docs/DATA_MODEL_org.md`(含双视角:上半实现层、下半客户视角)。
> 本文件是实现落点地图:改 org 时先读 DATA_MODEL_org.md,再按下表定位代码。

## 实现落点

| 内容 | 文件 |
|---|---|
| 7 张表(表结构/索引/CHECK) | `model.ts` |
| 部门树(防环/path 级联/删除保护)| `logic/department-tree.ts`(拷贝改造自 `core/db/templates/tree/`)|
| 员工(创建/编辑/Excel 导入/汇报线防环/离职/分页列表/密码哈希)| `logic/employee.ts` / `logic/employee-import.ts` |
| 自动工号规则(No.00001 递增,手工建员工与导入共用)| `logic/emp-no.ts` |
| ★员工自助头像(上传/移除,只作用于本人;**默认没有头像**)| `logic/avatar.ts` / `tests/own-avatar.test.ts` |
| ★部门负责人(须本部门在职员工;设定后本部门其余成员汇报线改指 ta)| `logic/employee.ts`(setDepartmentHead)/ `tests/department-head.test.ts` |
| 个人设置页(头像 + 修改密码 + 移动端扫码登录 + 企业邮箱,全员自助)| `ui/PersonalSettings.vue`(扫码块在 `ui/MobileQrLogin.vue`,领域逻辑/威胁模型在 `core/auth/qr-login.ts`)|
| 管理页 UI(组织及账号管理 / 角色与权限)| `ui/OrgManagement.vue` / `ui/RolePermissions.vue` |
| 角色/授权(幂等 assign/grant、权限点同步)| `logic/role.ts` |
| 护栏:导航项漏配权限 / 权限码在配置页缺中文分组 | `nav-permission-guard.ts` / `permission-grouping-guard.ts` |
| ★数据权限(多角色取最宽/超管短路/范围解析)| `logic/data-scope.ts` |
| 租户引导(租户+根部门+老板+超管,一个事务)| `logic/bootstrap.ts` |
| ★对外接口(其他模块只准 import 这个)| `api.ts` |
| 9 条不变量测试 | `tests/invariants.test.ts` |
| 数据权限测试 | `tests/data-scope.test.ts` |
| 幂等/列表契约/N+1 计数测试 | `tests/idempotency-contract.test.ts` |
| 员工 Excel 批量导入测试 | `tests/employee-import.test.ts` |

## 对外接口(api.ts,签名见文件内注释)

`getCurrentEmployee` / `getDeptSubtree` / `getLeaderChain` / `hasPermission` / `hasRole` / `listEmployeeIdsWithPermission` / `getDataScope` / `syncPermissions`(各模块启动时注册权限点)
/ `listAccountingEntities` / `resolveAccountingEntity` / `getRootEntityId` / `setDepartmentAccountingEntity` / `assertAccountingEntityAccess` / `getEmployeeAccountingEntity` / `getEmployeeAccountingProfile`(★财务多组织:账套实体)
/ `reassignEmployee` / `separateEmployee`(★hr-core 异动/离职单生效落组织的唯一口子)
/ `getEmployeeDepartment` / `getEmployeeNames` / `employeeNamesByIds` / `employeeBriefsByIds`(批量姓名/头像展示,防 N+1)

业务模块数据过滤**只准**调 `getDataScope`,拿到已解析的最终结果(部门 id 已展开),禁止自己实现权限。

★**「谁该收到」用 `listEmployeeIdsWithPermission`,别自己遍历员工逐个 `hasPermission`。**
后者是 N+1(员工上百就是上百次查询),而且循环里单人失败只能就地吞掉 ——
「收件人被系统性算错」会表现成通知悄悄少发给一批人,日志里一个字都没有。

## 关键不变量(改动不能破坏,详见 DATA_MODEL_org §2)

1. path 与 parent_id 链一致(可重算对账)
2. 租户隔离不可越界
3. 离职员工不被删除(status=left)
4. 密码永不明文(bcrypt)
5. 工号租户内唯一(库层部分唯一索引)
6. 部门树无环
7. 汇报链无环
8. 无孤儿员工(在职员工的部门必未删)
9. 部门迁移后整棵子树 path 级联更新
10. ★财务独立核算嵌套约束:根部门恒为独立核算且不可关闭;非根独立核算节点的子树内不得再有独立核算节点
    (= 独立核算节点的真祖先除根外不得为独立核算)。见 `tests/accounting-entity.test.ts`

## 实现层决策备忘(库层之外的约定)

- 防环校验是"读后写",并发可成环 → 树/汇报线写操作在事务内取 per-tenant `pg_advisory_xact_lock` 串行化
- 唯一约束用部分唯一索引(`where is_deleted = false`):软删后工号/手机号/角色码可复用
- 关联表(employee_roles/role_permissions)带 tenant_id;撤销授权 = 物理删行(授权状态非业务数据),留痕将归 document 的 OperationLog
- 超管短路 = tenant.owner_employee_id 本人 **或** 持内置 `superadmin` 角色(`is_builtin=true`)
- CUSTOM 数据范围预留未实现(决策3):授了 CUSTOM 等于没授(不参与取最宽)
- tenant.owner_employee_id ↔ employee 互为鸡蛋,无库层 FK,靠 bootstrapTenant 事务 + 测试兜底
- Employee.position 是组织页基础岗位名称,用于员工展示/导入;不等同 hr-core 的职位等级或任职历史
- 工号选填:新建员工/Excel 导入留空时由 `logic/emp-no.ts` 按「租户内已有 `No.数字` 的最大序号 +1」生成 `No.00001`
  (自定义工号不参与序号计算);并发算出同号由唯一索引兜底 → `createEmployee` 重算重试。编辑员工仍必填(不允许改空)

# ============ 下半部:需求层(需求 agent 用)============

> 深度真相在 `docs/DATA_MODEL_org.md` 的客户视角半;这里是给 AI 需求助手的对话弹药摘要。

## 客户会怎么称呼这个模块的事

组织架构、部门、员工、账号、开账号、角色、权限、开权限/收权限、数据权限、只看自己的、汇报关系、上级、工号、重置密码、离职、复职、超级管理员、多公司/账套、独立核算

## 业务概念词典(客户大白话 → 系统位置)

| 客户会说 | 真实含义 | 对应系统位置 | 代价 |
|---|---|---|---|
| 「加个部门/调组织架构」 | 部门树增删改/移动/停用,子树 path 自动级联 | 组织及账号管理 · 部门树(可搜索) | 轻 |
| 「新增员工/开账号」 | 员工=登录账号(一体,不拆 User);新建时选岗位走人事入职流水线;工号选填,留空自动生成 No.00001 | 组织及账号管理 | 轻 |
| 「批量导员工」 | Excel 导入(有模板下载) | 组织及账号管理 · 导入 | 轻 |
| 「他忘密码了」 | 管理员重置密码(密码只存哈希,永不明文) | 组织及账号管理 · 重置密码 | 轻 |
| 「我要改自己的密码」 | 自助改密(验原密码,只改本人)`changeOwnPassword` → `POST /api/me/change-password`(只需登录、无权限点) | 右上角用户名菜单 → 个人设置 · 修改密码 | 轻 |
| 「我要换个头像」 | 自助传头像 `POST /api/me/avatar` / 移除 `DELETE`(只作用于本人,管理员也改不了别人的)。**不设就是没有** —— 显示姓名前两字,系统不分配 | 右上角用户名菜单 → 个人设置 · 头像 | 轻 |
| 「给某人开/收权限」 | 建角色→勾权限点→给员工挂角色(可多角色) | 角色与权限 + 组织及账号管理 | 轻 |
| 「让他只看自己的/本部门的」 | 数据范围:ALL/本部门及下级/本部门/仅本人,挂在每个权限点上 | 角色与权限 · 权限矩阵 | 轻/中 |
| 「设汇报关系/上级」 | 汇报线(防环),审批找上级用它 | 组织及账号管理 · 设置上级 | 轻 |
| 「设个部门主管/负责人」 | 部门负责人(须本部门在职员工);设定后本部门其余成员上级自动改指 ta,ta 自己指向上级部门负责人 | 组织及账号管理 · 员工行「设为负责人」 | 轻 |
| 「员工离职」 | status=left 不删除,登录随即失效;下属可转移给新上级。★离职即自动回收全部角色(组织页直接离职与人事离职单同口径,同一事务) | 组织及账号管理 · 离职 | 轻 |
| 「离职的人回来了」 | 复职(恢复在职);角色已在离职时回收,需重新分配;直属上级也需重设 | 组织及账号管理 · 复职 | 轻 |
| 「手机 APP 怎么登录/换手机了」 | PC 出二维码→手机扫→PC 端确认才签令牌;「我的登录设备」台账可踢单台下线 | 个人设置 · 移动端扫码登录 | 轻 |
| 「给他调岗/晋升」 | 岗位权威在人事,组织页只展示;调岗走人事异动单 | 人事 → 员工花名册 · 异动 | 轻 |
| 「按公司/分公司分开做账」 | 部门标「财务独立核算」=一套账;标题栏可切换账套 | 组织及账号管理 · 部门编辑 | 中 |
| 「误建了个人,删掉」 | 仅未开通登录的误建员工可删;正式员工只能走离职 | 组织及账号管理 | 轻 |

## 可调旋钮清单

□ 部门树结构(轻 · 增减/移动/停用,自动级联;空部门可物理删除,删除有保护)
□ 角色与权限点分配(轻 · 权限矩阵按模块分组勾选)
□ 数据权限范围(轻/中 · 每权限点四档;多角色取最宽 + 超管短路)
□ 员工字段/Excel 导入模板(轻)
□ 新建/导入员工的默认登录密码(轻 · 建员工页可看可改,org:manage;出厂 changeMe@6am)
□ 部门负责人(轻 · 员工行一键设定,整部门汇报线自动重指)
□ 独立核算节点/账套(中 · 财务多组织;根恒为账套且不可关,非根独立核算子树内不得再套)
□ 自定义数据范围 CUSTOM(重 · 预留未实现,授了等于没授)

## 本模块约定与边界

- **账号口径**:员工即账号(单层,不拆 User/Person);离职不删除(留痕),在职复核让其登录失效;离职即回收全部角色(`markEmployeeLeft` 事务内,组织页直接离职与人事离职单 `separateEmployee` 同口径),复职不自动恢复、需重新分配;工号租户内唯一,密码只存 bcrypt 哈希。
- **权限口径**:功能权限(能不能做,按角色勾权限点)与数据权限(能看到谁的数据)正交;数据范围四档 ALL/DEPT_AND_SUB/DEPT/SELF 挂在权限点上,多角色取最宽,超管(租户 owner 或内置 superadmin 角色)一律放行。所有业务模块的数据过滤统一调 org 的 getDataScope,不各自实现。
- **岗位边界**:岗位/职级/任职历史的权威在 hr-core(人事);「组织及账号管理」页只组合展示当前岗位(无人事权限时降级显示文本),新建员工带岗位=触发人事入职流水线,改岗位必须走人事异动单。
- **审计边界**:本页所有增删改自动进「审计日志」(audit 模块中间件留痕),org 自己不做操作日志。
- **护栏**:新菜单必须注册权限点或进白名单,nav-permission-guard 自动扫描兜底(开发期红线,客户无感)。

## 聊需求时要主动追问的点

- 组织分几级?权限按角色批量给还是逐人?
- 谁能看哪些数据:本人 / 本部门 / 本部门及下级 / 全部?
- 有没有多公司/多账套要分开核算?汇报关系要不要维护(影响审批找人)?

## 改动代价速查

- 轻(配置级):部门增减、角色/权限分配、数据范围选择、员工导入、离职复职
- 中(结构/策略):独立核算账套结构、跨部门数据范围策略
- 重(动模型/未实现):CUSTOM 自定义数据范围、身份模型拆分
