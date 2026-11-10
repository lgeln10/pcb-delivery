// scripts/precompress-dist.mjs — 构建后给前端产物生成 `.br` / `.gz` 兄弟文件。
//
// 为什么要在构建期压:
//   服务端 serveStatic 开了 `precompressed: true`(core/http/app.ts),请求进来时它按
//   Accept-Encoding 找同名的 `.br` / `.gz` 直接发。没有这一步的话,Node 这层**完全不压缩**
//   —— 实测带不带 Accept-Encoding 都是原文件大小,压缩全靠 Caddy 现压:
//     · 每个用户每次冷启动都让 Caddy 现 gzip 1.78MB(mgmt 那台机器本来就在 OOM 边缘);
//     · Caddy 只有 gzip,没有 brotli;
//     · 没有 Caddy 在前面的部署(直接暴露 3005 的)则是 1.78MB 明文裸奔。
//   压一次、发无数次:首屏 475KB(gzip)→ 396KB(brotli),服务端压缩 CPU 归零。
//
// 为什么 br 和 gz 都要:brotli 要较新的内核,国产安卓上那些老 WebView 只认 gzip
// (壳里已经有一层 WebView 版本探测,但那是拦白屏的,不能拿来赌编码支持)。
// serveStatic 的取用顺序是 br → zstd → gzip,一个都取不到就发原文件,三层都能落地。
//
// 用法:node scripts/precompress-dist.mjs dist [dist-website ...]
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { brotliCompressSync, gzipSync, constants } from 'node:zlib'

// 只压文本类。图片/字体(png/jpg/webp/woff2)本身已是压缩格式,再压一遍只长体积和构建时间。
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.map'])
// 小文件压完常常更大,而且多两个 HTTP 缓存条目不划算。1KB 以下直接跳过。
const MIN_BYTES = 1024

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (st.isFile()) yield [p, st.size]
  }
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('[precompress] 用法:node scripts/precompress-dist.mjs <产物目录> [更多目录…]')
  process.exit(1)
}

let files = 0
let raw = 0
let br = 0
let gz = 0

for (const root of roots) {
  // 目录不存在不是错误:web:build 只出 dist,website:build 只出 dist-website,各跑各的。
  if (!existsSync(root)) {
    console.log(`[precompress] 跳过 ${root}(不存在)`)
    continue
  }
  for (const [path, size] of walk(root)) {
    const ext = extname(path).toLowerCase()
    if (!COMPRESSIBLE.has(ext) || size < MIN_BYTES) continue
    // 上一轮的产物(dist 通常被 vite 清空,但手工重跑时可能残留)不要再压一次
    if (path.endsWith('.br') || path.endsWith('.gz')) continue

    const buf = readFileSync(path)
    const brBuf = brotliCompressSync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length, // 给编码器窗口提示,同质量下更快更小
      },
    })
    const gzBuf = gzipSync(buf, { level: constants.Z_BEST_COMPRESSION })

    // 压完反而更大的(极少数已压过的 svg/json)不写,让它发原文件
    if (brBuf.length < buf.length) writeFileSync(path + '.br', brBuf)
    if (gzBuf.length < buf.length) writeFileSync(path + '.gz', gzBuf)

    files += 1
    raw += buf.length
    br += Math.min(brBuf.length, buf.length)
    gz += Math.min(gzBuf.length, buf.length)
  }
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + 'MB'
const pct = (n) => ((1 - n / raw) * 100).toFixed(0) + '%'
console.log(
  raw === 0
    ? '[precompress] 没有可压缩文件'
    : `[precompress] ${files} 个文件:原 ${mb(raw)} → br ${mb(br)}(-${pct(br)}) / gz ${mb(gz)}(-${pct(gz)})`,
)
