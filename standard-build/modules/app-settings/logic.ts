// modules/app-settings/logic.ts
// 系统设置的读/写:每租户一行,无行则回默认值;保存走 upsert(insert 或 auditedUpdate)。
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../../core/db/client'
import { auditedUpdate, scope } from '../../core/db/soft-delete'
import { checkUpload } from '../../core/storage/api'
import { AppSettingsError } from './errors'
import { appSettings, type AppSettings } from './model'
import { DEFAULT_TIMEZONE, isValidTimezone } from './time'

export type AppSettingsDTO = {
  systemName: string
  logoUrl: string | null
  timezone: string
  /** 本公司开票抬头全称 / 统一社会信用代码。空 = 未配置,AI 预审的抬头核对规则不跑。 */
  invoiceTitle: string | null
  invoiceTaxNo: string | null
}

async function getRow(db: Db, ctx: Ctx): Promise<AppSettings | undefined> {
  const rows = await db.select().from(appSettings).where(scope(appSettings, ctx.tenantId)).limit(1)
  return rows[0]
}

export async function getSettings(db: Db, ctx: Ctx): Promise<AppSettingsDTO> {
  const row = await getRow(db, ctx)
  return {
    systemName: row?.systemName ?? '',
    logoUrl: row?.logoUrl ?? null,
    timezone: row?.timezone || DEFAULT_TIMEZONE,
    invoiceTitle: row?.invoiceTitle ?? null,
    invoiceTaxNo: row?.invoiceTaxNo ?? null,
  }
}

/**
 * 本租户的开票信息(给报销/付款提交侧的 AI 预审信号采集用,系统路径无登录人,按 tenantId 隔离)。
 * 两个值都做了 trim;税号统一大写(社会信用代码不区分大小写,比对方免得两边各归一一遍)。
 */
export async function getTenantInvoiceTitle(db: Db, tenantId: string): Promise<{ title: string | null; taxNo: string | null }> {
  const rows = await db
    .select({ invoiceTitle: appSettings.invoiceTitle, invoiceTaxNo: appSettings.invoiceTaxNo })
    .from(appSettings)
    .where(scope(appSettings, tenantId))
    .limit(1)
  const title = rows[0]?.invoiceTitle?.trim() || null
  const taxNo = rows[0]?.invoiceTaxNo?.trim().toUpperCase() || null
  return { title, taxNo }
}

/**
 * 本租户的系统时区(无设置行 / 空值 → 默认东八区)。
 * ★给定时任务用:它们跨租户扫,必须按每个租户自己的时区判「几点」,不能用进程时区。
 * 不带 ctx 是因为调用方是系统任务(无登录人),按 tenantId 隔离已足够。
 */
export async function getTenantTimezone(db: Db, tenantId: string): Promise<string> {
  const rows = await db.select({ timezone: appSettings.timezone }).from(appSettings).where(scope(appSettings, tenantId)).limit(1)
  const tz = rows[0]?.timezone
  return tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE
}

export async function saveSettings(
  db: Db,
  ctx: Ctx,
  input: { systemName: string; logoUrl: string | null; timezone: string; invoiceTitle?: string | null; invoiceTaxNo?: string | null },
): Promise<AppSettingsDTO> {
  const systemName = input.systemName.trim()
  if (systemName.length > 60) throw new AppSettingsError('INVALID_INPUT', '系统名称不能超过 60 个字符')
  const logoUrl = input.logoUrl?.trim() || null
  const timezone = input.timezone.trim()
  // 写坏时区 = 所有定时提醒的「几点」全错,且错得很隐蔽 → 保存时就挡住,不留到运行期
  if (!isValidTimezone(timezone)) throw new AppSettingsError('INVALID_INPUT', `无法识别的时区「${timezone}」,请选择列表中的时区`)
  const invoiceTitle = input.invoiceTitle?.trim() || null
  const invoiceTaxNo = input.invoiceTaxNo?.trim().toUpperCase() || null
  if (invoiceTitle && invoiceTitle.length > 100) throw new AppSettingsError('INVALID_INPUT', '开票抬头不能超过 100 个字符')
  // 统一社会信用代码 18 位;老税务登记证号 15 位。配错税号会让预审把每张票都标红,入口就拦格式。
  if (invoiceTaxNo && !/^[0-9A-Z]{15,20}$/.test(invoiceTaxNo)) {
    throw new AppSettingsError('INVALID_INPUT', '税号格式不对:应为 15-20 位数字/大写字母(统一社会信用代码)')
  }

  const existing = await getRow(db, ctx)
  if (existing) {
    await auditedUpdate(db, appSettings, ctx.tenantId, existing.id, ctx.employeeId, { systemName, logoUrl, timezone, invoiceTitle, invoiceTaxNo })
  } else {
    await db.insert(appSettings).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      systemName,
      logoUrl,
      timezone,
      invoiceTitle,
      invoiceTaxNo,
    })
  }
  return { systemName, logoUrl, timezone, invoiceTitle, invoiceTaxNo }
}

// 允许的 logo 图片类型(常见位图 + svg;logo 是 visibility:'public',落 /uploads/branding/ 直链)
export const LOGO_UPLOAD_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] as const
export const MAX_LOGO_BYTES = 2 * 1024 * 1024 // 2MB

/**
 * 校验 logo 上传。★原实现是 `ALLOWED_LOGO_TYPES.includes(contentType)` —— contentType 取自
 * `file.type`,客户端说了算,扩展名根本不看;而 logo 落的是**公开直链**。声明一个 image/png、
 * 传一份 .html 上来,就得到一条同源免登录的 HTML 地址。现在判据交给 core/storage 的 checkUpload
 * (扩展名在册 ∧ 内容与扩展名相符),返回**归一后的 contentType**,调用方拿它去落库。
 */
export function assertAllowedLogo(bytes: Buffer, filename: string, size: number): string {
  if (size > MAX_LOGO_BYTES) throw new AppSettingsError('INVALID_INPUT', 'logo 图片不能超过 2MB')
  const checked = checkUpload(bytes, filename, LOGO_UPLOAD_EXTS)
  if (!checked.ok) throw new AppSettingsError('INVALID_INPUT', checked.reason)
  return checked.contentType
}
