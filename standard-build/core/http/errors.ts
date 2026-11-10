// core/http/errors.ts
// 业务错误 → HTTP 响应的唯一映射点。
// ★质量红线:错误响应只含 {error:{code,message[,fields]}},绝不把堆栈/SQL 漏给前端。
// zod 校验错误 → 422 且带字段路径(支撑前端"错误定位到字段")。
import { ZodError } from 'zod'
import { AuthError } from '../auth/errors'

export type HttpErrorBody = {
  error: { code: string; message: string; fields?: { path: string; message: string }[] }
}

type Mapped = { status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 504; body: HttpErrorBody }

/** 各模块业务错误的 code → HTTP 状态。新模块加错误码时在这里补一行。 */
const CODE_STATUS: Record<string, Mapped['status']> = {
  // 401 未认证
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  // 429 太频繁(登录失败锁定;message 刻意不说是哪个维度锁的)
  TOO_MANY_ATTEMPTS: 429,
  // 403 已认证但不允许
  EMPLOYEE_NOT_ACTIVE: 403,
  TENANT_SUSPENDED: 403,
  FORBIDDEN: 403,
  ACCOUNTING_ENTITY_FORBIDDEN: 403,
  SELF_APPROVAL: 403,
  NOT_ELIGIBLE: 403,
  NOT_SUBMITTER: 403, // 审批撤回只能由发起人操作
  NOT_OWNER: 403, // messenger:仅群主可做(改群名/移出成员)
  SUPERADMIN_GRANT_FORBIDDEN: 403, // 内置超管角色只能由超管本人授出(org:manage 不够)
  ASKAI_CAPABILITY_DISABLED: 403, // AM-107:Ask AI 命中「对助手全局关闭的能力」(EXCLUDED_MODULES),区别于普通业务 403
  // 404
  NOT_FOUND: 404,
  QR_TICKET_INVALID: 404, // 扫码登录:票不存在/已过期/已用过(公开端点,刻意不区分)
  DOC_NOT_FOUND: 404,
  INSTANCE_NOT_FOUND: 404,
  PARENT_NOT_FOUND: 404,
  FLOW_NOT_FOUND: 404,
  STEP_NOT_FOUND: 404,
  DELEGATE_NOT_FOUND: 404,
  PERMISSION_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404, // messenger:会话不存在**或不是成员**(刻意同码,不泄露存在性)
  // 409 与当前状态冲突
  AMBIGUOUS_TENANT: 409,
  CYCLE_DETECTED: 409,
  DEPT_HAS_ACTIVE_EMPLOYEES: 409,
  DEPT_HAS_CHILDREN: 409,
  EMPLOYEE_HAS_LOGIN: 409,
  EMPLOYEE_HAS_SUBORDINATES: 409,
  EMPLOYEE_IS_OWNER: 409,
  BUILTIN_ROLE_PROTECTED: 409,
  PROTECTED_KEY: 409, // 功能开关:核心入口不可关闭
  NESTED_ACCOUNTING_ENTITY: 409, // 独立核算节点嵌套(祖先/子孙已是实体)
  ROOT_ENTITY_LOCKED: 409, // 根部门账套不可关闭
  ENTITY_HAS_BOOKS: 409, // 实体已有账务数据,不可取消独立核算
  ALREADY_DECIDED: 409,
  FLOW_IN_USE: 409, // 审批流有在途实例,不可删除/改动步骤
  PERIOD_CLOSED: 409,
  POSTED_IMMUTABLE: 409,
  ALREADY_REVERSED: 409,
  SYSTEM_VOUCHER_NO_REVERSE: 409, // 系统结转/计提凭证不能整张红冲
  NOT_POSTED: 409,
  OVER_SETTLE: 409,
  ACCOUNT_HAS_ENTRIES: 409,
  ACCOUNT_HAS_CHILDREN: 409,
  CONFLICT: 409, // 通用唯一冲突(hr 岗位 code/职级 level 等)
  INVALID_TRANSITION: 409, // 单据状态机非法流转(reimbursement/hr-core 异动单)
  NOT_APPROVED: 409, // 单据未审批通过不可生效(reimbursement/hr-core)
  INSUFFICIENT_STOCK: 409, // 进销存:出库/盘亏不可造成负库存
  RESOURCE_BUSY: 409, // 用章台账:印章资源已被领用
  TAX_INVOICE_DUPLICATE: 409, // 发票池:同代码+号码重复登记
  TAX_INVOICE_ALREADY_LINKED: 409, // 发票池:一张票已挂单
  NOT_REVIEWED: 409, // 凭证审核流:手工凭证未审核不可过账
  SELF_REVIEW_FORBIDDEN: 409, // 凭证审核流:审核人不能是制单人
  TEMPLATE_ACTIVE_EXISTS: 409, // 同一账套的同来源/场景/会计处理仅允许一张启用模板
  TEMPLATE_REVISION_CONFLICT: 409, // 模板乐观锁冲突
  BUSINESS_VOUCHER_REVISION_CONFLICT: 409, // 业务凭证乐观锁冲突
  BUSINESS_VOUCHER_SOURCE_NOT_READY: 409, // 来源单据未到允许生成业务凭证的终态
  BUSINESS_VOUCHER_CLOSING_BLOCKED: 409, // 关账前仍有来源业务凭证待处理
  BUDGET_EXCEEDED: 409, // 预算控制:报销确认累计已用+本单超部门预算(M4 硬拦截)
  // AI 网关(tingly-box):它是**新增的对外依赖**,连不上/没配是可预期状态,
  // 不能一路抛成 500 —— 用户只会看到「系统错误」,既不知道网关挂了也不知道去哪配。
  // ★用 400 而不是 502/503:本表的状态码是封闭集合,而且仓里既有的外部依赖失败
  //   (SMTP_SEND_FAILED / im-connect 的 TOKEN_FAILED / LLM_NOT_CONFIGURED)一律是
  //   「400 + 一句人话」。跟先例走,不为这一个模块扩状态码集合。
  // ★带 GATEWAY_ 前缀:`NOT_CONFIGURED` 已被 notify 占用。同一个 key 只能有一个状态码,
  //   不加前缀会被后面那条静默覆盖 —— 而且不会有任何报错。
  GATEWAY_NOT_CONFIGURED: 400, // 服务器还没设 TB_BASE_URL / TB_USER_TOKEN
  GATEWAY_UNREACHABLE: 400, // 网关连不上(超时/拒连)
  GATEWAY_UNAUTHORIZED: 400, // 管理令牌被网关拒(我们与网关之间的事,不是用户没登录)
  GATEWAY_UPSTREAM: 400, // 网关返回的业务错误
  // 400 输入/业务规则
  INVALID_INPUT: 400,
  NOT_GROUP: 400, // messenger:群操作用在单聊上
  PUSH_TOKEN_INVALID: 400, // 移动推送:设备令牌格式不对
  WRONG_PASSWORD: 400, // 自助改密:原密码不正确
  ENTITY_REQUIRED: 400, // finance 上下文缺账套实体
  ACCOUNTING_ENTITY_REQUIRED: 400, // 历史业务单据未认领账套，不能继续财务处理
  UNBALANCED: 400,
  NOT_LEAF_ACCOUNT: 400,
  PARTNER_REQUIRED: 400,
  AUX_REQUIRED: 400, // 科目辅助核算强制:分录缺必填维度(往来单位/部门/项目…)
  ATTACHMENT_REQUIRED: 400, // 账套开关:凭证须填附单据(附件)
  CASHFLOW_TAG_REQUIRED: 400, // 账套开关:触现金科目凭证对方科目须标现金流量类别
  TEMPLATE_NOT_FOUND: 400,
  DOC_TYPE_NOT_REGISTERED: 400,
  NO_APPROVER: 409,
  // feedback:LLM 配置/调用(message 是给人看的提示,非密钥)
  LLM_NOT_CONFIGURED: 400,
  LLM_ERROR: 400,
  KEY_STORE_UNAVAILABLE: 400,
  // core/storage:文件存储配置/上传下载(message 是给人看的提示,不含密钥)
  STORAGE_NOT_CONFIGURED: 400,
  STORAGE_PROVIDER_ERROR: 500,
  // lead-intake-email:邮箱线索渠道(IMAP 连接失败 = 配置/网络问题)
  IMAP_CONNECT_FAILED: 400,
  // lead-intake-email:员工邮箱 + 线索邮件往来(message 是给人看的提示,不含凭证)
  MAIL_ACCOUNT_MISSING: 400, // 当前员工未配置企业邮箱
  MAIL_SERVER_UNKNOWN: 400, // 无法推断邮箱服务器且未手填
  LEAD_NO_EMAIL: 400, // 线索无邮箱,不可发信
  SMTP_SEND_FAILED: 400, // 发信失败(服务器/授权密码问题)
  // notify:通知渠道配置/发送(message 是给人看的提示,不含凭证)
  NOT_CONFIGURED: 400,
  SEND_FAILED: 400,
  // im-connect:企业微信/钉钉/飞书 接入(message 是给人看的提示,不含凭证/access_token)
  NOT_BOUND: 400, // 目标员工未与该平台账号绑定,且无法按手机号自动解析
  TOKEN_FAILED: 400, // 获取平台 access_token 失败(凭证错误/网络)
  RESOLVE_FAILED: 400, // 按手机号反查平台 userid 失败
  // license:授权强制(本地化部署)
  LICENSE_EXPIRED: 403,
  LICENSE_SEAT_LIMIT: 403,
  LICENSE_INVALID: 403,
  LICENSE_FEATURE: 403,
  // website:官网公开面(访客登录失败泛化防枚举;限流/开关拒绝)
  WEBSITE_LOGIN_FAILED: 401,
  WEBSITE_TOKEN_INVALID: 401,
  WEBSITE_TOKEN_EXPIRED: 401,
  WEBSITE_LOGIN_LOCKED: 403,
  WEBSITE_DISABLED: 403,
  WEBSITE_RATE_LIMITED: 403,
  WEBSITE_LEAD_REQUIRED: 403,
  // pcb-cam:PCB CAM 工程自动化(worker 调用失败不经 HTTP 抛出,记进 stage_runs)
  PCB_JOB_NOT_FOUND: 404, // 项目/任务不存在或不在数据范围(同码,不泄露存在性)
  PCB_INVALID_STATE: 409, // 当前状态不允许该操作
  PCB_EQ_PENDING: 409, // 还有未决策的问题点
  PCB_LAYERS_UNCONFIRMED: 409, // 层识别未确认
  PCB_UPLOAD_INVALID: 422, // 上传文件不合规
  PCB_PROFILE_INVALID: 422, // 工厂标准 YAML 不合 schema
  PCB_WORKER_BUSY: 504, // 引擎没在时限内响应(层预览等同步调用)
  PCB_LAYER_NOT_READY: 404, // 该层/该副本还没生成(拼板未跑就看工作板层)
  PCB_NO_ARTIFACTS: 404, // 这个任务还没有可打包的成果物
}

