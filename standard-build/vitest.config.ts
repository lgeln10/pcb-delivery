import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    // ★`website/**` 这条不能少:顶层 website/(对外官网前端)下有测试,而它不在 modules/ 里 ——
    //   漏掉它的表现不是红,是**那些用例根本不被收录**,文件躺在仓里、CI 全绿、谁也不会发现。
    //   2026-08-27 从 sixam 回流时才发现 base 这边 website/tests/ 两条已经这么躺着了。
    include: ['core/**/*.test.ts', 'modules/**/*.test.ts', 'seed/**/*.test.ts', 'scripts/**/*.test.ts', 'src/**/*.test.ts'],
    // 默认 node 环境(数据库测试);ui 测试文件头部用 // @vitest-environment jsdom 切换
    // 多数数据库套件在 beforeAll 中创建 PGlite 并执行完整迁移,hook 需要独立超时预算。
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
})
