// core/http/askai-capability-gate.ts
// Ask AI「对助手全局关闭的能力」被闸拦下时的**服务端确定性信号源**(不经过大模型)。
//
// 背景(AM-107):Ask AI 让 agent 建数字员工,被 EXCLUDED_MODULES 闸物理拦下(0→0),
// agent 却谎报「已新建并核验成功」。playbook 已写了 5+ 条同义诚信指令仍拦不住 —— 因为
// 「如实说没做成」这句话始终握在大模型手里。修法是把它从模型手里拿走:
//   requirePermission 命中排除时,在这里记一笔(机器事实);
//   Ask AI 的 SSE 代理据此在该轮追加一条**由服务端撰写、不经过大模型**的如实 notice。
// 无论模型正文怎么写,notice 都改不掉、删不掉。这只对 EXCLUDED_MODULES 这一类确定性场景兜底,
// 通用「谎报成功」不在本文件职责内(见 AM-107 spec 的 scope)。
//
// 为什么放 core 而不是 modules/askai:enforcement 点(requirePermission)在 core,
// 而 core 不能反向 import modules。所以排除集与记账器都落在 core,modules/askai 反过来复用它
// (依赖方向 modules → core,合规),保持单一事实来源。

/**
 * 不开放给 Ask AI 的治理面**模块**(该模块下的权限码一律不进会话令牌)。
 * 开放 = AI 能给自己/别人扩权(org)、抹审计(audit)、自我增殖(digitalemployee)、
 * 改写自身定义(aiagent:换模型/放开工具白名单/摘掉审批标记 = 自己给自己解除治理)。
 *
 * 与 core/auth/service-token.ts 的 GOVERNANCE_MODULES 同源同因,**且自 2026-08-13 起完全一致**
 * (此前本集合少一个 aiagent,是个没有理由的口径差:Ask AI 拿得到 aiagent:manage 就能摘审批标记,
 * 而那正是 digitalemployee/approval.ts 那道闸的开关)。改这里时同步看那份。
 * 2026-07-30 与需求方确认前三个;2026-08-13 补 aiagent。
 */
export const ASKAI_EXCLUDED_MODULES = new Set(['org', 'audit', 'digitalemployee', 'aiagent'])

/**
 * 不开放给 Ask AI 的**单个权限码**(模块整体保留,只摘掉其中一个动作)。
 *
 * 为什么需要码级而不是把整个模块塞进上面那个集合:`superindividual` 下面还有
 * `:use`(个人工作台)与 `:admin`(看所有人工作台)两个**只读**码 —— 整模块排除会让
 * Ask AI 连「我有哪些工作流在跑」「上周那条催收跑成功没」都答不了,而这类只读问题
 * 正是它最该回答的。
 *
 * `superindividual:automate`(创建/运行运营自动化,2026-08-13 加):
 *   客户侧没有调试能力,AI 建出来的工作流不稳定且出问题时无人能修 —— 与 digitalemployee
 *   「防自我增殖」不是同一个理由,但落点相同:**这件事只能由人在后台做**。
 *   注意该码同时管「创建」和「运行」,排除后 AI 也不能触发工作流运行(只能看),这是接受的代价。
 *   ★配套:playbook 里那整节「教它怎么建工作流」必须同时删掉(modules/askai/assistant.ts)——
 *   只加闸不删教程,AI 会照旧反复撞墙然后编造成功(AM-107 就是这么来的)。
 */
export const ASKAI_EXCLUDED_CODES = new Set(['superindividual:automate'])

/**
 * 这个权限码是否属于 Ask AI 排除面 —— 模块级或码级命中任一即算。
 * 权限码约定为 `module:action`(见各模块 permissions.ts),故模块名取冒号前那段。
 */
export function isAskAiExcludedPermCode(permCode: string): boolean {
  return ASKAI_EXCLUDED_MODULES.has(permCode.split(':')[0] ?? '') || ASKAI_EXCLUDED_CODES.has(permCode)
}

