// modules/app-settings/model.ts
// 系统设置:每租户一行的品牌配置(系统名称 + 企业 logo)。替换左上角品牌区与浏览器标签页标题。
import { sql } from 'drizzle-orm'
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { commonFields } from '../../core/db/common-fields'

export const appSettings = pgTable(
  'app_settings',
  {
    ...commonFields,
    systemName: text('system_name').notNull().default(''), // 空串 → 前端回落默认名
    logoUrl: text('logo_url'), // 外网可访问的 logo URL(本地 /uploads 或 OSS);null 表示用默认图标
    // 系统时区(IANA 名,如 Asia/Shanghai):所有「几点发提醒 / 今天算哪一天」的业务判定按它算,
    // 不看进程时区(容器默认 UTC,靠它会整整错开 8 小时)。合法性由 logic 层 isValidTimezone 校验。
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    // 本公司开票信息(发票买方抬头全称 + 统一社会信用代码)。AI 预审用它核对报销/付款发票的买方是否是
    // 本公司 —— 空着规则就不跑,不会误伤没配置的租户。放这而不放 fin_entity_settings:那张表按账套实体分行,
    // 报销提交时点不知道实体;而「公司抬头」对绝大多数客户就是租户级一个值。
    invoiceTitle: text('invoice_title'),
    invoiceTaxNo: text('invoice_tax_no'),
  },
  (t) => [
    uniqueIndex('app_settings_tenant_idx').on(t.tenantId).where(sql`is_deleted = false`),
  ],
)
export type AppSettings = typeof appSettings.$inferSelect
