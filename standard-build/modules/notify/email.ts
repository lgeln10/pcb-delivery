// modules/notify/email.ts
// SMTP 发信封装(nodemailer)。兼容任意 SMTP 服务商:飞书企业邮/腾讯企业邮/自建 Exchange/Postfix 等。
// ★质量红线:外部调用必须有超时;错误归一为 NotifyError,message 不含凭证/堆栈。
import nodemailer from 'nodemailer'
import type { EmailConfig } from './model'
import { NotifyError } from './errors'

const TIMEOUT_MS = 10_000

export type EmailMessage = {
  to: string
  subject: string
  text?: string
  html?: string
}

function buildTransport(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  })
}

function fromHeader(cfg: EmailConfig): string {
  const addr = cfg.fromAddress.trim() || cfg.user
  const name = cfg.fromName.trim()
  return name ? `"${name}" <${addr}>` : addr
}

/** 发送一封邮件。失败抛 NotifyError('SEND_FAILED'),错误明细只进日志、不外泄。 */
export async function sendEmail(cfg: EmailConfig, msg: EmailMessage): Promise<void> {
  const transport = buildTransport(cfg)
  try {
    await transport.sendMail({
      from: fromHeader(cfg),
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    })
  } catch (err) {
    console.error('[notify] SMTP 发送失败:', err) // 明细进日志,不进响应
    throw new NotifyError('SEND_FAILED', '邮件发送失败,请检查 SMTP 主机/端口/账号密码后重试')
  } finally {
    transport.close()
  }
}

/** 发一封测试邮件到账号自身,用于配置页"发送测试邮件"。 */
export async function sendTestEmail(cfg: EmailConfig): Promise<void> {
  const to = cfg.fromAddress.trim() || cfg.user
  await sendEmail(cfg, {
    to,
    subject: '【通知配置测试】邮件渠道已可用',
    text: '这是一封来自企业管理平台的测试邮件。如果你收到它,说明 SMTP 邮件通知配置正确。',
  })
}
