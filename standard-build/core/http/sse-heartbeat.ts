// core/http/sse-heartbeat.ts
// SSE 心跳:隔一段时间往流里写一个**注释帧**,让连接不至于因为长时间没有字节被掐掉。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 这些流的「有没有字节」和「有没有在干活」是两回事:
//   · 销售助理一轮里可能连着几次模型往返都不产出任何事件 —— `runAssistantLoop` 只在
//     **执行读工具**时 emit,而「多步读计划」「刚查过别再查」那几条 `continue` 分支
//     一个 emit 都没有,收尾的 convergeWithoutTools 也是一次纯静默的模型调用。
//     用户问得含糊时(模型只思考不查库)整轮可能一个字节都不出。
//   · Ask AI 那条更甚:自托管 agent 一轮的预算是 10 分钟。
//
// 而浏览器与反向代理都会掐掉长时间没有数据的连接。掐掉之后前端的 `fetch` 直接 reject,
// Safari / WKWebView 上那句话就是 **「Load failed」** —— 用户看到的既不是超时也不是
// 错误信息,而是一个没头没尾的失败,连「它是不是在想」都判断不了。
// 2026-08-24 线上实测(销售助理:「周三下午戴总带团队来公司交流」)。
//
// ★写的是**注释帧**(`:` 开头),不是 data 帧:SSE 规范里 `:` 开头的行是注释,
//   浏览器原生 EventSource 与我们自己的解析器(`src/api/client.ts` 只认 `data:` 行)
//   都天然忽略它 —— 前端一个字都不用改,也不会凭空多出假事件。
// ★**第一拍立刻发**:除了保活,它还让响应头和首字节马上出去(经 gzip 的反向代理在拿到
//   第一个字节之前不会把响应交出来),客户端因此立刻知道「连上了、在干活」。
// ★不是给「进度」用的:进度是业务事件,该由各自的 emit 发。这里只负责「这条连接还活着」。

/** 心跳间隔。15s:短于常见的浏览器/代理空闲上限(30s 起),又不至于把日志刷满。 */
export const SSE_HEARTBEAT_MS = 15_000

/** SSE 注释帧。空注释即可保活,带个词只是为了抓包时看得懂。 */
export const SSE_HEARTBEAT_FRAME = ': ping\n\n'

/**
 * 起一个心跳,返回**停止函数**——调用方必须放在 `finally` 里,否则一轮结束后定时器还在跑。
 *
 * `write` 由调用方给(通常是 `() => void stream.write(SSE_HEARTBEAT_FRAME).catch(() => {})`):
 * 客户端已经走了的时候写入会失败,那不是错误,吞掉即可 —— 连接的收尾由流自己那条路负责。
 */
export function startSseHeartbeat(write: () => void, intervalMs: number = SSE_HEARTBEAT_MS): () => void {
  write()
  const timer = setInterval(write, intervalMs)
  // 不要让心跳把进程钉住(与 acp.ts 里那些超时定时器同一处理)
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
  return () => clearInterval(timer)
}
