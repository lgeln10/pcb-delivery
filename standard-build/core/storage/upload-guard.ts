// core/storage/upload-guard.ts
// 上传类型校验。★文件名与 Content-Type **都来自客户端,一律不可信**;判定以文件头魔数为准,
// 落库/出站用的类型以本文件归一后的值为准,不用客户端那个。
//
// 为什么要有这个文件:同一个洞在三处各写了一遍 ——
//   modules/feedback/routes.ts    `ALLOWED_EXT.test(name) || contentType.startsWith('image/')`
//                                  → `||` 让扩展名白名单形同虚设:evil.html 声明成 image/png 就整条过
//   modules/website/routes.ts     `/^image\/(png|…|svg\+xml)$/.test(file.type)`
//                                  → 只看客户端声明的类型,**扩展名根本不看**;而官网图是 public,
//                                    落地成 /uploads/website/<uuid>-evil.html 的永久公开直链
//   modules/app-settings/routes.ts `assertAllowedLogo(file.type, size)` → 同上
// 三处都能被同一招穿:声明一个图片 MIME,传一个 .html/.svg 进去,拿到同源公开地址。
//
// 现在的判定是**合取**,不是析取:
//   ① 扩展名必须在本次调用给的白名单里(白名单是「这个业务允许什么」,不是「客户端说是什么」);
//   ② 内容必须与该扩展名相符 —— 有确定魔数的类型逐字节比对;文本/旧 Office 这类没有可靠魔数的,
//      改为**否定式**判据:内容一旦看起来像 HTML/SVG/XML 就拒(那正是能被当页面渲染的东西);
//   ③ 返回**归一后的 contentType**,调用方必须用它去 putObject —— 存进去什么类型,将来就以什么
//      类型出站。客户端说一句 text/html 不该让附件变成页面。
//
// ★这一层是「带」,不是「braces」:即便判定被绕过,服务端仍要保证私有文件只走 /api/files 票据、
//   公开静态只放公开前缀且带 nosniff + CSP sandbox(见 core/http/app.ts 与 core/http/private-files.ts)。
//   两层都在,才算真的关上。

/** 扩展名 → 归一 MIME + 内容判据。key 一律小写、不带点。 */
type Sig = { mime: string; test: (b: Buffer) => boolean }

const startsWithBytes = (b: Buffer, bytes: number[]): boolean =>
  b.length >= bytes.length && bytes.every((v, i) => b[i] === v)

const startsWithAscii = (b: Buffer, s: string): boolean => b.subarray(0, s.length).toString('latin1') === s

/** ZIP 本地文件头(xlsx/docx 是 zip 容器);空 zip 与跨盘 zip 的另两种签名一并认。 */
const isZip = (b: Buffer): boolean =>
  startsWithAscii(b, 'PK\x03\x04') || startsWithAscii(b, 'PK\x05\x06') || startsWithAscii(b, 'PK\x07\x08')

/** OLE2 复合文档(老版 .xls/.doc)。 */
const isOle2 = (b: Buffer): boolean => startsWithBytes(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

/**
 * 内容看起来像标记语言吗(HTML / SVG / 通用 XML)。
 * ★这是文本类与旧 Office 的**否定式**判据:它们没有可靠魔数,与其要求「必须像什么」,
 *   不如卡死「不许像什么」—— 能被浏览器当页面执行的就是这几种开头。
 *   跳过 BOM 与前导空白后看头 512 字节,大小写不敏感。
 */
export function looksLikeMarkup(b: Buffer): boolean {
  let head = b.subarray(0, 512).toString('utf8')
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1) // UTF-8 BOM
  // \u0000 必须写成转义序列：源码里真放一个 NUL 字节会让 git 把这个 .ts 当二进制文件
  //   （不出 diff、不能合并），2026-08-27 改掉。行为不变。
  const t = head.replace(/^[\s\u0000]+/, '').toLowerCase()
  return t.startsWith('<!doctype') || t.startsWith('<html') || t.startsWith('<svg') || t.startsWith('<?xml') || t.startsWith('<script')
}

/** 纯文本判据:不是标记语言,且不含 NUL(NUL = 二进制伪装成 .txt)。 */
const isPlainTextish = (b: Buffer): boolean => !looksLikeMarkup(b) && !b.subarray(0, 8192).includes(0x00)

