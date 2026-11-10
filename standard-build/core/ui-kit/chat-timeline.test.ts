// core/ui-kit/chat-timeline.test.ts
// 对话轨迹的纯逻辑：顺序攒轨迹 + 切三段 + 一行摘要。
// 这层最容易静默错（顺序错了看不出报错，只是"过程看起来不对"），所以固化成测试。
import { describe, expect, it } from 'vitest'
import {
  appendStream, applyToolResult, businessLabel, denialReason, noticesOf, splitItems, toolLabel,
  stepSummary, stepCmd, stepDetail, stepExpandable,
  type ChatItem,
} from './chat-timeline'

describe('对话轨迹', () => {
  it('流式文本续写同一项，工具事件打断后另起一项（保住先后顺序）', () => {
    const items: ChatItem[] = []
    appendStream(items, 'text', '我先')
    appendStream(items, 'text', '查一下')
    items.push({ type: 'tool_call', name: 'exec_command', args: { command: 'curl /api/leads' }, done: false })
    appendStream(items, 'text', '查到了')
    expect(items.map((i) => i.type)).toEqual(['text', 'tool_call', 'text'])
    expect(items[0]).toMatchObject({ text: '我先查一下' })
    expect(items[2]).toMatchObject({ text: '查到了' })
  })

  it('思考与正文各自成项，不互相污染', () => {
    const items: ChatItem[] = []
    appendStream(items, 'thinking', '先看有没有聚合接口')
    appendStream(items, 'text', '结论是：')
    appendStream(items, 'thinking', '再想想')
    expect(items.map((i) => i.type)).toEqual(['thinking', 'text', 'thinking'])
  })

  it('结果事件标掉最近那条同名未完成的调用，并落一项结果', () => {
    const items: ChatItem[] = [
      { type: 'tool_call', name: 'exec_command', done: true, ok: true },
      { type: 'tool_call', name: 'exec_command', done: false },
    ]
    applyToolResult(items, 'exec_command', false, '404 not found')
    expect(items[0]).toMatchObject({ done: true, ok: true }) // 已完成的那条不受影响
    expect(items[1]).toMatchObject({ done: true, ok: false })
    expect(items[2]).toMatchObject({ type: 'tool_result', ok: false, output: '404 not found' })
  })

  it('空结果不落项（避免一堆空行）', () => {
    const items: ChatItem[] = [{ type: 'tool_call', name: 'exec_command', done: false }]
    applyToolResult(items, 'exec_command', true, '')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ done: true, ok: true })
  })

  it('切三段：过程之前的文本是开场，之后的文本是最终答案，中间的留在过程里', () => {
    const items: ChatItem[] = [
      { type: 'text', text: '我来查。' },
      { type: 'tool_call', name: 'exec_command', done: true, ok: true },
      { type: 'text', text: '还差回款数据' },
      { type: 'tool_result', name: 'exec_command', ok: true, output: '{...}' },
      { type: 'text', text: '## 本周销售\n共 3 单' },
    ]
    const v = splitItems(items)
    expect(v.preface).toBe('我来查。')
    expect(v.middle.map((i) => i.type)).toEqual(['tool_call', 'text', 'tool_result'])
    expect(v.final).toBe('## 本周销售\n共 3 单')
  })

  // ★AM-107:治理类 notice 单独醒目呈现,既不进开场/答案文本,也不进过程折叠。
  it('notice 不污染三段切分,由 noticesOf 单独取出', () => {
    const items: ChatItem[] = [
      { type: 'tool_call', name: 'exec_command', done: true, ok: false },
      { type: 'tool_result', name: 'exec_command', ok: false, output: 'ASKAI_CAPABILITY_DISABLED' },
      { type: 'text', text: '这项能力已关闭。' },
      { type: 'notice', text: '系统提示:该能力已对助手全局关闭,系统未执行任何操作。' },
    ]
    const v = splitItems(items)
    // notice 不出现在 middle 里(不被当成一步过程),也不进 final 正文
    expect(v.middle.some((i) => i.type === 'notice')).toBe(false)
    expect(v.final).toBe('这项能力已关闭。')
    expect(noticesOf(items)).toEqual(['系统提示:该能力已对助手全局关闭,系统未执行任何操作。'])
  })

  it('只有 notice、没有过程:notice 不会把纯文本答案挤进折叠', () => {
    const items: ChatItem[] = [
      { type: 'text', text: '没做成。' },
      { type: 'notice', text: '系统未执行任何操作。' },
    ]
    const v = splitItems(items)
    expect(v.middle).toHaveLength(0)
    expect(v.final).toBe('没做成。')
    expect(noticesOf(items)).toEqual(['系统未执行任何操作。'])
  })

  it('纯文本回答：全部算最终答案，不套折叠', () => {
    const v = splitItems([{ type: 'text', text: '你好' }, { type: 'text', text: '，我是小安' }])
    expect(v.middle).toHaveLength(0)
    expect(v.preface).toBe('')
    expect(v.final).toBe('你好，我是小安')
  })

  it('还在跑：过程后面还没有文本时 final 为空（光标挂在过程后面而不是伪造答案）', () => {
    const v = splitItems([{ type: 'text', text: '开始' }, { type: 'tool_call', name: 'exec_command', done: false }])
    expect(v.preface).toBe('开始')
    expect(v.final).toBe('')
  })

  // ★期望变了(2026-07-30):摘要**先说业务人话**,认识的接口不再显示「动词 + 路径」。
  // 原因:看这条轨迹的是销售和老板,`GET /api/opportunities` 对他们没有意义。
  // 「动词 + 路径」保留为**退路** —— 见下一条,未收录的接口仍然这么显示(排查问题时有用)。
  it('摘要:认识的接口说人话', () => {
    const get: ChatItem = { type: 'tool_call', name: 'exec_command', done: true, args: { command: "curl -s -H 'Authorization: Bearer svc_x' https://base.sixamtech.ai/api/opportunities?limit=50" } }
    expect(stepSummary(get)).toBe('查商机')
    const post: ChatItem = { type: 'tool_call', name: 'exec_command', done: true, args: { command: "curl -X POST https://base.sixamtech.ai/api/partners/abc/follow-ups -d '{}'" } }
    expect(stepSummary(post)).toBe('记一条客户跟进')
    const dataOnly: ChatItem = { type: 'tool_call', name: 'exec_command', done: true, args: { command: "curl https://base.sixamtech.ai/api/leads -d '{\"name\":\"x\"}'" } }
    expect(stepSummary(dataOnly)).toBe('建线索') // 带 -d 判成 POST
  })

  it('摘要退路:未收录的接口仍给「动词 + 路径」,不编名字', () => {
    const unknown: ChatItem = { type: 'tool_call', name: 'exec_command', done: true, args: { command: 'curl -X PATCH https://base.sixamtech.ai/api/some-new-module/42' } }
    expect(stepSummary(unknown)).toBe('更新系统数据')
  })

  it('摘要退路：非本系统命令给原文，其它工具取常见入参字段', () => {
    expect(stepSummary({ type: 'tool_call', name: 'bash', done: true, args: { command: 'ls -la /tmp' } })).toBe('ls -la /tmp')
    expect(stepSummary({ type: 'tool_call', name: 'web_search', done: true, args: { query: '竞品定价' } })).toBe('竞品定价')
    expect(stepSummary({ type: 'tool_call', name: 'weird_tool', done: true, args: { whatever: '兜底取第一个短字符串' } })).toBe('兜底取第一个短字符串')
    expect(stepSummary({ type: 'tool_call', name: 'no_args', done: true })).toBe('')
  })

  it('展开内容：有命令走命令，无命令走入参 JSON；两者都没有就不可展开', () => {
    const withCmd: ChatItem = { type: 'tool_call', name: 'exec_command', done: true, args: { command: 'curl /api/leads' } }
    expect(stepCmd(withCmd)).toBe('curl /api/leads')
    expect(stepDetail(withCmd)).toBe('') // 命令已单独展示，不再重复塞一份 JSON
    expect(stepExpandable(withCmd)).toBe(true)

    const withArgs: ChatItem = { type: 'tool_call', name: 'web_search', done: true, args: { query: 'x' } }
    expect(stepDetail(withArgs)).toContain('"query"')

    const bare: ChatItem = { type: 'tool_call', name: 'no_args', done: true }
    expect(stepExpandable(bare)).toBe(false)
  })

  it('展示前脱敏：服务令牌不许出现在界面上（对话记录谁有 view 权限都能翻）', () => {
    const tok = 'svc_' + 'a1b2c3d4'.repeat(6) // 48 位 hex，与 mintServiceToken 的形状一致
    const it0: ChatItem = { type: 'tool_call', name: 'exec_command', done: true, args: { command: `curl -H 'Authorization: Bearer ${tok}' https://base.example/api/leads` } }
    const cmd = stepCmd(it0)
    expect(cmd).not.toContain(tok)
    expect(cmd).toContain('Bearer ***')
    expect(cmd).toContain('/api/leads') // 只打码凭据，别把命令本身糊掉

    // 结果原文/思考里若被回显出来，同样打码
    expect(stepSummary({ type: 'tool_result', name: 'exec_command', ok: true, output: `used ${tok}` })).toBe('used svc_***')
    expect(stepDetail({ type: 'thinking', text: `我拿 ${tok} 调` })).toBe('我拿 svc_*** 调')
    // 非命令类入参走 JSON 展开，也要打码
    expect(stepDetail({ type: 'tool_call', name: 'web_fetch', done: true, args: { url: 'https://x/y', header: `Bearer ${tok}` } })).not.toContain(tok)
  })

  it('工具名去技术化，未知名原样透出（不编造）', () => {
    expect(toolLabel('exec_command')).toBe('调用系统接口')
    expect(toolLabel('Bash')).toBe('执行命令')
    expect(toolLabel('some_new_tool')).toBe('some_new_tool')
  })
})

