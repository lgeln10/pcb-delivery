// scripts/build-server.mjs — 把后端源码打包成一个压缩 bundle(源码保护 + 无需 tsx)。
// 只打包"我们自己的源码"(core/modules/server/seed),第三方依赖保持 external(镜像里正常装 node_modules)。
import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist-server', { recursive: true })
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external', // 第三方依赖不打进来(它们是别人的代码,运行时从 node_modules 取)
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
}
// 服务入口
await build({ ...common, entryPoints: ['server.ts'], outfile: 'dist-server/server.mjs' })
// 首次建管理员(幂等,库空才建)
await build({ ...common, entryPoints: ['scripts/bootstrap-production-admin.ts'], outfile: 'dist-server/bootstrap.mjs' })
// 自助开通 getdeployed(出站登记到 Management,拿回 workspace/PAT)
await build({ ...common, entryPoints: ['scripts/self-enroll.ts'], outfile: 'dist-server/self-enroll.mjs' })
// 迁移 SQL 运行时按 import.meta.url 找 ./migrations(见 core/db/connect.ts),bundle 后入口在 dist-server/,故拷过去
cpSync('core/db/migrations', 'dist-server/migrations', { recursive: true })
console.log('[build-server] ok → dist-server/server.mjs (+ migrations)')
