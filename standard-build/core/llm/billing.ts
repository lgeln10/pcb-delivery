// core/llm/billing.ts
// SixAM 智能云(自营中转)的账户信息代理:余额 / 用量 / 月对账单 / 资金台账。
// 数据真身在中转站(sixam-api)的 /v1/account/*,凭本租户配置的 sixam API Key 取 ——
// key 不下发前端,前端只跟本服务的 /api/llm/billing/* 说话。
// ★这里只做只读代理,不落库不缓存:余额/账单必须是中转站的实时口径,本地存一份就是第二事实源。
import type { Ctx, Db } from '../db/client'
import { LlmError } from './errors'
import { LLM_PROVIDERS } from './providers'
import { resolveProviderApiKey } from './config'

const TIMEOUT_MS = 15_000

async function relayFetch(db: Db, ctx: Ctx, path: string): Promise<Response> {
  const apiKey = await resolveProviderApiKey(db, ctx, 'sixam')
  if (!apiKey) {
    throw new LlmError('LLM_NOT_CONFIGURED', '未配置 SixAM 智能云的 API Key(在本页「各供应商 API Key」里填写)')
  }
  let res: Response
  try {
    res = await fetch(LLM_PROVIDERS.sixam.baseURL + path, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new LlmError('LLM_ERROR', 'SixAM 智能云暂时无法访问,请稍后再试')
  }
  if (res.status === 401) throw new LlmError('LLM_NOT_CONFIGURED', 'SixAM 智能云的 API Key 无效或已停用,请重新配置')
  if (!res.ok) throw new LlmError('LLM_ERROR', `SixAM 智能云返回 ${res.status}`)
  return res
}

const relayJson = async (db: Db, ctx: Ctx, path: string) => (await relayFetch(db, ctx, path)).json()

/** 账户概览:余额 / 今日消费 / 日预算 / 整体折扣。 */
export const billingAccount = (db: Db, ctx: Ctx) => relayJson(db, ctx, '/account')

/** 近 N 天用量(按日按模型;中转侧上限 92 天)。 */
export const billingUsage = (db: Db, ctx: Ctx, days: number) =>
  relayJson(db, ctx, `/account/usage?days=${Math.min(Math.max(Math.trunc(days) || 30, 1), 92)}`)

/** 月对账单(YYYY-MM,东八区自然月)。 */
export const billingBill = (db: Db, ctx: Ctx, month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new LlmError('INVALID_INPUT', 'month 应为 YYYY-MM')
  return relayJson(db, ctx, `/account/bill?month=${month}`)
}

/** 对账单 CSV(原样转流,含 BOM 与文件名头)。 */
export const billingBillCsv = (db: Db, ctx: Ctx, month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new LlmError('INVALID_INPUT', 'month 应为 YYYY-MM')
  return relayFetch(db, ctx, `/account/bill?month=${month}&format=csv`)
}

/** 资金台账(充值/消费/调整逐笔,分页)。 */
export const billingLedger = (db: Db, ctx: Ctx, limit: number, offset: number) =>
  relayJson(
    db, ctx,
    `/account/ledger?limit=${Math.min(Math.max(Math.trunc(limit) || 20, 1), 200)}&offset=${Math.max(Math.trunc(offset) || 0, 0)}`,
  )
