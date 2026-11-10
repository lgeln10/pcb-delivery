// core/http/tests/uploads-public-scope.test.ts
// /uploads/* 公开静态只放公开前缀 —— 经真 HTTP 验,不是只验那个纯函数。
//
// 被修的是什么(2026-08-15 安全梳理 C1-b):本地存储模式下 putObject 把**公私文件写在同一个
// UPLOAD_DIR**,而 /uploads/* 当时把整个目录都开成了匿名静态。于是任何一条
// `/api/files/<key>?t=<15 分钟票据>` 只要去掉 `?t=`、把前缀换成 `/uploads/`,
// 就变成一条**永不过期、免登录**的直链 —— 发票、合同、身份证扫描件全在里面,整套票据机制被旁路。
//
// 这里的每条断言都钉住修完之后的性质;删掉任何一条,那条旁路就可能悄悄回来。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Hono } from 'hono'
import { createOrgTestDb, type OrgTestDb } from '../../org/tests/helpers'
import { createApp, syncAllPermissions } from '../app'
import type { AppEnv } from '../middleware'

let t: OrgTestDb
let app: Hono<AppEnv>
let dir: string
let prevUploadDir: string | undefined

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>')

beforeAll(async () => {
  // 目录建在 cwd 下:serveStatic 的 root 按 cwd 解析相对路径。
  dir = await mkdtemp(join(process.cwd(), '.tmp-uploads-test-'))
  for (const p of ['branding', 'website', 'feedback', 'finance', 'hr']) await mkdir(join(dir, p), { recursive: true })
  await writeFile(join(dir, 'branding/logo.svg'), SVG)
  await writeFile(join(dir, 'website/hero.png'), PNG)
  await writeFile(join(dir, 'feedback/需求附件.png'), PNG)
  await writeFile(join(dir, 'finance/发票.pdf'), Buffer.from('%PDF-1.7'))
  await writeFile(join(dir, 'hr/身份证.png'), PNG)

  prevUploadDir = process.env.UPLOAD_DIR
  // serveStatic 的 root 在 .use() 那一刻取值,故必须在 createApp 之前设。
  process.env.UPLOAD_DIR = relative(process.cwd(), dir)

  t = await createOrgTestDb()
  await syncAllPermissions(t.db)
  app = createApp(t.db, { secret: 'uploads-scope-test' })
})

afterAll(async () => {
  if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR
  else process.env.UPLOAD_DIR = prevUploadDir
  await rm(dir, { recursive: true, force: true })
  await t?.close()
})

const get = (p: string) => app.request(p)

describe('/uploads/* 只放公开前缀', () => {
  it('公开前缀照常匿名可读(logo 未登录的登录页要显示;官网图爬虫要读)', async () => {
    expect((await get('/uploads/branding/logo.svg')).status).toBe(200)
    expect((await get('/uploads/website/hero.png')).status).toBe(200)
  })

  it('★核心:私有前缀一律 404 —— 不带票据就拿不到,而且不给探测面(不是 403)', async () => {
    for (const p of [
      '/uploads/feedback/' + encodeURIComponent('需求附件.png'),
      '/uploads/finance/' + encodeURIComponent('发票.pdf'),
      '/uploads/hr/' + encodeURIComponent('身份证.png'),
    ]) {
      const res = await get(p)
      expect(res.status, `${p} 应 404`).toBe(404)
    }
  })

  it('★核心:「已知一条票据地址 → 去掉 ?t= 换成 /uploads/」这条旁路被封', async () => {
    // 票据地址长这样:/api/files/feedback/x.png?t=<hmac>。攻击者手上有 key 就够了。
    const key = 'feedback/' + encodeURIComponent('需求附件.png')
    expect((await get(`/api/files/${key}`)).status).toBe(403) // 无票据:票据端点自己拒
    expect((await get(`/uploads/${key}`)).status).toBe(404) // 旁路:静态口不认这个前缀
  })

  it('前缀混淆与路径穿越都拿不到东西', async () => {
    for (const p of [
      '/uploads/websiteX/hero.png',
      '/uploads/website/../feedback/x.png',
      '/uploads/' + encodeURIComponent('../') + 'feedback/x.png',
    ]) {
      expect((await get(p)).status, `${p} 不该 200`).not.toBe(200)
    }
  })

  it('公开静态带 nosniff + CSP sandbox —— logo 允许 svg,靠这两个头让它无法被当页面执行', async () => {
    const res = await get('/uploads/branding/logo.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
  })
})
