import { defineConfig } from 'vitest/config'

// 「真 agent」e2e 的独立配置。**不进 npm test** —— 它要一个真在跑的 AIOS + getdeployed + runtime,
// CI 上没有,混进默认套件只会全红。跑法:npm run test:live
//
// ★记忆里有一条教训:CI 不跑的 e2e 会**静默腐烂**(getdeployed 那套就是这么烂掉的)。
//   所以这套的定位是「改完 AI 链路后手动跑一遍」,不是摆着好看 —— 见 e2e/live/README.md。
export default defineConfig({
  test: {
    include: ['e2e/live/**/*.live.test.ts'],
    // agent 一轮就要几十秒到几分钟,默认 30s 根本不够
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // 串行:同一个 workspace 上并发跑 agent 会互相干扰(共用 runtime、共用会话计数)
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
