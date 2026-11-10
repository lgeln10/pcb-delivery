// modules/app-settings/routes.ts — 系统设置 HTTP 路由。
// GET 仅需登录(所有用户都要拿品牌渲染壳层);写操作叠 app-settings:manage 权限。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../../core/db/client'
import type { AppEnv } from '../../core/http/middleware'
import { requirePermission } from '../../core/http/middleware'
import { AppSettingsError } from './errors'
import { assertAllowedLogo, getSettings, saveSettings } from './logic'
import { storeLogo } from './storage'

const SaveBody = z.object({
  systemName: z.string().max(60),
  logoUrl: z.string().max(2000).nullable().optional(),
  // 时区可不传(老前端/老脚本):不传则沿用库里现值,不会被悄悄改成默认值
  timezone: z.string().max(64).optional(),
  // 开票信息同理:不传 = 不动现值(undefined);传 null/空串 = 清空
  invoiceTitle: z.string().max(100).nullable().optional(),
  invoiceTaxNo: z.string().max(20).nullable().optional(),
})

export function appSettingsRoutes(db: Db) {
  const manage = requirePermission(db, 'app-settings:manage')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await getSettings(db, ctxOf(c))))
    .patch('/', manage, async (c) => {
      const body = SaveBody.parse(await c.req.json())
      const current = await getSettings(db, ctxOf(c))
      return c.json(
        await saveSettings(db, ctxOf(c), {
          systemName: body.systemName,
          logoUrl: body.logoUrl ?? null,
          timezone: body.timezone ?? current.timezone, // 没传 = 不动时区
          invoiceTitle: body.invoiceTitle === undefined ? current.invoiceTitle : body.invoiceTitle,
          invoiceTaxNo: body.invoiceTaxNo === undefined ? current.invoiceTaxNo : body.invoiceTaxNo,
        }),
      )
    })
    .post('/logo', manage, async (c) => {
      const form = await c.req.parseBody()
      const file = form['file']
      if (!(file instanceof File)) throw new AppSettingsError('INVALID_INPUT', '缺少上传文件')
      const bytes = Buffer.from(await file.arrayBuffer())
      // 先读字节再判类型:判据看内容,客户端声明的 file.type 不参与决策;落库用归一后的类型。
      const contentType = assertAllowedLogo(bytes, file.name || '', file.size)
      const stored = await storeLogo(db, ctxOf(c), {
        bytes,
        filename: file.name || 'logo',
        contentType,
      })
      return c.json({ url: stored.url }, 201)
    })
}
