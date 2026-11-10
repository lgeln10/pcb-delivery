// core/http/app.ts
// 组合根:把平台壳和 PCB CAM 挂到一棵 Hono 树上。
// 安全模型:
//   - /api/auth/* 公开(只有 login)
//   - /api/health 公开(部署/负载均衡健康检查)
//   - 其余 /api/* 全部过 requireAuth(默认拒绝,未带 token 一律 401)
//   - 写操作再叠 requirePermission(403)
//   - 所有错误经 mapError 统一映射,不漏堆栈/SQL
//
// 公开面靠注册顺序:requireAuth 之前注册的路由不过鉴权。
// core/http/tests/public-surface.test.ts 把这条边界冻住。
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import { licenseWriteGuard, licenseFeatureGuard } from '../license/guard'
import { licenseRoutes } from '../license/routes'
import type { Db } from '../db/client'
import { mapError } from './errors'
import { auditWrites, requireAuth, type AppEnv } from './middleware'
import { privateFileRoutes, signPrivateFileUrls } from './private-files'
import { isPublicStorageKey } from '../storage/public-prefix'
import { securityHeaders, securityHeadersOptionsFromEnv } from './security-headers'
import { authRoutes } from '../auth/routes'
import { sessionRoutes } from '../auth/session-routes'
import { qrLoginPublicRoutes, qrLoginSessionRoutes } from '../auth/qr-login-routes'
import { auditRoutes } from '../audit/routes'
import { AUDIT_PERMISSIONS } from '../audit/permissions'
import { meRoute, orgRoutes } from '../org/routes'
import { ORG_PERMISSIONS } from '../org/permissions'
import { syncPermissions } from '../org/api'
import { llmRoutes } from '../llm/api'
import { storageRoutes } from '../storage/api'
import { pcbCamRoutes } from '../../modules/pcb-cam/routes'
import { PCB_CAM_PERMISSIONS } from '../../modules/pcb-cam/permissions'
import { notifyRoutes } from '../../modules/notify/routes'
import { NOTIFY_PERMISSIONS } from '../../modules/notify/permissions'
import { inappNotifyRoutes } from '../../modules/inapp-notify/routes'
import { appSettingsRoutes } from '../../modules/app-settings/routes'
import { APP_SETTINGS_PERMISSIONS } from '../../modules/app-settings/permissions'
import { featureToggleRoutes } from '../../modules/feature-toggle/routes'
import { FEATURE_TOGGLE_PERMISSIONS } from '../../modules/feature-toggle/permissions'
import { menuOrderRoutes } from '../../modules/menu-order/routes'
import { MENU_ORDER_PERMISSIONS } from '../../modules/menu-order/permissions'

export const ALL_PERMISSION_DEFS = [
  ...ORG_PERMISSIONS,
  ...PCB_CAM_PERMISSIONS,
  ...AUDIT_PERMISSIONS,
  ...NOTIFY_PERMISSIONS,
  ...APP_SETTINGS_PERMISSIONS,
  ...FEATURE_TOGGLE_PERMISSIONS,
  ...MENU_ORDER_PERMISSIONS,
]

/** 服务启动时调一次:幂等同步全部权限点 */
export async function syncAllPermissions(db: Db): Promise<void> {
  await syncPermissions(db, ALL_PERMISSION_DEFS)
}

/** CORS 放行的源。CORS_ORIGINS=逗号分隔的完整 origin;不设则用开发态默认表。 */
function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS?.trim()
  if (raw) return raw.split(',').map((x) => x.trim()).filter(Boolean)
  return ['http://127.0.0.1:5175', 'http://localhost:5175']
}