/**
 * 业务错误码 → 给用户看的一句人话:**发生了什么 + 下一步该干什么**。
 *
 * ★为什么必须有(2026-08-10 线上):销售在飞书说「今天跟进 XX,做了机房需求评估…」,
 *   助手第一步「认领线索」撞上「线索在待分配池」,用户看到的是「执行失败,请稍后重试」。
 *   他既不知道发生了什么(线索不归他),也不知道下一步该干什么(找管理员分配;而跟进其实照样能记),
 *   于是只能反复重说 —— 每重说一次就多一份重复档案。
 *
 * ★这不是个例:全仓 1528 处业务错误里 **762 处 message 是英文技术串**
 *   (`lead is in pending-assignment pool; use assign instead` / `only draft can be edited`),
 *   而 mapError 把 message 原样发给前端。「调用失败」和一句看不懂的英文,对用户是同一件事。
 *
 * ★口径:message 里有中文 → 原样用(那 766 处本来就是写给人看的,而且比通用文案更具体);
 *   没有中文 = 技术串 → 换成本表的人话。**新增错误码必须在这里补一行**,
 *   `core/http/tests/errors.test.ts` 有护栏:CODE_STATUS 有而这里没有,直接红。
 */
const CODE_HINT: Record<string, string> = {
  // ── 登录/会话 ──
  TOKEN_INVALID: '登录状态无效,请重新登录。',
  TOKEN_EXPIRED: '登录已过期,请重新登录。',
  INVALID_CREDENTIALS: '手机号或密码不对,请重新输入。',
  TOO_MANY_ATTEMPTS: '失败次数过多,已临时限制登录,请过一刻钟再试。',
  EMPLOYEE_NOT_ACTIVE: '这个员工账号已离职或被停用,不能再操作。如果是你本人,请联系管理员。',
  TENANT_SUSPENDED: '你所在的企业账号已停用,请联系管理员。',
  AMBIGUOUS_TENANT: '这个手机号在多家企业下都有账号,请先选择要登录哪一家。',
  WRONG_PASSWORD: '原密码不正确,请重新输入。',
  // 扫码登录:三种情形(不存在/已过期/已用过)共用这一句 —— 端点是公开的,
  // 分开说等于给了一个「这串是不是有效票」的探针。人要做的事三种都一样:去电脑上换一张。
  QR_TICKET_INVALID: '这个二维码无效或已过期,请在电脑上刷新后重新扫码。',
  // ── 权限 ──
  FORBIDDEN: '你没有做这件事的权限。需要的话,找管理员在「角色权限」里给你开一下。',
  SELF_APPROVAL: '不能审批自己提交的单据,请转交给其他审批人。',
  NOT_ELIGIBLE: '你不在这件事的可操作范围内(通常是审批人/负责人另有其人)。',
  NOT_SUBMITTER: '只有发起人本人才能撤回这条审批。',
  NOT_OWNER: '只有群主能做这个操作(改群名或移出成员)。',
  NOT_GROUP: '这个操作只适用于群聊,单聊里没有它。',
  ASKAI_CAPABILITY_DISABLED: '这项能力已被管理员对 AI 助手全局关闭,你自己在对应页面里操作不受影响。',
  PERMISSION_NOT_FOUND: '这个权限项不存在(多半是版本升级后旧的权限码没清理),请联系管理员。',
  LICENSE_EXPIRED: '系统授权已到期,请联系管理员续期。',
  LICENSE_SEAT_LIMIT: '已达授权的人数上限,新增用户前请先停用不用的账号或联系管理员扩容。',
  LICENSE_INVALID: '系统授权无效,请联系管理员。',
  LICENSE_FEATURE: '当前授权不含这个功能模块,请联系管理员。',
  ACCOUNTING_ENTITY_FORBIDDEN:
    '你的数据范围里没有这个账套。账套之间是各自独立的一套账,能看哪一套由「角色权限」里的数据范围决定 —— 切回自己的账套,或者找财务管理员开一下。',
  // ── 找不到 ──
  NOT_FOUND: '没找到这条记录 —— 可能已经被删除,或者你没有查看它的权限。刷新一下再试。',
  DOC_NOT_FOUND: '没找到这份单据,可能已被删除或撤回。',
  INSTANCE_NOT_FOUND: '没找到这条审批实例,可能已被撤回或删除。',
  PARENT_NOT_FOUND: '找不到它的上级节点,可能刚被别人删掉了,刷新一下再试。',
  FLOW_NOT_FOUND: '没找到对应的审批流程,请让管理员在「审批流程」里配一条。',
  STEP_NOT_FOUND: '没找到这个审批节点 —— 多半是这单在途时管理员改了流程。请让管理员看一下该流程,或把这单撤回重提。',
  DELEGATE_NOT_FOUND: '没找到这条代理设置,可能已被取消,或者它不是你的。',
  CONVERSATION_NOT_FOUND: '没找到这个会话 —— 可能已被解散,或者你不在其中。',
  TEMPLATE_NOT_FOUND: '没找到对应的模板,请让管理员先配置模板。',
  DOC_TYPE_NOT_REGISTERED: '这类单据还没接入审批,请联系管理员配置。',
  NO_APPROVER: '这条流程没有可用的审批人(通常是审批人已离职或部门负责人空着),请让管理员补上再提交。',
  // ── 会计凭证模板 / 业务凭证 ──
  TEMPLATE_ACTIVE_EXISTS:
    '同一个账套里,同来源单据 + 同场景 + 同会计处理只能有一张启用中的凭证模板。先把原来那张停用,再启用这张。',
  TEMPLATE_REVISION_CONFLICT: '这张模板刚被别人改过,你手上的还是旧版本。刷新看看最新内容,确认无误再提交。',
  BUSINESS_VOUCHER_REVISION_CONFLICT: '这张业务凭证刚被别人处理过,你手上的还是旧版本。刷新看最新状态再操作。',
  BUSINESS_VOUCHER_SOURCE_NOT_READY:
    '来源单据还没走到可以出凭证的状态(比如报销单还没「确认完成」)。先把来源单据办完,再回来生成业务凭证。',
  ACCOUNTING_ENTITY_REQUIRED:
    '这一步得先定下是哪套账。要么你现在没选账套(在标题栏切一下),要么这张单是启用多账套之前的历史单、还没认领账套 —— 后者需要财务先在单据上完成账套认领,才能继续做财务处理。',
  BUSINESS_VOUCHER_CLOSING_BLOCKED:
    '本期还有来源单据的业务凭证没处理完。这时候关账会把它们永远挡在这一期的账外,所以先按提示里列出的那几张办完(生成凭证或作废),再来关账。',
  // ── 状态冲突 ──
  CONFLICT: '这条记录的当前状态和你的操作对不上 —— 多半是别人刚改过,或它已经被处理了。刷新看看最新状态再试。',
  INVALID_TRANSITION: '这条单据现在的状态不允许这个操作(比如已提交/已审批的单不能再改)。刷新看看它当前的状态。',
  NOT_APPROVED: '这条单据还没审批通过,通过之后才能继续。',
  ALREADY_DECIDED: '这条审批已经被处理过了,不用再操作。',
  FLOW_IN_USE: '这条审批流还有在途的单子,现在改步骤或删掉它会让那些单子卡住。等它们走完,或先把它们撤回。',
  NOT_REVIEWED: '手工凭证要先审核才能过账。',
  SELF_REVIEW_FORBIDDEN: '凭证的审核人不能是制单人本人,请换个人审核。',
  CYCLE_DETECTED: '这样设置会让上下级绕成一个圈,请换一个上级。',
  RESOURCE_BUSY: '这枚印章已经被人领用了,等归还后再领。',
  // ── 组织/部门/员工 ──
  DEPT_HAS_ACTIVE_EMPLOYEES: '这个部门下还有在职员工,先把人调走再删。',
  DEPT_HAS_CHILDREN: '这个部门下还有子部门,先处理子部门再删。',
  EMPLOYEE_HAS_LOGIN: '这个员工已经有登录账号,不能直接删除,请先停用。',
  EMPLOYEE_HAS_SUBORDINATES: '这个员工名下还有下属,先把下属转给别人再操作。',
  EMPLOYEE_IS_OWNER: '这是企业的所有者账号,不能删除或停用。',
  BUILTIN_ROLE_PROTECTED: '这是系统内置角色,不能改名或删除;需要不同权限请新建一个角色。',
  SUPERADMIN_GRANT_FORBIDDEN: '「超级管理员」这个角色只能由超级管理员本人授出,请让现有超管来操作。',
  PROTECTED_KEY: '这是系统核心入口,不能关闭。',
  // ── 财务:账套/期间/凭证 ──
  NESTED_ACCOUNTING_ENTITY: '它的上级或下级已经是独立核算账套了,账套不能套账套。',
  ROOT_ENTITY_LOCKED: '根部门的账套不能关闭。',
  ENTITY_HAS_BOOKS: '这个账套已经有账务数据,不能再取消独立核算。',
  ENTITY_REQUIRED: '请先在页面右上角选择要操作哪个账套,再试一次。',
  PERIOD_CLOSED: '这个会计期间已经结账,不能再改动。要改的话请先让财务反结账。',
  POSTED_IMMUTABLE: '已过账的凭证不能修改,需要更正请做一张红字凭证冲回。',
  ALREADY_REVERSED: '这张凭证已经冲回过了,不用再冲。',
  SYSTEM_VOUCHER_NO_REVERSE: '这是系统自动生成的结转/计提凭证,不能整张红冲 —— 请修正来源数据后重新计提/结转,或在开放期间做一张调整凭证。',
  NOT_POSTED: '这张凭证还没过账,过账之后才能做这个操作。',
  UNBALANCED: '凭证借贷不平,请检查各行金额后再保存。',
  NOT_LEAF_ACCOUNT: '只能选最末级科目,请展开后选下一级。',
  PARTNER_REQUIRED: '这个科目要求填往来单位,请补上。',
  AUX_REQUIRED: '这个科目有必填的辅助核算维度(往来单位/部门/项目等),请补齐再保存。',
  ATTACHMENT_REQUIRED: '账套要求凭证必须附单据,请上传附件后再保存。',
  CASHFLOW_TAG_REQUIRED: '涉及现金科目的凭证,对方科目要标现金流量类别,请补上。',
  ACCOUNT_HAS_ENTRIES: '这个科目已经有凭证分录,不能删除;不用了可以停用它。',
  ACCOUNT_HAS_CHILDREN: '这个科目下还有子科目,先处理子科目再删。',
  OVER_SETTLE: '核销金额超过了单据的未核销余额,请核对金额。',
  BUDGET_EXCEEDED: '这笔报销会让部门累计支出超出预算,需要先调预算或拆分申请。',
  TAX_INVOICE_DUPLICATE: '这张发票(相同代码+号码)已经登记过了,不用重复录入。',
  TAX_INVOICE_ALREADY_LINKED: '这张发票已经挂在别的单据上了,一张票只能挂一单。',
  // ── 进销存(base 是轻量库存台账,没有仓库物理删除那套码)──
  INSUFFICIENT_STOCK: '库存不够,这样出库会变成负库存。请先核对现有库存或先入库。',
  // ── 输入 ──
  INVALID_INPUT: '填写的内容不符合要求,请检查后重新提交。',
  PUSH_TOKEN_INVALID: '这台设备的推送标识无效,请在 App 里重新开一次通知权限。',
  // ── AI / 大模型 / 网关 ──
  LLM_NOT_CONFIGURED: '还没配置 AI 大模型,请到「系统设置 → AI 大模型」里填好服务商和密钥。',
  LLM_ERROR: '调用大模型失败了。请稍后重试;一直失败就到「系统设置 → AI 大模型」检查配置。',
  KEY_STORE_UNAVAILABLE: '服务器还没配置密钥加密所需的环境变量,密钥暂时存不了,请联系管理员。',
  GATEWAY_NOT_CONFIGURED: '服务器还没配置 AI 网关地址和令牌,请联系管理员。',
  GATEWAY_UNREACHABLE: 'AI 网关连不上(超时或拒绝连接),请稍后重试或联系管理员检查网关。',
  GATEWAY_UNAUTHORIZED: 'AI 网关拒绝了我们的令牌,请联系管理员更新网关配置。',
  GATEWAY_UPSTREAM: 'AI 网关返回了一个错误,请稍后重试;一直这样就联系管理员看网关日志。',
  // ── 存储 / 邮件 / 通知 / IM ──
  STORAGE_NOT_CONFIGURED: '还没配置文件存储,请让管理员在系统设置里配好再上传。',
  STORAGE_PROVIDER_ERROR: '文件存储服务出错了,已记录日志。请稍后重试。',
  IMAP_CONNECT_FAILED: '连不上邮箱服务器,请检查邮箱地址、授权码和服务器地址是否填对。',
  MAIL_ACCOUNT_MISSING: '你还没配置企业邮箱,请先到「我的邮箱」里配好再发信。',
  MAIL_SERVER_UNKNOWN: '认不出这个邮箱的服务器地址,请手动填写收发信服务器。',
  LEAD_NO_EMAIL: '这条线索没有邮箱地址,补上之后才能发信。',
  SMTP_SEND_FAILED: '邮件没发出去,多半是邮箱服务器或授权码的问题,请检查邮箱配置。',
  NOT_CONFIGURED: '这个通知渠道还没配置,请让管理员先配好。',
  SEND_FAILED: '通知没发出去,请稍后重试或检查渠道配置。',
  NOT_BOUND: '这位同事还没绑定对应的企业 IM 账号,也没法用手机号自动认出来,请先在「消息接入」里绑定。',
  TOKEN_FAILED: '拿不到企业 IM 的访问凭证,请检查应用 ID 与密钥是否填对。',
  RESOLVE_FAILED: '按手机号在企业 IM 通讯录里没查到这个人,请确认手机号一致或改用手动绑定。',
  // ── 官网公开面 ──
  WEBSITE_LOGIN_FAILED: '登录失败,请检查填写的信息。',
  WEBSITE_TOKEN_INVALID: '登录状态无效,请重新登录。',
  WEBSITE_TOKEN_EXPIRED: '登录已过期,请重新登录。',
  WEBSITE_LOGIN_LOCKED: '尝试次数过多,账号已被临时锁定,请稍后再试。',
  WEBSITE_DISABLED: '这个功能当前未开放。',
  WEBSITE_RATE_LIMITED: '操作太频繁了,请过一会儿再试。',
  WEBSITE_LEAD_REQUIRED: '请先留下联系方式再继续。',
  // ── pcb-cam ──
  PCB_JOB_NOT_FOUND: '没找到这个 CAM 任务 —— 可能已被删除,或者你没有查看权限。',
  PCB_INVALID_STATE: '任务当前的状态不允许这个操作,请刷新页面看看它现在处于哪一步。',
  PCB_EQ_PENDING: '还有问题点没有决策,把每一条都处理完(接受修复 / 忽略 / 转人工 / 问客户)才能继续。',
  PCB_LAYERS_UNCONFIRMED: '层识别结果还没确认,请先在「层确认」页核对每个文件对应的层,再继续。',
  PCB_UPLOAD_INVALID: '上传的资料不合规:需要一个包含 Gerber/钻孔文件的压缩包,附件只能是 PDF、Excel 或图片。',
  PCB_PROFILE_INVALID: '工厂标准配置格式不对,请按提示修正 YAML 后再保存。',
  PCB_WORKER_BUSY: '引擎正忙(可能在跑别的任务),这一层没能及时画出来;过一会儿再点一次。',
  PCB_LAYER_NOT_READY: '这一层还没生成 —— 对应的步骤还没跑到,或者这一层不出这个副本。',
  PCB_NO_ARTIFACTS: '这个任务还没有可以打包的成果物 —— 钻带在「钻孔」后出现,生产版 Gerber / 锣带在「输出」后出现。',
  // ── 非 CODE_STATUS 里的:mapError 自己产的几个 ──
  VALIDATION: '提交的内容有字段不符合要求,下面标出了具体是哪几个。',
  DUPLICATE: '已经有一条相同的记录了,不用重复添加。',
  CONSTRAINT_VIOLATION: '提交的数据不满足系统的完整性要求(比如引用了一条已被删除的记录),请检查后重试。',
  INTERNAL: '系统内部出错了,已经记下日志。这不是你操作的问题,请稍后再试;如果一直这样,把这句话发给管理员。',
}

