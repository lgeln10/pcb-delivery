// core/http/tests/public-surface.test.ts
// ★护栏:冻结「不需要登录就能打到」的路由集合。
//
// 为什么需要它:core/http/app.ts 的默认拒绝链靠的是**注册顺序** ——
// `.use('/api/*', requireAuth(...))` 之前注册的路由不过鉴权,之后的才过。
// 这条边界现在只由源码里的注释纪律维持:新加一条 `.route()` 时手滑放到了 requireAuth 之前,
// **整个模块就静默变成公开的,不会有任何地方报错**,类型检查和现有测试全绿。
//
// 这道护栏把那条边界变成会说不的东西:公开面变了就红,红了要么把路由挪到 requireAuth 之后,
// 要么在下面的白名单里显式加一行**并写清楚为什么它可以公开**。
//
// 形状与 modules/digitalemployee/approval.ts 的 WRITE_TOOLS 差集护栏一致:
// 不是断言「有没有鉴权」,而是断言「有意公开的清单」与「实际公开的清单」逐条相等。
import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { createOrgTestDb, type OrgTestDb } from '../../org/tests/helpers'

/**
 * 已批准的公开面。**每加一条都要写清楚凭什么可以不登录。**
 *
 * 判据:调用方不是本站已登录员工,且它自带一种不依赖登录会话的身份证明
 * (票据 / 平台签名 / 密钥 / 一次性授权码),或者它本来就该匿名(健康检查、公网官网)。
 */
const APPROVED_PUBLIC_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: '/api/health', why: '健康检查:只回 ok 与演示登录是否开启,不含任何租户数据' },
  { prefix: '/api/auth', why: '登录本身。未登录才需要它' },
  { prefix: '/api/files', why: '私有文件下载:<img>/<a> 带不了 Authorization 头,票据即凭证(HMAC 绑租户+key,15 分钟)' },
  {
    prefix: '/api/qr-login',
    why: '扫码登录的手机那一半:手机此刻还没有会话。凭据是电脑屏幕上那张二维码里的一次性票(256 bit 随机、2 分钟、一次性),而且**光有票也换不到令牌** —— 必须回电脑上点一次确认(decideQrTicket 只认 scanned→approved)。PC 那一半在 /api/session/qr,在 requireAuth 之后',
  },
]

/**
 * 取「注册在 requireAuth 之前」的 /api 路由。依赖 requireAuth 返回的中间件保持具名(见 middleware.ts)。
 * ★handler 在 Hono 的类型里是可调用的 `H`,函数名不在它的类型面上,故显式取 `.name`。
 */
function collectPublicApiPaths(app: ReturnType<typeof createApp>): string[] {
  const routes = app.routes as ReadonlyArray<{ path: string; handler: unknown }>
  const gateIndex = routes.findIndex((r) => (r.handler as { name?: string } | undefined)?.name === 'requireAuthHandler')
  // ★找不到分界线就直接失败,而不是「前面 0 条,断言恰好通过」——
  //   护栏最怕的失效方式是它自己变成了永真。
  expect(gateIndex, 'requireAuth 的中间件必须保持具名 requireAuthHandler,否则这道护栏定位不到分界线').toBeGreaterThan(-1)
  return routes
    .slice(0, gateIndex)
    .map((r) => r.path)
    .filter((p) => p.startsWith('/api'))
    .filter((p) => p !== '/api/*') // 通配中间件(cors / 出站文件地址改写 / 安全头)不是路由本身
}

/** 路由全路径 → 它落在哪个已批准前缀下;都不匹配返回 null。 */
function matchApproved(path: string): string | null {
  for (const { prefix } of APPROVED_PUBLIC_PREFIXES) {
    if (path === prefix || path.startsWith(prefix + '/')) return prefix
  }
  return null
}

describe('公开面白名单', () => {
  it('★requireAuth 之前的每一条 /api 路由都必须在已批准清单里', async () => {
    const t: OrgTestDb = await createOrgTestDb()
    try {
      const app = createApp(t.db, { secret: 'test-secret' })
      const publicPaths = collectPublicApiPaths(app)
      expect(publicPaths.length, '一条公开路由都没找到,说明这道护栏没在真正检查东西').toBeGreaterThan(0)

      const unapproved = publicPaths.filter((p) => matchApproved(p) === null)
      expect(
        unapproved,
        '这些路由注册在 requireAuth 之前 = 任何人不登录就能打到。' +
          '要么把它挪到 requireAuth 之后,要么在 APPROVED_PUBLIC_PREFIXES 里加一行并写明凭什么可以公开',
      ).toEqual([])
    } finally {
      await t?.close()
    }
  })

  it('★白名单里不能有已经没人用的前缀(否则它会悄悄放行以后新加的同前缀路由)', async () => {
    const t: OrgTestDb = await createOrgTestDb()
    try {
      const app = createApp(t.db, { secret: 'test-secret' })
      const publicPaths = collectPublicApiPaths(app)
      const used = new Set(publicPaths.map(matchApproved).filter((x): x is string => x !== null))
      const stale = APPROVED_PUBLIC_PREFIXES.map((e) => e.prefix).filter((p) => !used.has(p))
      expect(stale, '这些前缀已经没有任何公开路由在用,删掉——留着等于给未来的同名路由预先开了口子').toEqual([])
    } finally {
      await t?.close()
    }
  })

  it('每条已批准的公开面都写了理由', () => {
    const missing = APPROVED_PUBLIC_PREFIXES.filter((e) => e.why.trim().length < 10).map((e) => e.prefix)
    expect(missing, '公开一条路由必须写清楚凭什么可以不登录,一句话也行').toEqual([])
  })
})