// ─── 业务人话层(从 modules/askai 并入时一并带来的回归)───────────────────────────
// 这一组最重要的是**脱敏**那条:详情层要是把 agent 跑的 curl 原样摊出来,
// 里面就带着 `Authorization: Bearer svc_…` —— 点开详情等于看到会话令牌明文。
// 2026-07-30 真机实测时发现 Ask AI 那份手搓实现漏了(这份有 redact,两份实现只补了一份),
// 这也正是把两份合并成一份的直接原因:一条事件流,一处补丁。
describe('展示前脱敏(最重要的一条)', () => {
  const call = (command: string): ChatItem => ({ type: 'tool_call', name: 'exec_command', args: { command }, done: true })

  it('★令牌不能出现在摘要或详情里', () => {
    const it = call('curl -H "Authorization: Bearer svc_a1b2c3d4e5f60718293a4b5c6d7e8f90" https://x/api/leads')
    expect(stepCmd(it)).not.toContain('svc_a1b2c3d4e5f60718293a4b5c6d7e8f90')
    expect(stepCmd(it)).toContain('Bearer ***')
  })

  it('结果原文里混着令牌也要打码', () => {
    const r: ChatItem = { type: 'tool_result', name: 'exec_command', ok: true, output: '{"token":"svc_deadbeefdeadbeefdeadbeef1234"}' }
    expect(stepDetail(r)).not.toMatch(/svc_[0-9a-f]{16,}/)
  })
})