// 中文判定:message 里有汉字 = 本来就是写给人看的,直接用它(比按 code 查的通用文案更具体)。
const HAS_HAN = /\p{Script=Han}/u

/**
 * 业务错误 → 用户看得懂的一句话。给 HTTP 响应和 AI 助手共用。
 * ★兜底也要**说清这不是系统故障**并带上 code:用户知道该找谁、支持同学知道该查哪。
 */
export function humanizeError(code: string | undefined, message: string): string {
  if (HAS_HAN.test(message)) return message
  const hint = code ? CODE_HINT[code] : undefined
  if (hint) return hint
  if (code) return `这个操作没能完成(${code})。这是业务规则上的限制,不是系统故障;把这个代码告诉管理员可以帮你定位。`
  return '这个操作没能完成,请稍后重试。'
}

/** 这个错误是不是「模块主动抛的业务错误」(而非真正的内部故障)。助手侧靠它区分要不要说人话。 */
export function isBusinessError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return err instanceof Error && typeof code === 'string' && code in CODE_STATUS
}

/** 测试/护栏用:业务错误码全集。 */
export function allErrorCodes(): string[] {
  return Object.keys(CODE_STATUS)
}
/** 测试/护栏用:已写了人话的错误码全集。 */
export function allHintedCodes(): string[] {
  return Object.keys(CODE_HINT)
}

