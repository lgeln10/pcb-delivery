// modules/pcb-cam/model.ts
// PCB CAM 工程自动化:项目 → job(一次运行)→ stage_runs(逐 stage 执行+报告)→ eq_items(人决策点)/ artifacts(成果物)。
// 工厂标准(factory_profiles)以 YAML 文本存,job 创建时快照进 jobs.profile_snapshot(不变量 7)。
import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { commonFields } from '../../core/db/common-fields'
import { sqlList } from '../../core/db/status-convention'
import { PCB_CAM_STAGES } from './stages'

export const PCB_CAM_PROJECT_STATUSES = ['active', 'archived'] as const
export type PcbCamProjectStatus = (typeof PCB_CAM_PROJECT_STATUSES)[number]

export const PCB_CAM_JOB_STATUSES = ['pending', 'running', 'needs_review', 'blocked', 'done', 'failed', 'cancelled'] as const
export type PcbCamJobStatus = (typeof PCB_CAM_JOB_STATUSES)[number]

export const PCB_CAM_STAGE_RUN_STATUSES = ['running', 'ok', 'needs_review', 'blocked', 'failed'] as const
export type PcbCamStageRunStatus = (typeof PCB_CAM_STAGE_RUN_STATUSES)[number]

export const PCB_CAM_SEVERITIES = ['error', 'warn', 'info'] as const
export type PcbCamSeverity = (typeof PCB_CAM_SEVERITIES)[number]

export const PCB_CAM_EQ_DECISIONS = ['pending', 'accept_fix', 'ignore', 'manual', 'ask_customer'] as const
export type PcbCamEqDecision = (typeof PCB_CAM_EQ_DECISIONS)[number]

export const PCB_CAM_ARTIFACT_KINDS = [
  'drill',
  'gerber_review',
  'ipc356',
  'mi_sheet',
  'stackup_svg',
  'eq_report',
  'dfm_report',
  'genesis_script',
  'preview_svg',
  'archive',
  'op_plan',
  'gerber_panel',
  'drill_panel',
  'rout',
] as const
export type PcbCamArtifactKind = (typeof PCB_CAM_ARTIFACT_KINDS)[number]
/** 要交给生产 / 客户的那部分(打包下载默认只打这些;其余是引擎过程数据)。前端 PcbCamWorkspace.vue 里有一份同名镜像 */
export const PCB_CAM_DELIVERABLE_KINDS: readonly PcbCamArtifactKind[] = ['gerber_panel', 'drill_panel', 'rout', 'drill', 'gerber_review', 'ipc356', 'genesis_script', 'mi_sheet', 'stackup_svg', 'eq_report']

export const pcbCamFactoryProfiles = pgTable(
  'pcb_cam_factory_profiles',
  {
    ...commonFields,
    name: text('name').notNull(),
    yaml: text('yaml').notNull(),
    schemaVersion: text('schema_version').notNull().default('1'),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    uniqueIndex('pcb_cam_factory_profiles_name_uq').on(t.tenantId, t.name).where(sql`is_deleted = false`),
    index('pcb_cam_factory_profiles_tenant_idx').on(t.tenantId, t.isDefault),
  ],
)

export const pcbCamProjects = pgTable(
  'pcb_cam_projects',
  {
    ...commonFields,
    name: text('name').notNull(),
    customerName: text('customer_name'),
    factoryProfileId: uuid('factory_profile_id').references(() => pcbCamFactoryProfiles.id),
    status: text('status').notNull().default('active'),
  },
  (t) => [
    index('pcb_cam_projects_tenant_idx').on(t.tenantId, t.status, t.updatedAt),
    check('pcb_cam_projects_status_check', sql`${t.status} in (${sql.raw(sqlList(PCB_CAM_PROJECT_STATUSES))})`),
  ],
)

export const pcbCamJobs = pgTable(
  'pcb_cam_jobs',
  {
    ...commonFields,
    projectId: uuid('project_id').notNull().references(() => pcbCamProjects.id),
    status: text('status').notNull().default('pending'),
    currentStage: text('current_stage'),
    reviewReason: text('review_reason'),
    inputKeys: jsonb('input_keys').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    layerMap: jsonb('layer_map').$type<Record<string, unknown> | null>(),
    layerMapConfirmedAt: timestamp('layer_map_confirmed_at', { withTimezone: true }),
    orderSpecCandidate: jsonb('order_spec_candidate').$type<Record<string, unknown> | null>(),
    orderSpec: jsonb('order_spec').$type<Record<string, unknown> | null>(),
    profileSnapshot: jsonb('profile_snapshot').$type<Record<string, unknown> | null>(),
    workerJobId: text('worker_job_id'),
    retryCount: integer('retry_count').notNull().default(0),
    version: integer('version').notNull().default(0),
    errorMessage: text('error_message'),
    /** 一键「放行并下发」：打包成果物 + 流程单 + 问单的时间和人(done 之后才允许) */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by'),
  },
  (t) => [
    index('pcb_cam_jobs_tenant_status_idx').on(t.tenantId, t.status, t.updatedAt),
    index('pcb_cam_jobs_project_idx').on(t.tenantId, t.projectId, t.createdAt),
    check('pcb_cam_jobs_status_check', sql`${t.status} in (${sql.raw(sqlList(PCB_CAM_JOB_STATUSES))})`),
    check('pcb_cam_jobs_stage_check', sql`${t.currentStage} is null or ${t.currentStage} in (${sql.raw(sqlList(PCB_CAM_STAGES))})`),
    check('pcb_cam_jobs_retry_check', sql`${t.retryCount} >= 0`),
  ],
)

