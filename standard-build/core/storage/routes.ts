// core/storage/routes.ts — 平台文件存储配置 HTTP 路由(挂在「系统设置 → 文件存储」)。
// 读/写都需 app-settings:manage(存储是平台级基础设施,归系统设置管理员维护)。
import { Hono } from 'hono'
import { z } from 'zod'
import type { Ctx, Db } from '../db/client'
import type { AppEnv } from '../http/middleware'
import { requirePermission } from '../http/middleware'
import { deleteProviderConfig, getConfig, saveProviderConfig, setActiveProvider } from './config'
import { testProvider } from './service'
import { migrateLocalToActiveCloud } from './migrate'
import { repairPublicObjectAcl } from './repair-public'

const ActiveBody = z.object({ activeProvider: z.enum(['local', 'oss', 'tos']) })
const SaveBody = z.object({
  region: z.string().optional(),
  bucket: z.string().optional(),
  endpoint: z.string().optional(),
  publicBase: z.string().optional(),
  accessKeyId: z.string().optional(),
  accessKeySecret: z.string().optional(),
})

export function storageRoutes(db: Db) {
  const manage = requirePermission(db, 'app-settings:manage')
  const ctxOf = (c: { get: (k: 'ctx') => Ctx }) => c.get('ctx')

  return new Hono<AppEnv>()
    .get('/config', manage, async (c) => c.json(await getConfig(db, ctxOf(c))))
    .patch('/config', manage, async (c) => c.json(await setActiveProvider(db, ctxOf(c), ActiveBody.parse(await c.req.json()).activeProvider)))
    // 保存某 provider 参数(secret 加密入库,不传则保留原密文)
    .put('/config/provider/:provider', manage, async (c) =>
      c.json(await saveProviderConfig(db, ctxOf(c), c.req.param('provider'), SaveBody.parse(await c.req.json()))),
    )
    .delete('/config/provider/:provider', manage, async (c) => c.json(await deleteProviderConfig(db, ctxOf(c), c.req.param('provider'))))
    // 测试连接:用已存参数上传探针再删除
    .post('/config/provider/:provider/test', manage, async (c) => {
      await testProvider(db, ctxOf(c), c.req.param('provider'))
      return c.json({ ok: true })
    })
    // 一键迁移:把本地 /uploads 文件传到当前生效的云存储,并改写本租户所有数据指向(本地文件保留做备份)
    .post('/migrate-to-cloud', manage, async (c) => c.json(await migrateLocalToActiveCloud(db, ctxOf(c))))
    // 修复公开文件权限:给系统 logo / 官网图片重打 public-read(私有桶启用前上传的没打过 ACL,会打不开)
    .post('/repair-public-acl', manage, async (c) => c.json(await repairPublicObjectAcl(db, ctxOf(c))))
}