export function createApp(
  db: Db,
  opts: { secret: string; demoCredentials?: { phone: string; password: string } },
) {
  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    const { status, body } = mapError(err)
    if (status === 500) console.error('[http] internal error:', err)
    return c.json(body, status)
  })

  app.use('/*', securityHeaders(securityHeadersOptionsFromEnv()))

  app.use(
    '/api/*',
    cors({
      origin: corsOrigins(),
      allowHeaders: ['Authorization', 'Content-Type', 'X-Accounting-Entity'],
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  )

  const tooLarge = { error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大。' } }
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 * 1024, onError: (c) => c.json(tooLarge, 413) }))

  const built = app
    .use('/api/*', signPrivateFileUrls(opts.secret))
    .get('/api/health', (c) => c.json({ ok: true, demo: Boolean(opts.demoCredentials) }))
    .use('/uploads/*', async (c, next) => {
      let key: string
      try {
        key = decodeURIComponent(c.req.path.replace(/^\/uploads\/?/, ''))
      } catch {
        return c.notFound()
      }
      if (!isPublicStorageKey(key)) return c.notFound()
      await next()
      if (c.res.status === 200) {
        c.res.headers.set('X-Content-Type-Options', 'nosniff')
        c.res.headers.set('Content-Security-Policy', 'sandbox')
      }
    })
    .use(
      '/uploads/*',
      serveStatic({
        root: process.env.UPLOAD_DIR || 'uploads',
        rewriteRequestPath: (p) => p.replace(/^\/uploads/, ''),
      }),
    )
    .route('/api/auth', authRoutes(db, opts.secret, opts.demoCredentials))
    .route('/api/qr-login', qrLoginPublicRoutes(db, opts.secret))
    .route('/api/files', privateFileRoutes(db, opts.secret))
    .use('/api/*', requireAuth(db, opts.secret))
    .use('/api/*', licenseWriteGuard())
    .use('/api/*', licenseFeatureGuard())
    .use('/api/*', auditWrites(db))
    .route('/api/license', licenseRoutes(db))
    .route('/api/me', meRoute(db))
    .route('/api/session', sessionRoutes(db, opts.secret))
    .route('/api/session', qrLoginSessionRoutes(db, opts.secret))
    .route('/api/org', orgRoutes(db))
    .route('/api/pcb-cam', pcbCamRoutes(db))
    .route('/api/audit', auditRoutes(db))
    .route('/api/notify', notifyRoutes(db))
    .route('/api/inapp-notify', inappNotifyRoutes(db))
    .route('/api/app-settings', appSettingsRoutes(db))
    .route('/api/feature-toggles', featureToggleRoutes(db))
    .route('/api/menu-order', menuOrderRoutes(db))
    .route('/api/llm', llmRoutes(db))
    .route('/api/storage-config', storageRoutes(db))

  const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/
  const staticCacheHeaders = async (c: Context, next: Next) => {
    await next()
    if (c.res.status !== 200 || c.res.headers.has('Cache-Control')) return
    const isHtml = (c.res.headers.get('Content-Type') ?? '').startsWith('text/html')
    c.res.headers.set(
      'Cache-Control',
      isHtml ? 'no-cache' : HASHED_ASSET.test(c.req.path) ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
    )
  }
  built.use('/*', staticCacheHeaders)

  built.get('/version.json', (c) => {
    const frontendDist = process.env.FRONTEND_DIST
    if (frontendDist) {
      try {
        return c.body(readFileSync(`${frontendDist}/version.json`, 'utf8'), 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
      } catch {
        /* 没有版本标记 → 404 */
      }
    }
    return c.notFound()
  })

  const dist = process.env.FRONTEND_DIST
  if (dist) {
    let indexHtml = ''
    try {
      indexHtml = readFileSync(`${dist}/index.html`, 'utf8')
    } catch {
      /* 没有 index.html → SPA 兜底不启用 */
    }
    built.use('/*', serveStatic({ root: dist, precompressed: true }))
    built.get('*', (c, next) => {
      const p = c.req.path
      if (!indexHtml || p.startsWith('/api') || p.startsWith('/uploads')) return next()
      return c.html(indexHtml)
    })
  }
  return built
}

export type AppType = ReturnType<typeof createApp>
