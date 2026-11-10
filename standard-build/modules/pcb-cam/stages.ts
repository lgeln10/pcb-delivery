// modules/pcb-cam/stages.ts
// pipeline 顺序即数组顺序;与 pcb-worker(pcb 仓 engine/pipeline)同名同序,两边契约测试对齐。
// 改 stage 顺序/增删 → 同时改 model.ts 的 CHECK、迁移、worker。
export const PCB_CAM_STAGES = [
  'intake', // 解压 / 层识别 / 叠层 / 钻孔 span(之后停等:层确认)
  'order_spec', // 附件审单(LLM 候选 → 人确认)
  'align', // 对齐 / 外形线 / Profile / 三副本
  'drill', // 孔属性 / 预大 / Drill Checks / 孔表比对
  'inner', // 内层负片/正片检查
  'outer', // 外层检查
  'mask', // 阻焊检查
  'silk', // 字符检查 + 删板外字符
  'net_compare', // 网络比较(正常 + 减铜)
  'panel', // 拼板方案
  'output', // 成果物输出 + round-trip 自检
  'gatekeeper', // 产物回读比对
] as const
export type PcbCamStage = (typeof PCB_CAM_STAGES)[number]

export function stageIndex(stage: PcbCamStage): number {
  return PCB_CAM_STAGES.indexOf(stage)
}

export function nextStage(stage: PcbCamStage | null): PcbCamStage | null {
  if (stage === null) return PCB_CAM_STAGES[0]
  const i = stageIndex(stage)
  if (i < 0) return null
  return PCB_CAM_STAGES[i + 1] ?? null
}

/** 上一个 stage(推进器只会「前进」,要重跑某一步就把 currentStage 拨回它前面那一步)。 */
export function prevStage(stage: PcbCamStage): PcbCamStage | null {
  const i = stageIndex(stage)
  return i > 0 ? PCB_CAM_STAGES[i - 1]! : null
}

/** 在该 stage 完成后必须停下等人确认(不看报告内容也要停)。 */
export const STAGES_REQUIRE_REVIEW_AFTER: ReadonlySet<PcbCamStage> = new Set<PcbCamStage>(['intake', 'order_spec'])
