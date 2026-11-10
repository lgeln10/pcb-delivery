// core/ui-kit/chat-timeline.ts
// 对话轨迹的纯逻辑（无 Vue 依赖，可单测）：把 SSE 事件流攒成一条**按发生顺序**的轨迹，
// 再切成「开场文本 / 过程 / 最终答案」三段给界面渲染。
//
// ★2026-07-30 从 modules/digitalemployee/ui/ 提到 core/ui-kit:**两个界面共用同一条事件流**
// （数字员工工位 + Ask AI，底下都是同一个 getdeployed agent、同样的 exec_command）。
// 之前各写了一份,直接后果是**安全补丁只打在一份上** —— redact 在这份有、Ask AI 那份没有,
// 于是 Ask AI 的「详情」点开就是会话令牌明文。一条事件流只留一份渲染逻辑。
//
// 为什么要按顺序而不是「工具一堆 + 文本一坨」：那样看不出它一步步在干什么，
// 而且中间说的话会被并进最终答案里（老板读到的就不是结论了）。参考 getdeployed 的 Ask AI。

export type ChatItem =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; args?: unknown; ok?: boolean; done: boolean }
  | { type: 'tool_result'; name: string; ok: boolean; output: string }
  // ★AM-107:服务端撰写的治理类系统消息(不经过大模型)。命中「对助手全局关闭的能力」被闸拦下时追加。
  // 与 AI 正文区分呈现(见 AskAiChat.vue),不进折叠过程、不进复制正文。
  | { type: 'notice'; text: string }
  // 待确认的写操作(自托管这条路)。★`done` 是**本地 UI 状态**(点过确认/取消就不再显示按钮),
  // 不是服务端字段 —— 轨迹从服务端重放回来时它恒为 false,那正是想要的:
  // 刷新页面后那张还没点的卡要还在。
  | { type: 'pending'; actions: Array<{ tool: string; args: Record<string, unknown>; preview: string }>; done: boolean }

/** 往轨迹尾部追加流式文本：尾项同类型就续写，否则起新的一项（保住「文本↔工具」的先后顺序）。 */
export function appendStream(items: ChatItem[], kind: 'text' | 'thinking', delta: string): void {
  const last = items[items.length - 1]
  if (last && last.type === kind) last.text += delta
  else items.push({ type: kind, text: delta })
}

/** 结果事件到达：把最近那条同名未完成的调用标成完成（成功/失败），并把结果作为一项落进轨迹。 */
export function applyToolResult(items: ChatItem[], name: string, ok: boolean, output: string): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.type === 'tool_call' && it.name === name && !it.done) {
      it.ok = ok
      it.done = true
      break
    }
  }
  if (output) items.push({ type: 'tool_result', name, ok, output })
}

export type TimelineView = { preface: string; middle: ChatItem[]; final: string }

/**
 * 切三段：preface（首个过程项之前的文本）/ middle（过程，含其间夹的文本）/ final（末个过程项之后的文本）。
 * 没有任何过程项时全部算 final —— 纯文本回答就该直接以最终答案呈现，不套折叠。
 */
export function splitItems(all: ChatItem[]): TimelineView {
  // notice 是治理类系统消息,单独醒目呈现(见 AskAiChat.vue 的 noticesOf),
  // 既不算开场/答案文本,也不算过程步骤 —— 先剔出去再切三段。
  const items = all.filter((i) => i.type !== 'notice')
  const textOf = (arr: ChatItem[]) => arr.map((i) => (i.type === 'text' ? i.text : '')).join('')
  const isStep = (it: ChatItem) => it.type !== 'text'
  const first = items.findIndex(isStep)
  if (first < 0) return { preface: '', middle: [], final: textOf(items) }
  let last = items.length - 1
  while (last >= 0 && !isStep(items[last]!)) last--
  return {
    preface: textOf(items.slice(0, first)),
    middle: items.slice(first, last + 1),
    final: textOf(items.slice(last + 1)),
  }
}

/** 一条消息里的治理类系统 notice(AM-107)。与 AI 正文分开、醒目呈现。 */
export function noticesOf(items: ChatItem[]): string[] {
  return items.filter((i): i is Extract<ChatItem, { type: 'notice' }> => i.type === 'notice').map((i) => i.text)
}

// 工具名去技术化：老板看的是「它在干什么」，不是函数名。未知名保持原样（不编造）。
const TOOL_LABELS: Record<string, string> = {
  exec_command: '调用系统接口',
  bash: '执行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '修改文件',
  web_search: '联网搜索',
  web_fetch: '打开网页',
  skill: '加载技能',
  // 图片附件的旁路转录(modules/askai/attachments.ts)。不是模型调的工具,是服务端
  // 在开跑前替它读图 —— 但对用户来说就是「它在看我发的那张图」,同样该出现在轨迹里。
  read_image: '识别图片附件',
}
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? TOOL_LABELS[name.toLowerCase()] ?? name
}

