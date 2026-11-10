// modules/pcb-cam/worker-types.ts
// pcb-worker(pcb 仓 engine/model/report.py)返回的 StageReport 的 TS 同构 + zod 校验。
// ★两边契约:pcb 仓 tests/test_report_contract.py 会用同一份样例 JSON;这里改字段要同步那边。
import { z } from 'zod'
import { PCB_CAM_STAGES } from './stages'

export const ReportSeverity = z.enum(['error', 'warn', 'info'])
export const ReportStatus = z.enum(['ok', 'needs_review', 'blocked', 'failed'])

// ★Python 侧(pydantic)可选字段序列化为 null,不是省略 —— 这里所有可选字段都要 `.nullable().optional()`。
//   2026-09-05 端到端第一次跑就栽在 `fix.genesis_script: null` 上:zod `.optional()` 不收 null,钻孔报告整份被拒。
export const ReportLocation = z.object({
  x: z.number(),
  y: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional(),
})

export const ReportFix = z.object({
  type: z.string(),
  op: z.string().nullable().optional(), // pcb 仓 engine/adapters/base.py 的 CamOp 名
  params: z.record(z.string(), z.unknown()).nullable().default({}).transform((v) => v ?? {}),
  auto_fixable: z.boolean(),
  applied: z.boolean().nullable().default(false).transform((v) => v ?? false),
  // 「照做了,但要人确认」(pcb 仓 Fix.confirm):厂规开关的 ask 档 —— 引擎已执行,报告项仍进 EQ 等人点过
  confirm: z.boolean().nullable().default(false).transform((v) => v ?? false),
  genesis_script: z.string().nullable().optional(),
})

export const ReportItem = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  severity: ReportSeverity,
  layer: z.string().nullable().default(null),
  location: ReportLocation.nullable().default(null),
  measured: z.union([z.number(), z.string()]).nullable().default(null),
  threshold: z.union([z.number(), z.string()]).nullable().default(null),
  message: z.string(),
  fix: ReportFix.nullable().default(null),
  eq_question: z.string().nullable().default(null),
})

export const ReportArtifact = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  filename: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  content_type: z.string().nullable().optional(),
})

export const StageReportSchema = z
  .object({
    stage: z.enum(PCB_CAM_STAGES),
    status: ReportStatus,
    summary: z.string().nullable().default(''),
    items: z.array(ReportItem).nullable().default([]),
    artifacts: z.array(ReportArtifact).nullable().default([]),
    // intake 阶段回填;order_spec 阶段回填候选(不直接成为事实,见 MODULE.md 不变量 4)
    layer_map: z.record(z.string(), z.unknown()).nullable().optional(),
    order_spec_candidate: z.record(z.string(), z.unknown()).nullable().optional(),
    duration_ms: z.number().int().nonnegative().nullable().optional(),
  })
  // worker 未知的额外字段(如 pydantic 的 needs_decision)原样放过,不因为多一个字段拒收整份报告
  .passthrough()
  .transform((r) => ({ ...r, summary: r.summary ?? '', items: r.items ?? [], artifacts: r.artifacts ?? [] }))

export type StageReport = z.infer<typeof StageReportSchema>
export type StageReportItem = z.infer<typeof ReportItem>
export type StageReportArtifact = z.infer<typeof ReportArtifact>

// ── 终稿对比(pcb 仓 engine/compare.py):系统输出 vs 人工终稿,逐层分档 + C 档簇 ──
// 三档见 engine/geom/xordiff.py:noise < 0.01 mm(坐标取整)/ size 0.01–0.1 mm(同一形体差一档)/
// shape > 0.1 mm(一边有一个东西另一边没有 —— 这才是清单)。
export const CompareBand = z.object({ noise: z.number(), size: z.number(), shape: z.number() })
export const CompareCluster = z.object({
  id: z.number().int(),
  // missing = 人有我们没有;extra = 我们有人没有;changed = 同一处两边都有、形状不同(一红一蓝叠在一起,合成一处)
  direction: z.enum(['missing', 'extra', 'changed']),
  area_missing_mm2: z.number().nullable().optional(),
  area_extra_mm2: z.number().nullable().optional(),
  pieces: z.number().int(),
  area_mm2: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  size_mm: z.tuple([z.number(), z.number()]),
  at: z.tuple([z.number(), z.number()]),
})
export const CompareLayer = z.object({
  suffix: z.string(),
  output: z.string(),
  golden: z.string(),
  type: z.string(),
  gold_area_mm2: z.number(),
  ours_area_mm2: z.number(),
  xor_pct: z.number(),
  shape_pct: z.number(),
  bands: z.object({ missing: CompareBand, extra: CompareBand }),
  n_clusters: z.number().int(),
  n_missing: z.number().int(),
  n_extra: z.number().int(),
  n_changed: z.number().int().nullable().default(0).transform((v) => v ?? 0),
  clusters: z.array(CompareCluster),
  note: z.string().nullable().default(null),
})
export const CompareDrillRow = z.object({ dia_mm: z.number(), kind: z.enum(['hole', 'slot']), ours: z.number().int(), golden: z.number().int(), same: z.boolean() })
export const CompareDrill = z.object({
  output: z.string(),
  golden: z.string(),
  n_sizes_ours: z.number().int(),
  n_sizes_golden: z.number().int(),
  holes_ours: z.number().int(),
  holes_golden: z.number().int(),
  n_mismatch: z.number().int(),
  rows: z.array(CompareDrillRow),
})
export const CompareResultSchema = z.object({
  fingerprint: z.string().nullable().default(''),
  has_golden: z.boolean(),
  has_output: z.boolean(),
  golden_files: z.array(z.string()),
  unmatched_output: z.array(z.object({ suffix: z.string(), output: z.string(), type: z.string() })),
  unmatched_golden: z.array(z.string()),
  layers: z.array(CompareLayer),
  drill: CompareDrill.nullable().default(null),
  summary: z.object({ n_layers: z.number().int(), n_clusters: z.number().int(), worst: z.string().nullable().default(null) }),
})
export type CompareResult = z.infer<typeof CompareResultSchema>
export type CompareLayerResult = z.infer<typeof CompareLayer>
export type CompareClusterResult = z.infer<typeof CompareCluster>
export const GoldenManifestSchema = z.object({
  has_golden: z.boolean(),
  has_output: z.boolean(),
  golden_files: z.array(z.string()),
  layers: z.array(z.object({ suffix: z.string(), output: z.string(), type: z.string(), golden: z.string().nullable() })),
  unmatched_output: z.array(z.object({ suffix: z.string(), output: z.string(), type: z.string() })),
  unmatched_golden: z.array(z.string()),
  drill: z.object({ suffix: z.string(), output: z.string(), golden: z.string().nullable() }).nullable().default(null),
  errors: z.array(z.string()).nullable().default([]).transform((v) => v ?? []),
})
export type GoldenManifest = z.infer<typeof GoldenManifestSchema>
