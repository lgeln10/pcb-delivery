// core/http/tests/version-endpoint.test.ts
// 部署版本标记 /version.json 的直出口径。钉死两条:
//
//  ① **官网兜底不许吞它。** 官网迁移(阶段1-4)后,官网 host 下带扩展名的路径会先查
//     WEBSITE_DIST,查不到就落进官网 get('*') 注入兜底 —— 200 + index.html。
//     而 deploy-guard 与部署后冒烟都按「返回体是不是 JSON」判定线上版本:
//     拿到 HTML 只能解析失败 → verdict=unknown 静默跳过,版本漂移检测等于失明。
//     所以 /version.json 必须注册在两个 HTML 兜底之前,永远 JSON 直出。
//  ② **没有文件就 404,不是 200+HTML。** 对探针,404 是「没有版本标记」;
//     200+HTML 是假绿 —— 这正是要治的病。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { createOrgTestDb, type OrgTestDb } from '../../org/tests/helpers'

const VERSION = '{"sha":"abc123","deployed_at":"2026-08-24T00:00:00Z"}\n'

describe('/version.json 直出', () => {
  let t: OrgTestDb
  let dist: string
  let websiteDist: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    t = await createOrgTestDb()
    dist = mkdtempSync(join(tmpdir(), 'version-dist-'))
    websiteDist = mkdtempSync(join(tmpdir(), 'version-website-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>')
    writeFileSync(join(websiteDist, 'index.html'), '<!doctype html><title>site</title>')
    for (const k of ['FRONTEND_DIST', 'WEBSITE_DIST', 'WEBSITE_HOST']) prev[k] = process.env[k]
    // ★必须在 createApp 之前:三个 env 都是在 createApp 里那一刻取值的
    process.env.FRONTEND_DIST = dist
    process.env.WEBSITE_DIST = websiteDist
    process.env.WEBSITE_HOST = 'www.example.com'
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dist, { recursive: true, force: true })
    rmSync(websiteDist, { recursive: true, force: true })
    await t?.close()
  })

  const app = () => createApp(t.db, { secret: 's' })

  it('★官网 host 下也 JSON 直出 —— 不落进官网注入兜底(此前正是在这条路上被吞成 HTML)', async () => {
    writeFileSync(join(dist, 'version.json'), VERSION)
    const res = await app().request('/version.json', { headers: { host: 'www.example.com' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(JSON.parse(await res.text()).sha).toBe('abc123')
  })

  it('管理端 host 下同样直出,且 no-store —— 版本探针不许被缓存住', async () => {
    writeFileSync(join(dist, 'version.json'), VERSION)
    const res = await app().request('/version.json', { headers: { host: 'admin.example.com' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(JSON.parse(await res.text()).sha).toBe('abc123')
  })

  it('★文件不存在 → 404,不是 200+HTML —— 对探针,404 才是诚实的「没有版本标记」', async () => {
    const onWebsite = await app().request('/version.json', { headers: { host: 'www.example.com' } })
    expect(onWebsite.status).toBe(404)
    const onAdmin = await app().request('/version.json', { headers: { host: 'admin.example.com' } })
    expect(onAdmin.status).toBe(404)
  })

  it('发版换文件不用重启:每次现读,新内容立即生效', async () => {
    writeFileSync(join(dist, 'version.json'), VERSION)
    const a = app()
    expect(JSON.parse(await (await a.request('/version.json')).text()).sha).toBe('abc123')
    writeFileSync(join(dist, 'version.json'), '{"sha":"def456"}')
    expect(JSON.parse(await (await a.request('/version.json')).text()).sha).toBe('def456')
  })
})