/**
 * 展示前脱敏。★数字员工干活的命令里带着 `Authorization: Bearer svc_…` —— 那是一条**全业务权限**的
 * 服务令牌，而对话记录任何有 `digitalemployee:view` 的员工都能翻。展示层一律打码（playbook 自己也写着
 * 「切勿在回复里回显该令牌」）。只影响显示，不动原始事件。
 */
export function redact(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/svc_[0-9a-f]{16,}/gi, 'svc_***')
}

// ─── 业务人话层（2026-07-30 从 modules/askai/ui/humanize.ts 并入）───────────────
// 为什么放这儿:看这条轨迹的人是**销售和老板**,不是开发。`GET /api/crm-dashboard/key-opportunities`
// 对他们没有意义,而「AI 替我动了什么」正是他们信任这东西的凭据。
// 放进共享模块之后,数字员工工位和 Ask AI 一起说人话,不用各写一遍。

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** 路径 → 人话。越具体的放越前面。**这里只放确实存在的接口** —— 编一个好听的名字比不翻更糟。 */
const PATH_LABELS: Array<[RegExp, Partial<Record<Method, string>> & { any?: string }]> = [
  [/\/api\/askai\/exchange/, { any: '确认你的身份和权限' }],
  [/\/api\/crm-dashboard\/key-opportunities/, { any: '找出需要干预的商机' }],
  [/\/api\/crm-dashboard\/recent-activity/, { any: '看最近的跟进动态' }],
  [/\/api\/crm-dashboard/, { any: '查 CRM 概览' }],
  [/\/api\/finance\/shareholder-dashboard/, { any: '查财务总览' }],
  [/\/api\/finance\/invoices/, { any: '查发票' }],
  [/\/api\/finance\/reports\/aging/, { any: '查账龄' }],
  [/\/api\/finance/, { any: '查财务数据' }],
  [/\/api\/partners\/[^/]+\/follow-ups/, { POST: '记一条客户跟进', any: '看客户跟进记录' }],
  [/\/api\/partners/, { GET: '查客户', POST: '建客户', any: '改客户资料' }],
  [/\/api\/opportunities/, { GET: '查商机', POST: '建商机', any: '改商机' }],
  [/\/api\/leads/, { GET: '查线索', POST: '建线索', any: '改线索' }],
  [/\/api\/contracts/, { GET: '查合同', POST: '生成合同并提交审批', any: '改合同' }],
  [/\/api\/knowledge\/search/, { any: '查企业知识库' }],
  [/\/api\/inapp-notify/, { any: '发站内提醒' }],
  [/\/api\/inventory/, { any: '查进销存' }],
  [/\/api\/reimbursement/, { any: '查报销' }],
  [/\/api\/superindividual\/automations/, { GET: '看现有工作流', POST: '创建工作流', any: '改工作流' }],
  [/\/api\/superindividual\/agents/, { any: '看有哪些执行方' }],
  [/\/api\/superindividual\/inbox/, { any: '看任务收件箱' }],
  [/\/api\/dashboard\/capabilities/, { any: '看能按什么维度出数' }],
  [/\/api\/dashboard\/layout/, { GET: '看当前看板', any: '调整看板' }],
  [/\/api\/me\b/, { any: '确认当前身份' }],
]

/** 管道性质的调用:每轮都会有,不是用户关心的「这一步在干嘛」。 */
const PLUMBING = /\/api\/(askai\/exchange|me)\b/

/**
 * 一句业务人话的动作名。`extra` 传结果原文 —— 有些步骤**光看入参认不出来**:
 * 真机实测里「读技能手册」那一步,入参只是个命令,手册正文是在**结果**里才出现的,
 * 于是被标成了「查系统数据」。认不出就别瞎标,这一版的立场是不摆假信息。
 */
