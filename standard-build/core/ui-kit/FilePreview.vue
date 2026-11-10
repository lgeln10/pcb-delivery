<script setup lang="ts">
// core/ui-kit/FilePreview.vue
// 附件预览:图片走 el-image 灯箱(可缩放/旋转);PDF 在有内置渲染器的浏览器走 iframe,
// 没有的(安卓 WebView / App 壳)懒加载 pdf.js 画到 canvas;OFD 浏览器画不了版式 ——
// 调用方传了票面识别字段(invoice-fields)时,渲染成结构化「票面信息」卡片,没传则仅下载。
// 用于报销发票、审批中心原单附件等「已上传单据」的就地查看,免去先下载再打开。
import { computed, nextTick, ref, watch } from 'vue'
import { useIsMobile } from '../../src/composables/useIsMobile'

const props = defineProps<{
  url?: string | null
  filename?: string | null
  contentType?: string | null
  /** 票面识别字段(报销 OCR fields / 付款发票行)。OFD 预览的数据来源:浏览器渲不了 OFD 版式,
   *  预览的是系统识别出的票面内容,卡片里已注明「逐字核验请下载原件」。 */
  invoiceFields?: Record<string, unknown> | null
}>()

const open = ref(false)
const isMobile = useIsMobile()

const ext = computed(() => {
  const name = props.filename || props.url || ''
  const m = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(name)
  return m ? m[1]!.toLowerCase() : ''
})
const kind = computed<'image' | 'pdf' | 'ofd' | 'other'>(() => {
  const ct = (props.contentType || '').toLowerCase()
  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext.value)) return 'image'
  if (ct === 'application/pdf' || ext.value === 'pdf') return 'pdf'
  // OFD 的 contentType 上传时常是 application/octet-stream,扩展名兜底(与 core/ocr/gateway.ts 同款判定)
  if (ext.value === 'ofd' || ct === 'application/ofd' || ct === 'application/x-ofd') return 'ofd'
  return 'other'
})

// ── OFD:结构化票面 ──────────────────────────────────────────────────────
// 字段名兼容两处来源:报销 OCR 的 ReimbursementInvoiceFieldsDTO(totalAmount)
// 与付款单发票行 PaymentRequestInvoiceDTO(total)。同义键只取先命中的那个。
const INVOICE_FIELD_LABELS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['invoiceType', '发票类型'],
  ['invoiceCode', '发票代码'],
  ['invoiceNo', '发票号码'],
  ['invoiceDate', '开票日期'],
  ['buyerName', '购买方'],
  ['buyerTaxNo', '购方税号'],
  ['sellerName', '销售方'],
  ['sellerTaxNo', '销方税号'],
  ['amountWithoutTax', '不含税金额'],
  ['taxRate', '税率'],
  ['taxAmount', '税额'],
  ['totalAmount', '价税合计'],
  ['total', '价税合计'],
  ['checkCode', '校验码'],
  ['remarks', '备注'],
]
const invoicePairs = computed<Array<{ label: string; value: string }>>(() => {
  const f = props.invoiceFields
  if (!f) return []
  const out: Array<{ label: string; value: string }> = []
  const seen = new Set<string>()
  for (const [key, label] of INVOICE_FIELD_LABELS) {
    if (seen.has(label)) continue
    const v = f[key]
    if (v === undefined || v === null) continue
    const text = String(v).trim()
    if (!text) continue
    out.push({ label, value: text })
    seen.add(label)
  }
  return out
})
type InvoiceLine = { name: string; spec: string; quantity: string; unitPrice: string; amount: string }
const invoiceLines = computed<InvoiceLine[]>(() => {
  const raw = props.invoiceFields?.lineItems
  if (!Array.isArray(raw)) return []
  return raw
    .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === 'object')
    .map((l) => ({
      name: String(l.name ?? '').trim(),
      spec: String(l.spec ?? '').trim(),
      quantity: String(l.quantity ?? '').trim(),
      unitPrice: String(l.unitPrice ?? '').trim(),
      amount: String(l.amount ?? '').trim(),
    }))
    .filter((l) => l.name || l.amount)
})
const hasInvoiceFace = computed(() => invoicePairs.value.length > 0 || invoiceLines.value.length > 0)

const canPreview = computed(() => {
  if (!props.url) return false
  if (kind.value === 'ofd') return hasInvoiceFace.value
  return kind.value !== 'other'
})