/**
 * ★哨兵 scope:标记一枚令牌是「Ask AI 会话令牌」。
 * 它**不是**任何真实权限点(没有路由用它做 requirePermission),纯粹作为令牌来源的标识 ——
 * 好让 requirePermission 只对 Ask AI 会话做排除兜底,不误伤数字员工 daemon 令牌
 * (那类同样是背靠某人的服务令牌,被排除面拦下时应保持原有 FORBIDDEN 行为,不在本次 scope 内)。
 * 由 exchangeSessionToken 在铸令牌时并入 scopes。
 */
export const ASKAI_SESSION_MARKER = 'askai:session'

/** 一枚令牌是否是 Ask AI 会话令牌(带哨兵)。 */
export function isAskAiSessionScopes(scopes: readonly string[] | undefined): boolean {
  return !!scopes && scopes.includes(ASKAI_SESSION_MARKER)
}

// ── 记账:进程内、按(租户+人)记最近一次「排除能力被拦」的时刻 ──
//
// 为什么进程内够用:base.sixamtech.ai 是单机单进程部署(rsync 一台机 + systemctl 重启单个 Node 服务)。
// agent 的越权调用与该轮 SSE 代理跑在同一进程、同一段时间窗内,所以进程内 Map 即可精确关联。
// 若将来多实例横向扩展,这里要换成共享存储(见下方 hadAskAiCapabilityBlockSince 的关联说明)。
//
// 只存「最近一次时刻」而不是全部历史:关联判据是「本轮开始之后有没有命中」,一个时间戳就够,
// 且天然不会无界增长(每人一格,过期清理兜底)。
const lastBlockAt = new Map<string, number>()
/** 超过这个时长的记录视为陈旧,清理掉(远大于一轮对话上限 15min,只为防进程长跑时 Map 里堆离职员工的键)。 */
const STALE_MS = 60 * 60 * 1000

const keyOf = (tenantId: string, employeeId: string) => `${tenantId}:${employeeId}`

/**
 * 记一笔「(租户+人)在此刻命中了排除能力闸」。由 requirePermission 在确认是
 * Ask AI 会话令牌 + 排除面 permCode 被拦时调用。
 */
export function recordAskAiCapabilityBlock(tenantId: string, employeeId: string, now = Date.now()): void {
  // 顺手清一次陈旧键,避免长跑进程里 Map 无界增长
  if (lastBlockAt.size > 256) {
    for (const [k, ts] of lastBlockAt) if (now - ts > STALE_MS) lastBlockAt.delete(k)
  }
  lastBlockAt.set(keyOf(tenantId, employeeId), now)
}

/**
 * 本轮开始(sinceMs)之后,这个(租户+人)有没有命中过排除能力闸。
 *
 * 关联正确性:agent 的越权调用发生在 SSE 代理 `for await` 期间(它必须先跑完,上游才发 done),
 * 因此「命中时刻 ≥ 本轮开始时刻」对当轮成立。唯一的误报边界是**同一个人同时开着两段 Ask AI 对话**、
 * 其中一段合法触发了排除能力 —— 另一段也会看到 notice。属极罕见且无害(那个人确实在另一个标签页
 * 试用被排除能力),spec 已接受该精度。
 */
export function hadAskAiCapabilityBlockSince(tenantId: string, employeeId: string, sinceMs: number): boolean {
  const ts = lastBlockAt.get(keyOf(tenantId, employeeId))
  return ts !== undefined && ts >= sinceMs
}

/** 仅供测试:清空记账。 */
export function __resetAskAiCapabilityLog(): void {
  lastBlockAt.clear()
}

/**
 * ★服务端撰写的如实说明。**不经过大模型** —— 无论模型正文说什么,这句都在。
 * 守住 spec 的文案边界:这里说的是「对助手全局关闭 / 系统未执行任何操作」,
 * 与「你个人没有 X 权限,找管理员开」的普通业务 403 文案严格区分(后者由前端 denialReason 说)。
 * 不描述任何并不存在的实体(这正是 AM-107 里 agent 编造「巡检测试员职责」那种谎)。
 */
export const ASKAI_CAPABILITY_NOTICE =
  '系统提示:你请求的这项能力(如新建工作流/自动化、新建数字员工、改动账号/角色、删改审计记录)'
  + '已对助手全局关闭,系统未执行任何操作,也无法通过其它方式代为完成。'
  + '如确有需要,请联系实施人员或由管理员在后台直接处理。'