export const pcbCamStageRuns = pgTable(
  'pcb_cam_stage_runs',
  {
    ...commonFields,
    jobId: uuid('job_id').notNull().references(() => pcbCamJobs.id),
    stage: text('stage').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull().default('running'),
    report: jsonb('report').$type<Record<string, unknown> | null>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    errorMessage: text('error_message'),
  },
  (t) => [
    uniqueIndex('pcb_cam_stage_runs_attempt_uq').on(t.jobId, t.stage, t.attempt),
    index('pcb_cam_stage_runs_job_idx').on(t.tenantId, t.jobId, t.startedAt),
    check('pcb_cam_stage_runs_stage_check', sql`${t.stage} in (${sql.raw(sqlList(PCB_CAM_STAGES))})`),
    check('pcb_cam_stage_runs_status_check', sql`${t.status} in (${sql.raw(sqlList(PCB_CAM_STAGE_RUN_STATUSES))})`),
    check('pcb_cam_stage_runs_attempt_check', sql`${t.attempt} >= 1`),
  ],
)

export const pcbCamEqItems = pgTable(
  'pcb_cam_eq_items',
  {
    ...commonFields,
    jobId: uuid('job_id').notNull().references(() => pcbCamJobs.id),
    stageRunId: uuid('stage_run_id').notNull().references(() => pcbCamStageRuns.id),
    stage: text('stage').notNull(),
    itemId: text('item_id').notNull(),
    /** 报告项类型(ReportItem.kind);决策记忆按「同客户 + 同类型」找上次的判法。老行为空时按 item_id 前缀推 */
    kind: text('kind'),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    suggestedFix: jsonb('suggested_fix').$type<Record<string, unknown> | null>(),
    decision: text('decision').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    /** 「问客户」条目的客户答复原文;回收后落在这条发现上,工程师据此再判 */
    customerReply: text('customer_reply'),
    customerReplyAt: timestamp('customer_reply_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('pcb_cam_eq_items_item_uq').on(t.jobId, t.stage, t.itemId).where(sql`is_deleted = false`),
    index('pcb_cam_eq_items_job_decision_idx').on(t.tenantId, t.jobId, t.decision),
    index('pcb_cam_eq_items_kind_idx').on(t.tenantId, t.kind, t.decidedAt),
    check('pcb_cam_eq_items_stage_check', sql`${t.stage} in (${sql.raw(sqlList(PCB_CAM_STAGES))})`),
    check('pcb_cam_eq_items_severity_check', sql`${t.severity} in (${sql.raw(sqlList(PCB_CAM_SEVERITIES))})`),
    check('pcb_cam_eq_items_decision_check', sql`${t.decision} in (${sql.raw(sqlList(PCB_CAM_EQ_DECISIONS))})`),
  ],
)

export const pcbCamArtifacts = pgTable(
  'pcb_cam_artifacts',
  {
    ...commonFields,
    jobId: uuid('job_id').notNull().references(() => pcbCamJobs.id),
    stageRunId: uuid('stage_run_id').references(() => pcbCamStageRuns.id),
    kind: text('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    size: integer('size').notNull().default(0),
    contentType: text('content_type'),
  },
  (t) => [
    index('pcb_cam_artifacts_job_kind_idx').on(t.tenantId, t.jobId, t.kind),
    uniqueIndex('pcb_cam_artifacts_key_uq').on(t.tenantId, t.storageKey).where(sql`is_deleted = false`),
    check('pcb_cam_artifacts_kind_check', sql`${t.kind} in (${sql.raw(sqlList(PCB_CAM_ARTIFACT_KINDS))})`),
    check('pcb_cam_artifacts_size_check', sql`${t.size} >= 0`),
  ],
)

export type PcbCamFactoryProfile = typeof pcbCamFactoryProfiles.$inferSelect
export type PcbCamProject = typeof pcbCamProjects.$inferSelect
export type PcbCamJob = typeof pcbCamJobs.$inferSelect
export type PcbCamStageRun = typeof pcbCamStageRuns.$inferSelect
export type PcbCamEqItem = typeof pcbCamEqItems.$inferSelect
export type PcbCamArtifact = typeof pcbCamArtifacts.$inferSelect