// ── PDF:一律 pdf.js 画 canvas,没有 iframe 通道 ─────────────────────────
// 不是偷懒:本组件预览的全是私有文件,core/http/private-files.ts 给它们的响应**有意**带
// `X-Frame-Options: DENY` + 无源沙箱(防上传型 XSS,是安全不变量,不许松)——
// iframe 指向 /api/files 在**任何**浏览器里都被拒载(实测 ERR_BLOCKED_BY_RESPONSE),
// 桌面上原来的 iframe 预览其实一直是坏的,只是白屏不报错。安卓 WebView / App 壳则连
// 内置 PDF 渲染器都没有。pdf.js(fetch → worker 解析 → canvas)是唯一既能画又不
// 给上传内容执行机会的通道。

/** 超长 PDF 只画前 N 页(canvas 位图常驻内存,合同类文档几十页会把移动端画崩),其余下载看 */
const PDF_MAX_PAGES = 20
const pdfPagesEl = ref<HTMLDivElement>()
const pdfState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const pdfTruncatedTotal = ref(0)
let pdfDoc: { numPages: number; getPage: (n: number) => Promise<unknown>; destroy: () => Promise<unknown> } | null = null
let renderGen = 0 // 关闭/重开时让旧的渲染循环自行退出

async function renderPdf() {
  const gen = ++renderGen
  pdfState.value = 'loading'
  pdfTruncatedTotal.value = 0
  try {
    // ★懒加载:pdf.js 约 120KB gzip,只有真要画的那一刻才下(vite 动态 import 自动拆独立 chunk,
    //   别改成顶层 import —— 会整包进首屏,见 vite.config manualChunks 的注释)。
    //   版本钉 5.4.296 与 pdf-parse 内嵌的那份完全对齐(lockfile 里只留一份);
    //   ★别退回 v3「为了照顾 Chromium 92」:v3 拖 optional 原生依赖 canvas@^2,
    //     与 jsdom 的 peer canvas@^3 相撞,CI 的 npm ci 直接 EUSAGE(2026-08-19 踩过)。
    //   v5 legacy 构建底线 Chrome 98;92–97 的老内核 import 失败会落到下面的
    //   catch → 「预览失败,请下载」,与改造前(iframe 拒载白屏)相比没有人倒退。
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    const doc = await pdfjs.getDocument({ url: props.url! }).promise
    if (gen !== renderGen) {
      void doc.destroy()
      return
    }
    pdfDoc = doc
    await nextTick()
    const container = pdfPagesEl.value
    if (!container) return
    container.innerHTML = ''
    const cssWidth = container.clientWidth || 360
    const pages = Math.min(doc.numPages, PDF_MAX_PAGES)
    if (doc.numPages > PDF_MAX_PAGES) pdfTruncatedTotal.value = doc.numPages
    for (let i = 1; i <= pages; i++) {
      if (gen !== renderGen) return
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      // 渲染宽度封顶 1080 设备像素:清晰度够核对小字,又不让大屏 × 高 DPR 撑出几百 MB 位图
      const scale = Math.min(cssWidth * (window.devicePixelRatio || 1), 1080) / base.width
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      container.appendChild(canvas)
      await page.render({ canvas, viewport }).promise
    }
    if (gen === renderGen) pdfState.value = 'ready'
  } catch (err) {
    if (gen === renderGen) {
      console.error('[file-preview] pdf.js 渲染失败:', err)
      pdfState.value = 'error'
    }
  }
}

watch(open, (v) => {
  if (v && kind.value === 'pdf') {
    void nextTick().then(renderPdf)
  }
  if (!v) {
    renderGen += 1
    pdfState.value = 'idle'
    if (pdfDoc) {
      void pdfDoc.destroy()
      pdfDoc = null
    }
    if (pdfPagesEl.value) pdfPagesEl.value.innerHTML = ''
  }
})
</script>

