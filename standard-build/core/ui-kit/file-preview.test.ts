// @vitest-environment jsdom
// FilePreview:OFD 结构化票面 + PDF 双通道(iframe / pdf.js)的契约。
//
// 背景:浏览器渲不了 OFD 版式,原实现把 OFD 归到「仅下载」;而手机(App 壳)上下载了
// 也要装 OFD 阅读器才打得开,等于审批人在最常用的端上没法核对发票。现在:
// - OFD:调用方传了票面识别字段(invoice-fields)时,渲染结构化「票面信息」卡片;没传保持仅下载。
// - PDF:iframe 只有在浏览器声明 `navigator.pdfViewerEnabled === true` 时才可信 ——
//   安卓 WebView / App 壳里 iframe 指向 PDF 是**白屏且无报错**,必须走 pdf.js 画 canvas。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import FilePreview from './FilePreview.vue'

const ep = { global: { plugins: [ElementPlus] }, attachTo: document.body }

const flush = async () => {
  await nextTick()
  await nextTick()
}

describe('FilePreview · OFD 结构化票面', () => {
  it('OFD 没有票面字段:不出「预览」,只有下载(老行为不回退)', () => {
    const w = mount(FilePreview, { props: { url: '/files/a.ofd', filename: 'a.ofd' }, ...ep })
    const links = w.findAll('.el-link').map((l) => l.text())
    expect(links).not.toContain('预览')
    expect(links).toContain('下载')
    w.unmount()
  })

  it('OFD + 票面字段:预览打开票面卡片,含提示语与字段;total/totalAmount 同义只显示一个', async () => {
    const w = mount(FilePreview, {
      props: {
        url: '/files/b.ofd',
        filename: 'b.ofd',
        invoiceFields: {
          invoiceNo: '25617000000012345678',
          invoiceDate: '2026-05-01',
          sellerName: '某某科技有限公司',
          totalAmount: '88.00',
          total: '99.99', // 同义键,totalAmount 在先,应被忽略
          lineItems: [{ name: '办公用品', quantity: '2', amount: '88.00' }],
        },
      },
      ...ep,
    })
    await w.findAll('.el-link').find((l) => l.text() === '预览')!.trigger('click')
    await flush()
    const body = document.body.textContent ?? ''
    expect(body).toContain('票面信息')
    expect(body).toContain('25617000000012345678')
    expect(body).toContain('某某科技有限公司')
    expect(body).toContain('88.00')
    expect(body).not.toContain('99.99')
    expect(body).toContain('办公用品')
    // 提示语必须在:预览的是识别结果,不是原件
    expect(body).toContain('逐字核验请下载原件')
    w.unmount()
  })

  it('contentType=application/ofd(无扩展名)也认成 OFD', () => {
    const w = mount(FilePreview, {
      props: { url: '/files/no-ext', filename: 'no-ext', contentType: 'application/ofd', invoiceFields: { invoiceNo: 'X-1' } },
      ...ep,
    })
    expect(w.findAll('.el-link').map((l) => l.text())).toContain('预览')
    w.unmount()
  })
})

describe('FilePreview · PDF 双通道(扫源码契约)', () => {
  const src = readFileSync(join(import.meta.dirname, 'FilePreview.vue'), 'utf8')

  it('★pdf.js 必须懒加载 legacy 构建:动态 import + legacy 路径,不许顶层 import', () => {
    // 顶层 import 会把 ~120KB gzip 的 pdf.js 绑进首屏(见 vite.config manualChunks 注释);
    // legacy 构建底线 Chrome 98 —— 更老的内核 import 失败落到「预览失败,请下载」兜底。
    // ★版本必须与 pdf-parse 内嵌的 pdfjs-dist 完全对齐(5.4.296):v3 的 optional canvas
    //   会和 jsdom 的 peer canvas@^3 相撞,把 CI 的 npm ci 撞成 EUSAGE。
    expect(src).toMatch(/await import\('pdfjs-dist\/legacy\/build\/pdf\.mjs'\)/)
    expect(src).toMatch(/await import\('pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\?url'\)/)
    expect(src, '出现了顶层 import pdfjs —— 会整包进首屏').not.toMatch(/^import .*pdfjs-dist/m)
  })

  it('★不许有 iframe 通道:私有文件被 private-files.ts 有意 X-Frame-Options DENY', () => {
    // iframe 指向 /api/files 在任何浏览器里都被拒载(白屏无报错,实测 ERR_BLOCKED_BY_RESPONSE)。
    // 那个 DENY 是防上传型 XSS 的安全不变量 —— 修「PDF 预览白屏」的正确方向永远是 pdf.js,
    // 不是把响应头放开。谁把 iframe 加回来,这条就红。
    expect(src).not.toContain('<iframe')
  })

  it('超长 PDF 封页数,且给出「仅预览前 N 页」提示', () => {
    expect(src).toMatch(/PDF_MAX_PAGES = \d+/)
    expect(src).toContain('pdfTruncatedTotal')
    expect(src).toContain('仅预览前')
  })
})
