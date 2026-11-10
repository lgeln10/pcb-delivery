// modules/notify/feishu.ts
// 飞书「群自定义机器人」webhook 发送封装。base 直接 POST 到群 webhook,把消息推进群,无需 getdeployed。
// 文档:群机器人 → 自定义机器人 → webhook 地址 +(可选)「加签」密钥。
// ★质量红线:外部调用必须有超时;错误归一为 NotifyError,message 不含 webhook/密钥/堆栈。
import { createHmac } from 'node:crypto'
import type { FeishuConfig } from './model'
import { NotifyError } from './errors'

const TIMEOUT_MS = 10_000

export type FeishuMessage = {
  title: string // 卡片标题
  text: string // 卡片正文(支持飞书 lark_md 富文本)
  templateColor?: 'blue' | 'green' | 'red' | 'grey' // 标题栏配色(默认 blue)
}

/**
 * 加签:string_to_sign = `${timestamp}\n${secret}`,以其为 HMAC-SHA256 的 key 对空串签名,base64。
 * 见飞书自定义机器人「签名校验」。secret 为空表示未开启加签,返回 null。
 */
function sign(secret: string, timestamp: number): string | null {
  if (!secret) return null
  const stringToSign = `${timestamp}\n${secret}`
  return createHmac('sha256', stringToSign).update('').digest('base64')
}

/** 组飞书 interactive 卡片消息体。 */
function buildCardBody(cfg: FeishuConfig, msg: FeishuMessage): Record<string, unknown> {
  const timestamp = Math.floor(Date.now() / 1000)
  const body: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: msg.title },
        template: msg.templateColor ?? 'blue',
      },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: msg.text } }],
    },
  }
  const s = sign(cfg.secret, timestamp)
  if (s) {
    body.timestamp = String(timestamp)
    body.sign = s
  }
  return body
}

/** POST 到群 webhook。失败抛 NotifyError('SEND_FAILED');飞书返回 code!=0 也算失败。 */
export async function sendFeishu(cfg: FeishuConfig, msg: FeishuMessage): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildCardBody(cfg, msg)),
      signal: controller.signal,
    })
    // 飞书 webhook 即使业务失败也常回 200,需看 body.code(0 成功)
    const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
    if (!res.ok || (data && typeof data.code === 'number' && data.code !== 0)) {
      console.error('[notify] 飞书 webhook 发送失败:', res.status, data?.code, data?.msg)
      throw new NotifyError('SEND_FAILED', '飞书群消息发送失败,请检查 webhook 地址 / 加签密钥后重试')
    }
  } catch (err) {
    if (err instanceof NotifyError) throw err
    console.error('[notify] 飞书 webhook 发送异常:', err) // 明细进日志,不进响应
    throw new NotifyError('SEND_FAILED', '飞书群消息发送失败,请检查 webhook 地址 / 加签密钥后重试')
  } finally {
    clearTimeout(timer)
  }
}

/** 发一条测试卡片,用于配置页「发送测试消息」。 */
export async function sendTestFeishu(cfg: FeishuConfig): Promise<void> {
  await sendFeishu(cfg, {
    title: '【通知配置测试】飞书群机器人已可用',
    text: '这是一条来自企业管理平台的测试消息。如果你在群里看到它,说明飞书群机器人通知配置正确。',
    templateColor: 'green',
  })
}