/** SVG 判据:必须真的是 XML/SVG 开头(否则它就不是图,是别的东西改了扩展名)。 */
const isSvg = (b: Buffer): boolean => {
  const t = b.subarray(0, 512).toString('utf8').replace(/^[\s﻿]+/, '').toLowerCase()
  return t.startsWith('<?xml') || t.startsWith('<svg') || t.startsWith('<!doctype svg')
}

const SIGNATURES: Record<string, Sig> = {
  png: { mime: 'image/png', test: (b) => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: 'image/jpeg', test: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', test: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]) },
  gif: { mime: 'image/gif', test: (b) => startsWithAscii(b, 'GIF87a') || startsWithAscii(b, 'GIF89a') },
  webp: { mime: 'image/webp', test: (b) => startsWithAscii(b, 'RIFF') && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  bmp: { mime: 'image/bmp', test: (b) => startsWithAscii(b, 'BM') },
  // ★svg 只给官网/logo 用(见各调用方白名单),且服务端不消毒 —— 它的安全性由「出站带
  //   Content-Security-Policy: sandbox + nosniff」保证:<img> 里的 SVG 本来就不执行脚本,
  //   而直接导航到它的那条路被 sandbox 掐掉。需求附件那类不可信来源不放行 svg。
  svg: { mime: 'image/svg+xml', test: isSvg },
  pdf: { mime: 'application/pdf', test: (b) => startsWithAscii(b, '%PDF-') },
  // OFD 版式发票(数电票原件,GB/T 33190):ZIP 容器,与 xlsx/docx 同判 PK 头。
  // MIME 用 application/ofd,与 core/ocr 的 isOfd、modules/reimbursement/invoice-download 的扩展名表一致。
  ofd: { mime: 'application/ofd', test: isZip },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: isZip },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: isZip },
  // 老版 Office:OLE2 是常态,但「csv/xml 改名成 .xls」在真实世界很常见,故放宽成否定式判据。
  xls: { mime: 'application/vnd.ms-excel', test: (b) => isOle2(b) || isZip(b) || isPlainTextish(b) },
  doc: { mime: 'application/msword', test: (b) => isOle2(b) || isZip(b) || isPlainTextish(b) },
  csv: { mime: 'text/csv; charset=utf-8', test: isPlainTextish },
  txt: { mime: 'text/plain; charset=utf-8', test: isPlainTextish },
  md: { mime: 'text/markdown; charset=utf-8', test: isPlainTextish },
  markdown: { mime: 'text/markdown; charset=utf-8', test: isPlainTextish },
}

/** 已登记的全部扩展名(护栏测试用:白名单不得出现表外的名字)。 */
export const KNOWN_UPLOAD_EXTS = Object.keys(SIGNATURES)

export type UploadCheck = { ok: true; ext: string; contentType: string } | { ok: false; reason: string }

/** 取小写扩展名(不含点)。无扩展名返回空串。 */
export function extOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 校验一个上传。**bytes 必须是完整文件内容**(调用方先做大小上限再调这里)。
 *
 * @param allowedExts 本业务允许的扩展名(小写、不带点)。必须是 SIGNATURES 里登记过的。
 * @returns ok 时带**归一后的 contentType** —— 调用方必须拿它去 putObject,不要再用客户端那个。
 */
export function checkUpload(bytes: Buffer, filename: string, allowedExts: readonly string[]): UploadCheck {
  const ext = extOf(filename)
  if (!ext) return { ok: false, reason: '文件必须带扩展名' }
  if (!allowedExts.includes(ext)) {
    return { ok: false, reason: `不支持的文件类型 .${ext}(支持:${allowedExts.map((e) => '.' + e).join(' ')})` }
  }
  const sig = SIGNATURES[ext]
  // 白名单里出现表外扩展名 = 调用方写错了。宁可拒绝也不放行(护栏测试会在上线前抓到)。
  if (!sig) return { ok: false, reason: `不支持的文件类型 .${ext}` }
  if (bytes.length === 0) return { ok: false, reason: '文件内容为空' }
  if (!sig.test(bytes)) {
    return { ok: false, reason: `文件内容与扩展名 .${ext} 不符(请不要改扩展名后上传)` }
  }
  return { ok: true, ext, contentType: sig.mime }
}
