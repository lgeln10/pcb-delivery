import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  // 新模块的 model.ts 加进这里,drizzle-kit generate 自动 diff 出迁移。
  // 历史迁移仍会建出已下线业务的表;不要为了“对齐当前 schema”生成一张删表迁移。
  schema: [
    './core/audit/model.ts',
    './core/auth/model.ts',
    './core/backup/model.ts',
    './core/org/model.ts',
    './core/llm/model.ts',
    './core/llm/usage-model.ts',
    './core/storage/model.ts',
    './modules/notify/model.ts',
    './modules/inapp-notify/model.ts',
    './modules/app-settings/model.ts',
    './modules/feature-toggle/model.ts',
    './modules/menu-order/model.ts',
    './modules/pcb-cam/model.ts',
  ],
  out: './core/db/migrations',
})