<template>
  <span v-if="url" class="file-preview">
    <el-link v-if="canPreview" type="primary" :underline="false" @click.stop="open = true">预览</el-link>
    <el-link :href="url" target="_blank" download :underline="false">下载</el-link>
    <el-dialog
      v-if="canPreview"
      v-model="open"
      :title="filename || '附件预览'"
      :width="isMobile ? '96%' : '80%'"
      top="5vh"
      append-to-body
      destroy-on-close
      class="file-preview__dialog"
    >
      <!-- OFD:结构化票面(识别字段) -->
      <div v-if="kind === 'ofd'" class="invoice-face">
        <p class="t-caption invoice-face__note">浏览器无法直接显示 OFD 版式。以下为系统识别的票面信息,逐字核验请下载原件。</p>
        <dl v-if="invoicePairs.length" class="invoice-face__meta">
          <div v-for="p in invoicePairs" :key="p.label">
            <dt>{{ p.label }}</dt>
            <dd>{{ p.value }}</dd>
          </div>
        </dl>
        <div v-if="invoiceLines.length" class="invoice-face__items">
          <p class="invoice-face__items-title">商品行</p>
          <div v-for="(l, i) in invoiceLines" :key="i" class="invoice-face__item">
            <span class="invoice-face__item-name">{{ l.name || '—' }}<template v-if="l.spec"> · {{ l.spec }}</template></span>
            <span v-if="l.quantity" class="invoice-face__item-qty">×{{ l.quantity }}</span>
            <span class="invoice-face__item-amount">{{ l.amount || l.unitPrice || '—' }}</span>
          </div>
        </div>
      </div>

      <div v-else class="file-preview__body">
        <el-image
          v-if="kind === 'image'"
          :src="url"
          fit="contain"
          :preview-src-list="[url]"
          :preview-teleported="true"
          hide-on-click-modal
          class="file-preview__img"
        />
        <!-- PDF:pdf.js 画 canvas(iframe 对私有文件是死路,见 script 顶部注释) -->
        <div v-else class="file-preview__pdfjs">
          <p v-if="pdfState === 'loading'" class="t-caption file-preview__pdf-hint">正在加载 PDF…</p>
          <p v-else-if="pdfState === 'error'" class="t-caption file-preview__pdf-hint">PDF 预览失败,请下载后查看。</p>
          <div ref="pdfPagesEl" class="file-preview__pdf-pages"></div>
          <p v-if="pdfTruncatedTotal" class="t-caption file-preview__pdf-hint">
            共 {{ pdfTruncatedTotal }} 页,仅预览前 {{ PDF_MAX_PAGES }} 页,完整内容请下载原件。
          </p>
        </div>
      </div>
    </el-dialog>
  </span>
  <span v-else class="muted">—</span>
</template>

<style scoped>
.file-preview {
  display: inline-flex;
  gap: var(--sb-space-2);
  align-items: center;
}
.file-preview__body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 60vh;
}
.file-preview__img {
  max-width: 100%;
  max-height: 78vh;
}
.file-preview__pdfjs {
  width: 100%;
  max-height: 78vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
}
.file-preview__pdf-pages {
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
}
/* canvas 是 JS 动态 append 的,没有 scoped 属性,必须走 :deep */
.file-preview__pdf-pages :deep(canvas) {
  width: 100%;
  height: auto;
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-sm);
}
.file-preview__pdf-hint {
  text-align: center;
  padding: var(--sb-space-2);
}

/* 票面卡片:紧凑,字段两列自适应,移动端塌成单列 */
.invoice-face {
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-3);
}
.invoice-face__note {
  margin: 0;
  padding: var(--sb-space-2) var(--sb-space-3);
  background: var(--sb-bg-subtle);
  border-radius: var(--sb-radius-sm);
}
.invoice-face__meta {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sb-space-2) var(--sb-space-4);
}
.invoice-face__meta div {
  display: flex;
  gap: var(--sb-space-2);
  min-width: 0;
}
.invoice-face__meta dt {
  flex-shrink: 0;
  color: var(--sb-text-tertiary);
  font-size: var(--sb-font-sm);
}
.invoice-face__meta dd {
  margin: 0;
  min-width: 0;
  font-size: var(--sb-font-sm);
  color: var(--sb-text-primary);
  word-break: break-all;
}
.invoice-face__items {
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-md);
  padding: var(--sb-space-2) var(--sb-space-3);
}
.invoice-face__items-title {
  margin: 0 0 var(--sb-space-2);
  font-size: var(--sb-font-sm);
  font-weight: 600;
  color: var(--sb-text-secondary);
}
.invoice-face__item {
  display: flex;
  align-items: baseline;
  gap: var(--sb-space-2);
  padding: 2px 0;
  font-size: var(--sb-font-sm);
}
.invoice-face__item-name {
  min-width: 0;
  color: var(--sb-text-primary);
  word-break: break-all;
}
.invoice-face__item-qty {
  flex-shrink: 0;
  color: var(--sb-text-tertiary);
  font-size: var(--sb-font-xs);
}
.invoice-face__item-amount {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: var(--sb-text-primary);
}
</style>