/** Postgres 唯一约束冲突(drizzle 包装后挂在 cause 链上) */
function findPgCode(err: unknown): string | null {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && /^\d{5}$/.test(code)) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

export function mapError(err: unknown): Mapped {
  if (err instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION',
          message: humanizeError('VALIDATION', 'invalid request body'),
          fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
    }
  }
  // 业务错误:有 code 字段的自定义 Error(OrgError/PartnerError/FinanceError/DocumentError/AuthError/TreeError)
  const code = (err as { code?: unknown }).code
  // 鉴权层对「当前用户」的会话级拒绝(离职/租户停用)给 401,让前端走统一清会话登出,
  // 而不是停在「已登录但每个请求都 403」。只认 AuthError:OrgError 也有 EMPLOYEE_NOT_ACTIVE
  // (指别的员工,如设负责人对方已离职),那种仍走 CODE_STATUS 的 403,不能误伤当前会话。
  if (err instanceof AuthError && (err.code === 'EMPLOYEE_NOT_ACTIVE' || err.code === 'TENANT_SUSPENDED')) {
    return { status: 401, body: { error: { code: err.code, message: humanizeError(err.code, err.message) } } }
  }
  // ★message 一律过 humanizeError:仓里一半的业务错误 message 是英文技术串
  //   (`only draft can be edited`),原样发给前端等于没说。含中文的那半原样保留 —— 它们更具体。
  if (err instanceof Error && typeof code === 'string' && CODE_STATUS[code]) {
    return { status: CODE_STATUS[code]!, body: { error: { code, message: humanizeError(code, err.message) } } }
  }
  if (err instanceof AuthError) {
    return { status: 401, body: { error: { code: err.code, message: humanizeError(err.code, err.message) } } }
  }
  const pgCode = findPgCode(err)
  if (pgCode === '23505') {
    return { status: 409, body: { error: { code: 'DUPLICATE', message: humanizeError('DUPLICATE', '') } } }
  }
  if (pgCode === '23514' || pgCode === '23503' || pgCode === '23502') {
    return { status: 400, body: { error: { code: 'CONSTRAINT_VIOLATION', message: humanizeError('CONSTRAINT_VIOLATION', '') } } }
  }
  // 未知错误:对外只给通用消息(堆栈进日志,不进响应)。★但也要说清「这不是你操作的问题」
  //   并给出下一步 —— 一句 internal server error 只会让人反复重试同一个动作。
  return { status: 500, body: { error: { code: 'INTERNAL', message: humanizeError('INTERNAL', '') } } }
}