describe('businessLabel:翻不出来就说实话,不许瞎标', () => {
  const call = (command: string): ChatItem => ({ type: 'tool_call', name: 'exec_command', args: { command }, done: true })

  it('按路径翻成业务人话', () => {
    expect(businessLabel(call('curl https://x/api/crm-dashboard/key-opportunities?lens=intervention'))).toBe('找出需要干预的商机')
    expect(businessLabel(call('curl -X POST https://x/api/partners/abc/follow-ups -d {}'))).toBe('记一条客户跟进')
    expect(businessLabel(call('curl https://x/api/askai/exchange'))).toBe('确认你的身份和权限')
  })

  it('★没有 URL 的步骤不能标成「查系统数据」', () => {
    // 真机实测:agent 用 exec_command 跑 jq 整理上一步落到 /tmp 的返回,根本没碰系统
    expect(businessLabel(call('jq -r ".items[]" /tmp/followup_leads.json'))).toBe('整理刚查到的数据')
  })

  it('★光看入参认不出来的,拿结果再判一次 —— 读技能手册就是这种', () => {
    const it = call('exec skill')
    // 入参里没有线索 → 退回中性说法。★2026-07-31 改过:原先退回工具名「调用系统接口」,
    // 但这类命令根本没碰接口(实测有 getdeployed --help 之类),那么说会让人以为 AI 动了系统数据。
    expect(businessLabel(it)).toBe('在本机执行了一条命令')
    // 结果里有手册正文 → 认出来
    expect(businessLabel(it, '---\nname: skill\ndescription: 每轮先用 ask-session 换取…')).toBe('读取操作手册')
  })

  it('未知路径退回中性说法,按方法分读写', () => {
    expect(businessLabel(call('curl https://x/api/something-new'))).toBe('查系统数据')
    expect(businessLabel(call('curl -X POST https://x/api/something-new -d {}'))).toBe('更新系统数据')
  })

  it('stepSummary 优先说人话,翻不出来才退回动词+路径', () => {
    expect(stepSummary(call('curl https://x/api/leads'))).toBe('查线索')
    expect(stepSummary(call('curl https://x/api/something-new'))).toBe('查系统数据')
  })
})

