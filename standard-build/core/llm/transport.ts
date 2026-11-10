// core/llm/transport.ts
// 出口改写的注册点:让 LLM 调用从「直连各家 provider」改成「走统一网关」。
//
// ── 为什么是注册器而不是直接 import ────────────────────────────────────────
// 网关的知识(tb 的地址、推理令牌、虚拟模型名 `aios-<scene>`)全在 `modules/ai-gateway`。
// `core/` 不能 import 模块(方向反了),所以沿用仓里已有的那套:模块在启动时把自己
// 注册进来(同 registerJob / registerNotificationSink)。
//
// ── 逃生门:不注册就是直连 ────────────────────────────────────────────────
// ★**不做自动回退。** 网关挂了就报错,不偷偷改走直连 ——
//   悄悄回退意味着「你以为在计量,其实没有」,而且会不声不响地花掉直连那把 key。
//   逃生门是**运维动作**(把 env 撤掉重启),不是运行时的自动行为:
//   谁在为这次调用付钱、这次调用记没记账,不该由一次网络抖动决定。
import type { Ctx, Db } from '../db/client'

/** 网关模式下这次调用的实际出口。 */
export type LLMTransport = {
  baseURL: string
  /** 推理令牌(不是管理令牌) */
  apiKey: string
  /** 发给网关的模型名 —— 网关按它路由到真模型 */
  model: string
  /**
   * `model` 在网关上没配路由时改用的名字(一般是主模型那条)。给了才回退,没给就照实报错。
   *
   * ★为什么必须有它(2026-08-16 线上):`scenes.ts` 一直承诺「未单独配置的场景继承主模型」,
   *   而那只在**直连**时成立 —— 网关模式下场景名会变成一个虚拟模型名发出去,网关只认它配过的,
   *   于是**新加一个场景 = 那个功能在所有网关模式的部署上当场 400**,报文还是一句
   *   「provider or model not configured」,业务侧完全看不懂。日程助手上线当天就是这么挂的。
   * ★由 `modules/ai-gateway` 提供而不是 core 自己拼:虚拟模型名的构造规则是网关模块的知识,
   *   core 不该知道 `aios-` 这个前缀(方向反了)。
   */
  fallbackModel?: string
  /**
   * 「这个模型名网关上没配路由」时给用户看的话。**必须是人话 + 指到具体页面**。
   *
   * ★不给的话用户看到的是网关原文:`400 provider or model not configured for request model
   *   'aios-default'` —— 一句英文技术报文。真实反馈(2026-08-16):用户问「400 是大模型没余额了吗」。
   *   不是余额、不是模型坏了,是**这个租户还没在 AI 网关里配路由**,而报文一个字都没说该去哪配。
   */
  unconfiguredHint?: string
}

/** 返回 null = 这次不走网关(没配 / 该场景不走)。 */
export type LLMTransportResolver = (db: Db, ctx: Ctx, scene: string) => Promise<LLMTransport | null>

let resolver: LLMTransportResolver | null = null

/** server.ts 启动时由 modules/ai-gateway 注册一次。重复注册直接覆盖(便于测试)。 */
export function registerLLMTransport(r: LLMTransportResolver | null): void {
  resolver = r
}

export async function resolveLLMTransport(db: Db, ctx: Ctx, scene: string): Promise<LLMTransport | null> {
  if (!resolver) return null
  return resolver(db, ctx, scene)
}

export function isLLMTransportRegistered(): boolean {
  return resolver !== null
}