export function businessLabel(it: ChatItem, extra = ''): string {
  if (it.type !== 'tool_call') return ''
  const flat = `${stepCmd(it)} ${JSON.stringify(it.args ?? '')}`
  // ★agent 常把好几条 curl 塞进**同一条命令**(换令牌 + /api/me + 真正要干的事)。
  // 只取第一个 URL 的话,每一步都会被标成「确认你的身份和权限」——
  // 实测一屏里重复了四遍,等于没告诉人任何事。所以:先把管道性质的调用滤掉,
  // 剩下的第一个才是这一步真正在干的事。
  const all = [...flat.matchAll(/\/api\/[\w/{}.-]+/g)].map((m) => m[0])
  const url = all.find((u) => !PLUMBING.test(u)) ?? all[0] ?? ''
  if (url) {
    const m = /-X\s+(GET|POST|PATCH|PUT|DELETE)/i.exec(flat)?.[1]
      ?? (/(^|\s)(-d|--data)(\s|=)/.test(flat) ? 'POST' : 'GET')
    const method = m.toUpperCase() as Method
    for (const [re, labels] of PATH_LABELS) {
      if (re.test(url)) return labels[method] ?? labels.any ?? '查系统数据'
    }
    if (/\/api\//.test(url)) return method === 'GET' ? '查系统数据' : '更新系统数据'
  }
  const hay = `${flat} ${extra}`
  // 每段对话开头必有一次读技能手册 —— 标成「查系统数据」会让人以为动了业务数据
  if (/name:\s*skill|# Skill:|ask-session/i.test(hay)) return '读取操作手册'
  // 本地整理上一步落到 /tmp 的返回,根本没碰系统
  if (/\bjq\b|\/tmp\/|\bcat\b|\bgrep\b/.test(hay)) return '整理刚查到的数据'
  // ★没有任何 /api/ 调用的 exec_command:agent 在本机折腾(试 CLI、找文件、看帮助)。
  //   标成「调用系统接口」是**说错了** —— 它压根没碰这套系统的数据(实测:一屏里有三条
  //   `getdeployed --help` / `command -v` 被标成调用接口,看的人会以为 AI 动了什么)。
  if (it.name === 'exec_command' && !/\/api\//.test(flat)) return '在本机执行了一条命令'
  return toolLabel(it.name)
}

/** 被拒的人话原因 —— 用户该看到的是「你没有这个权限」,不是 403。认不出就返回 null。 */
export function denialReason(output: string): string | null {
  const s = String(output ?? '')
  if (/\b403\b|forbidden|missing scope|没有权限/i.test(s)) {
    const modul = /missing scope ([\w:-]+)/i.exec(s)?.[1]?.split(':')[0]
    const zh: Record<string, string> = {
      finance: '财务', contract: '合同', partner: '客户', lead: '线索',
      opportunity: '商机', inventory: '进销存', reimbursement: '报销', payroll: '薪酬',
    }
    return modul && zh[modul] ? `你的账号没有${zh[modul]}查看权限` : '你的账号没有这项权限'
  }
  if (/\b401\b|unauthorized/i.test(s)) return '身份已过期,请刷新页面重试'
  return null
}

/** 调用带的原始命令（有就用终端块展示，比 JSON 好读）。已脱敏。 */
export function stepCmd(it: ChatItem): string {
  if (it.type !== 'tool_call') return ''
  const a = (it.args ?? {}) as Record<string, unknown>
  return typeof a.command === 'string' ? redact(a.command) : ''
}

/**
 * 一行摘要：优先把「调了本系统哪个接口」抽出来（HTTP 动词 + /api 路径）——
 * 数字员工干活基本都是 curl 本系统 API，摘要写成 `GET /api/opportunities` 一眼就懂；
 * 抽不出来再退回命令/查询词原文（界面单行截断，这里不截，展开要看全）。
 */
export function stepSummary(it: ChatItem): string {
  if (it.type === 'thinking') return redact(it.text)
  if (it.type === 'tool_result') return redact(it.output)
  const cmd = stepCmd(it)
  if (cmd) {
    // ★先试业务人话:看这条轨迹的是销售和老板,`GET /api/leads` 对他们没意义。
    // 翻不出来才退回「动词 + 路径」(排查问题时仍然有用),再退回命令原文。
    const said = businessLabel(it)
    if (said && (it.type !== 'tool_call' || said !== toolLabel(it.name))) return said
    const path = cmd.match(/\/api\/[A-Za-z0-9\-_/{}]+/)?.[0]
    if (path) {
      const verb = cmd.match(/-X\s+([A-Z]+)/)?.[1] ?? (/(^|\s)(-d|--data)(\s|=)/.test(cmd) ? 'POST' : 'GET')
      return `${verb} ${path}`
    }
    return cmd
  }
  const a = (it.type === 'tool_call' ? it.args ?? {} : {}) as Record<string, unknown>
  for (const k of ['query', 'file_path', 'path', 'pattern', 'description', 'prompt', 'skill', 'url']) {
    const v = a[k]
    if (typeof v === 'string' && v) return v
  }
  const first = Object.values(a).find((v) => typeof v === 'string' && v.length > 0 && v.length < 200)
  return typeof first === 'string' ? first : ''
}

/** 展开后给全文（命令之外的入参序列化 / 结果原文 / 完整思考）。空字符串 = 没东西可展开。 */
export function stepDetail(it: ChatItem): string {
  if (it.type === 'thinking') return redact(it.text)
  if (it.type === 'tool_result') return redact(it.output)
  if (it.type === 'tool_call' && !stepCmd(it)) {
    return it.args && Object.keys(it.args as object).length ? redact(JSON.stringify(it.args, null, 2)) : ''
  }
  return ''
}

export function stepExpandable(it: ChatItem): boolean {
  return !!stepCmd(it) || !!stepDetail(it)
}
