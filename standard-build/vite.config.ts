import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3005'

export default defineConfig({
  plugins: [
    vue(),
    // ★element-plus 按需:模板里写的 <el-xxx> 由 resolver 逐个引入组件 + 它自己的样式。
    //   改这个之前的状态是 `app.use(ElementPlus)` + 整包 index.css —— 100+ 个组件和全部样式
    //   一个不落地进首屏,实测 245KB(gzip,JS)+ 47KB(gzip,CSS)= 首屏的 61%,而全仓模板里
    //   实际只用到 52 个组件。
    //   ★用 resolver 而不是在 main.ts 手写一串 `import { ElButton } from 'element-plus'`:
    //     手写的那份清单迟早会漏(新页面写了个没注册过的 el-xxx),而漏掉的表现是**运行时**
    //     那一页少个控件 —— 只有真打开那一页才看得见。resolver 是从模板里扫出来的,不会漏。
    Components({ resolvers: [ElementPlusResolver()], dts: false }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // ★element-plus 与其余第三方**刻意不再分组**:那条 `return 'vendor'` 的兜底会把
          //   node_modules 里的一切绑成一个 chunk,而它是入口的静态依赖 —— 于是不管按不按需,
          //   el-table / el-date-picker 这些只有个别页面用的重件都跟着首屏一起下。
          //   交给 rollup 自动分包:被多页共用的自然提成共享 chunk,只有一页用的留在那页的 chunk。
          if (id.includes('/@tanstack/')) return 'vendor-query'
          if (id.includes('/@lucide/') || id.includes('/lucide-vue')) return 'vendor-icons'
          if (id.includes('/xlsx/')) return 'vendor-xlsx'
          if (id.includes('/vue/') || id.includes('/@vue/')) return 'vendor-vue'
          return undefined
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    proxy: {
      '/api': apiTarget,
    },
  },
})
