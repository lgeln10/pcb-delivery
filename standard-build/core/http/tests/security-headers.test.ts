// core/http/tests/security-headers.test.ts
// 全站安全响应头。重点不是「头在不在」,而是两件容易做错的事:
//  ① 全站策略**不能**盖掉 /uploads 与 /api/files 上那条更严的 `sandbox`
//     —— 那是 C1 收窄用户上传文件的那道闸,被盖掉等于白改;
//  ② script-src 必须真的收紧到 'self',否则这套头只是好看。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../app'
import { buildCsp, securityHeadersOptionsFromEnv } from '../security-headers'
import { createOrgTestDb, type OrgTestDb } from '../../org/tests/helpers'

function parseCsp(v: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of v.split(';')) {
    const seg = part.trim()
    if (!seg) continue
    const sp = seg.indexOf(' ')
    if (sp < 0) out[seg] = ''
    else out[seg.slice(0, sp)] = seg.slice(sp + 1).trim()
  }
  return out
}

describe('默认 CSP 策略', () => {
  const csp = parseCsp(buildCsp())

  it('★script-src 收到 self —— 这条是挡「同源 XSS 取走 localStorage 里的 token」的那条', () => {
    expect(csp['script-src']).toBe("'self'")
  })

  it('★不给 unsafe-eval / unsafe-inline 到 script-src(本仓源码无 eval / new Function)', () => {
    expect(csp['script-src']).not.toContain('unsafe-eval')
    expect(csp['script-src']).not.toContain('unsafe-inline')
  })

  it('style-src 必须带 unsafe-inline —— index.html 的启动骨架就是内联 <style>,收紧会白屏', () => {
    expect(csp['style-src']).toContain("'unsafe-inline'")
  })

  it('零风险的那几条都在:object-src none / base-uri self / form-action self / frame-ancestors none', () => {
    expect(csp['object-src']).toBe("'none'")
    expect(csp['base-uri']).toBe("'self'")
    expect(csp['form-action']).toBe("'self'")
    expect(csp['frame-ancestors']).toBe("'none'")
  })

  it('★connect-src 与 img-src 显式放到协议级 —— 对象存储直传与预签名下载的域名随租户配置而变,写死 self 会在客户环境里表现成「上传转圈但不报错」', () => {
    expect(csp['connect-src']).toContain('https:')
    expect(csp['img-src']).toContain('https:')
    expect(csp['img-src']).toContain('blob:') // 本地预览 / Canvas 导出
  })

  it('CSP_POLICY 可整条覆盖(客户接 CDN 时不必改代码重新发版)', () => {
    expect(buildCsp({ policy: "default-src 'none'" })).toBe("default-src 'none'")
    const fromEnv = securityHeadersOptionsFromEnv({ CSP_POLICY: "img-src *" } as NodeJS.ProcessEnv)
    expect(fromEnv.policy).toBe('img-src *')
  })

  it('CSP_REPORT_ONLY=1 降级为只上报(排障用)', () => {
    expect(securityHeadersOptionsFromEnv({ CSP_REPORT_ONLY: '1' } as NodeJS.ProcessEnv).reportOnly).toBe(true)
    expect(securityHeadersOptionsFromEnv({} as NodeJS.ProcessEnv).reportOnly).toBe(false)
  })

  it('★CSP_FRAME_ANCESTORS 只换 frame-ancestors 那一条,其余(尤其 script-src)一个字不动', () => {
    const relaxed = parseCsp(buildCsp({ frameAncestors: 'https://*.feishu.cn' }))
    expect(relaxed['frame-ancestors']).toBe('https://*.feishu.cn')
    expect(relaxed['script-src']).toBe("'self'") // ★放行内嵌不该顺手把防 XSS 那条也放松
    expect(relaxed['object-src']).toBe("'none'")
    expect(securityHeadersOptionsFromEnv({ CSP_FRAME_ANCESTORS: ' https://a.example ' } as NodeJS.ProcessEnv).frameAncestors).toBe(
      'https://a.example',
    )
  })
})

describe('经真 HTTP 的响应头', () => {
  let t: OrgTestDb
  let dir: string
  let prevUploadDir: string | undefined

  beforeEach(async () => {
    t = await createOrgTestDb()
    dir = mkdtempSync(join(tmpdir(), 'sec-headers-'))
    mkdirSync(join(dir, 'branding'), { recursive: true })
    writeFileSync(join(dir, 'branding', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    prevUploadDir = process.env.UPLOAD_DIR
    process.env.UPLOAD_DIR = dir // ★必须在 createApp 之前:serveStatic 的 root 在 .use() 那一刻就取值了
  })

  afterEach(async () => {
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR
    else process.env.UPLOAD_DIR = prevUploadDir
    rmSync(dir, { recursive: true, force: true })
    await t?.close()
  })

  it('API 响应带上全套头', async () => {
    const app = createApp(t.db, { secret: 's' })
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'")
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('未鉴权的 401 响应也带头(错误路径同样是攻击面)', async () => {
    const app = createApp(t.db, { secret: 's' })
    const res = await app.request('/api/org/employees')
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Security-Policy')).toContain("object-src 'none'")
  })

  it('★公开静态文件保住的是更严的 sandbox,不被全站策略盖掉', async () => {
    const app = createApp(t.db, { secret: 's' })
    const res = await app.request('/uploads/branding/logo.svg')
    expect(res.status).toBe(200)
    // 全站策略允许 script-src 'self';对**用户上传的 svg** 那是不够的 —— 必须仍是无源沙箱。
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('私有文件端点(无票据 403)也不被盖掉', async () => {
    const app = createApp(t.db, { secret: 's' })
    const res = await app.request('/api/files/feedback/x.png')
    expect(res.status).toBe(403)
  })

  it('★设了 CSP_FRAME_ANCESTORS 就不再发 X-Frame-Options —— 否则老浏览器认它,白名单等于没配', async () => {
    const prev = process.env.CSP_FRAME_ANCESTORS
    process.env.CSP_FRAME_ANCESTORS = 'https://*.feishu.cn'
    try {
      const app = createApp(t.db, { secret: 's' })
      const res = await app.request('/api/health')
      expect(res.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://*.feishu.cn')
      expect(res.headers.get('X-Frame-Options')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.CSP_FRAME_ANCESTORS
      else process.env.CSP_FRAME_ANCESTORS = prev
    }
  })
})