describe('denialReason:说人话,不回显状态码', () => {
  it('按 scope 认出模块', () => {
    expect(denialReason('FORBIDDEN missing scope finance:view')).toBe('你的账号没有财务查看权限')
  })
  it('认不出模块也不回显 403', () => {
    expect(denialReason('403 Forbidden')).toBe('你的账号没有这项权限')
  })
  it('401 是身份过期,处置不同', () => {
    expect(denialReason('401 Unauthorized')).toBe('身份已过期,请刷新页面重试')
  })
  it('成功返回不该被误判成被拒', () => {
    expect(denialReason('{"total":91}')).toBeNull()
  })
})

describe('★一条命令里有多个接口时,按业务动作命名(不是「确认身份」)', () => {
  // 起因(2026-07-31 实测):一屏里「已确认你的身份和权限」重复了四遍。
  // agent 常把好几条 curl 塞进同一条命令(换令牌 + /api/me + 真正要干的事),
  // 而标签只取第一个 URL —— 于是每一步长得一模一样,等于什么都没说。
  const call = (cmd: string) => ({ type: 'tool_call' as const, name: 'exec_command', args: { command: cmd }, done: true })

  it('换令牌 + 查执行方 → 叫「看有哪些执行方」', () => {
    const cmd = `curl -s -X POST http://x/api/askai/exchange -d '{}' && curl -s http://x/api/me && curl -s http://x/api/superindividual/agents`
    expect(businessLabel(call(cmd))).toBe('看有哪些执行方')
  })

  it('换令牌 + 建工作流 → 叫「创建工作流」', () => {
    const cmd = `curl -s -X POST http://x/api/askai/exchange -d '{}' ; curl -s -X POST http://x/api/superindividual/automations/provision -d '{"title":"x"}'`
    expect(businessLabel(call(cmd))).toBe('创建工作流')
  })

  it('只有换令牌这一步时,还是如实叫「确认你的身份和权限」', () => {
    expect(businessLabel(call(`curl -s -X POST http://x/api/askai/exchange -d '{}'`))).toBe('确认你的身份和权限')
  })

  it('查线索 → 叫「查线索」(管道调用在前也不影响)', () => {
    expect(businessLabel(call(`curl http://x/api/me; curl http://x/api/leads?limit=5`))).toBe('查线索')
  })
})

describe('没碰接口的命令不能说成「调用系统接口」', () => {
  // 实测:agent 会在本机试 CLI(getdeployed --help / command -v / 跑个二进制)。
  // 这些一律被标成「调用系统接口」,看轨迹的人会以为 AI 动了系统数据 —— 那是假的。
  const call = (cmd: string) => ({ type: 'tool_call' as const, name: 'exec_command', args: { command: cmd }, done: true })
  it.each([
    '/bin/zsh -lc \'getdeployed --help\'',
    '/bin/zsh -lc "command -v getdeployed || true"',
  ])('%s → 在本机执行了一条命令', (cmd) => {
    expect(businessLabel(call(cmd))).toBe('在本机执行了一条命令')
  })

  it('真调了接口的照旧按业务命名', () => {
    expect(businessLabel(call('curl http://x/api/leads'))).toBe('查线索')
  })
})
