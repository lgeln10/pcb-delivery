// core/http/tests/static-cache.test.ts
// 前端静态产物的**缓存与压缩**口径。这两件事在 2026-08-15 之前都是空的,而 App 壳把代价放到了最大:
// 壳登录后是 `location.replace(租户域名)`,**每次冷启动都是一次完整整页加载**,没有 SPA 常驻兜着。
//
// 钉死三条容易被改回去的:
//  ① 内容哈希过的 /assets/* 必须 immutable —— 因为 serveStatic **不处理条件请求**
//     (@hono/node-server 源码里没有 If-Modified-Since/ETag 分支,永远 200 全量流),
//     「回源验」在这套实现里等价于「整包重下」。immutable 是唯一能真正省掉重下的写法。
//  ② HTML 必须 no-cache —— 它是唯一的可变入口,缓存住它就会拿旧 HTML 去要已删掉的 chunk(白屏)。
//  ③ 非哈希的公开图(logo/avatars)**不能**给 no-cache —— 见 ①,那等于每次都重下 1MB 头像图。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { createApp } from '../app'
import { createOrgTestDb, type OrgTestDb } from '../../org/tests/helpers'

// 够长、可压缩,才能证明「发的是压缩版」不是巧合
const JS_BODY = `export const x = ${JSON.stringify('a'.repeat(4000))}\n`

describe('静态产物的缓存与压缩', () => {
  let t: OrgTestDb
  let dir: string
  let prevDist: string | undefined

  beforeEach(async () => {
    t = await createOrgTestDb()
    dir = mkdtempSync(join(tmpdir(), 'static-cache-'))
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>')
    // 真实 vite 命名:`<name>-<hash>.<ext>`
    writeFileSync(join(dir, 'assets', 'index-CF-q16lm.js'), JS_BODY)
    writeFileSync(join(dir, 'assets', 'index-CF-q16lm.js.br'), brotliCompressSync(Buffer.from(JS_BODY)))
    writeFileSync(join(dir, 'assets', 'index-CF-q16lm.js.gz'), gzipSync(Buffer.from(JS_BODY)))
    // public/ 原样拷过去的:没有哈希,内容可能随发版变
    writeFileSync(join(dir, 'logo.png'), 'PNG')
    prevDist = process.env.FRONTEND_DIST
    process.env.FRONTEND_DIST = dir // ★必须在 createApp 之前:serveStatic 的 root 在 .use() 那一刻就取值了
  })

  afterEach(async () => {
    if (prevDist === undefined) delete process.env.FRONTEND_DIST
    else process.env.FRONTEND_DIST = prevDist
    rmSync(dir, { recursive: true, force: true })
    await t?.close()
  })

  const app = () => createApp(t.db, { secret: 's' })

  it('★内容哈希资源 immutable 缓存一年 —— 没有 304 的实现里,这是唯一能真省掉重下的写法', async () => {
    const res = await app().request('/assets/index-CF-q16lm.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('★HTML 必须 no-cache:磁盘 index.html 与 SPA 兜底两条路都要', async () => {
    expect((await app().request('/')).headers.get('Cache-Control')).toBe('no-cache')
    // 前端路由的深链落到 SPA 兜底(c.html),同样是可变入口
    const deep = await app().request('/some/front-end/route')
    expect(deep.status).toBe(200)
    expect(deep.headers.get('Content-Type')).toContain('text/html')
    expect(deep.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('★非哈希公开图给一天,不给 no-cache —— no-cache 在这套实现里 = 每次整包重下', async () => {
    const res = await app().request('/logo.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400')
  })

  it('★支持 br 就发构建期压好的 .br,并带上 Vary', async () => {
    const res = await app().request('/assets/index-CF-q16lm.js', { headers: { 'Accept-Encoding': 'gzip, br' } })
    expect(res.headers.get('Content-Encoding')).toBe('br')
    expect(res.headers.get('Vary')).toContain('Accept-Encoding')
    expect(Number(res.headers.get('Content-Length'))).toBeLessThan(JS_BODY.length)
    // 压缩版也要照样 immutable —— 缓存键是路径,别让压缩分支绕过缓存头
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  it('只支持 gzip 的老内核回退到 .gz;两个都不支持则发原文件', async () => {
    const gz = await app().request('/assets/index-CF-q16lm.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(gz.headers.get('Content-Encoding')).toBe('gzip')
    const plain = await app().request('/assets/index-CF-q16lm.js', { headers: { 'Accept-Encoding': 'identity' } })
    expect(plain.headers.get('Content-Encoding')).toBeNull()
    expect(Number(plain.headers.get('Content-Length'))).toBe(JS_BODY.length)
  })

  it('★这层不碰 API:/api 响应不被加缓存头,私有文件那条更严的头也不被盖', async () => {
    const health = await app().request('/api/health')
    expect(health.status).toBe(200)
    expect(health.headers.get('Cache-Control')).toBeNull()
    // /api/files 无票据 403(不是 200)—— 中间件对非 200 直接跳过
    expect((await app().request('/api/files/feedback/x.png')).headers.get('Cache-Control')).toBeNull()
  })
})
