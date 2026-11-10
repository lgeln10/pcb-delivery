// 企业官网(公网门户)的独立构建入口。与内部管理端(vite.config.ts / dist)完全分离:
// root=website/,产物到 dist-website/,生产由 Hono 按 WEBSITE_DIST(+可选 WEBSITE_HOST 按 Host 分发)服务,
// 并在 serve-time 注入 SEO meta + JSON-LD(见 core/http/app.ts)。
// dev:`npm run website:dev`(:5177,/api 反代到 3005)。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3005'

export default defineConfig({
  plugins: [vue()],
  root: 'website',
  build: {
    outDir: '../dist-website',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5177,
    proxy: {
      // 只代理 /api/ 前缀,避免把官网自身模块请求误代理到后端(dev)
      '^/api/': apiTarget,
    },
  },
})
