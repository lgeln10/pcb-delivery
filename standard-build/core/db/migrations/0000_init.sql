CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_employee_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"summary" text,
	"detail" jsonb,
	"source" text NOT NULL,
	"result" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_source_check" CHECK ("audit_logs"."source" in ('http', 'system', 'login')),
	CONSTRAINT "audit_logs_result_check" CHECK ("audit_logs"."result" in ('success', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "login_devices" (
	"jti" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"label" text NOT NULL,
	"platform" text DEFAULT 'unknown' NOT NULL,
	"app_version" text,
	"source" text DEFAULT 'qr' NOT NULL,
	"ip" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qr_login_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "qr_login_tickets_status_check" CHECK (status IN ('pending', 'scanned', 'approved', 'rejected', 'consumed')),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_ip" text,
	"scanned_at" timestamp with time zone,
	"device_label" text,
	"platform" text,
	"app_version" text,
	"scan_ip" text,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "revoked_tokens" (
	"jti" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text DEFAULT 'logout' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"employee_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"secret_enc" text,
	"purpose" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_date" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"verdict" text NOT NULL,
	"location" text,
	"object_key" text,
	"size_bytes" bigint,
	"sha256" text,
	"dump_exit_code" integer,
	"restore_list_objects" integer,
	"row_counts" jsonb,
	"reasons" jsonb,
	"error" text,
	"pg_server_version" text,
	"pg_dump_version" text,
	"upload_skipped" boolean DEFAULT false NOT NULL,
	"restore_verified_at" timestamp with time zone,
	"restore_verdict" text,
	"restore_detail" jsonb,
	"pruned_at" timestamp with time zone,
	"pruned_reason" text,
	CONSTRAINT "db_backup_runs_verdict_check" CHECK (verdict IN ('ok', 'suspect', 'failed')),
	CONSTRAINT "db_backup_runs_location_check" CHECK (location IS NULL OR location IN ('local', 'oss', 'tos')),
	CONSTRAINT "db_backup_runs_restore_verdict_check" CHECK (restore_verdict IS NULL OR restore_verdict IN ('passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"parent_id" uuid,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_accounting_entity" boolean DEFAULT false NOT NULL,
	"head_employee_id" uuid,
	CONSTRAINT "departments_status_check" CHECK ("departments"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "employee_roles" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "employee_roles_employee_id_role_id_pk" PRIMARY KEY("employee_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"department_id" uuid,
	"leader_id" uuid,
	"name" text NOT NULL,
	"emp_no" text NOT NULL,
	"phone" text NOT NULL,
	"position" text DEFAULT '' NOT NULL,
	"password_hash" text,
	"email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"avatar_url" text,
	"sessions_revoked_at" timestamp with time zone,
	CONSTRAINT "employees_status_check" CHECK ("employees"."status" in ('active', 'left'))
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"module" text NOT NULL,
	"type" text NOT NULL,
	CONSTRAINT "permissions_code_unique" UNIQUE("code"),
	CONSTRAINT "permissions_type_check" CHECK ("permissions"."type" in ('menu', 'action'))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"tenant_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"data_scope" varchar(16) NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id"),
	CONSTRAINT "role_permissions_scope_check" CHECK ("role_permissions"."data_scope" in ('ALL', 'DEPT_AND_SUB', 'DEPT', 'SELF', 'CUSTOM'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_employee_password" text DEFAULT 'changeMe@6am' NOT NULL,
	"owner_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "llm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"provider" text DEFAULT 'bailian' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"fallback_provider" text,
	"fallback_model" text,
	"thinking_enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"provider" text NOT NULL,
	"api_key_enc" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_scene_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"scene" text NOT NULL,
	"provider" text,
	"model" text,
	"fallback_provider" text,
	"fallback_model" text,
	"thinking_enabled" boolean
);
--> statement-breakpoint
CREATE TABLE "llm_usage_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scene" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"error_code" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"active_provider" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"provider" text NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"bucket" text DEFAULT '' NOT NULL,
	"endpoint" text DEFAULT '' NOT NULL,
	"public_base" text DEFAULT '' NOT NULL,
	"access_key_id" text DEFAULT '' NOT NULL,
	"access_key_secret_enc" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notify_channel_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"channel_type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config_enc" text,
	CONSTRAINT "notify_channel_configs_channel_check" CHECK ("notify_channel_configs"."channel_type" in ('email', 'feishu'))
);
--> statement-breakpoint
CREATE TABLE "inapp_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"recipient_id" uuid NOT NULL,
	"type" text DEFAULT 'system' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "inapp_notifications_type_check" CHECK ("inapp_notifications"."type" in ('system','reminder')),
	CONSTRAINT "inapp_notifications_source_type_check" CHECK ("inapp_notifications"."source_type" in ('db_backup'))
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"system_name" text DEFAULT '' NOT NULL,
	"logo_url" text,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"invoice_title" text,
	"invoice_tax_no" text
);
--> statement-breakpoint
CREATE TABLE "feature_toggles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"feature_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"group_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_order" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pcb_cam_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"job_id" uuid NOT NULL,
	"stage_run_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	CONSTRAINT "pcb_cam_artifacts_kind_check" CHECK ("pcb_cam_artifacts"."kind" in ('drill', 'gerber_review', 'ipc356', 'mi_sheet', 'stackup_svg', 'eq_report', 'dfm_report', 'genesis_script', 'preview_svg', 'archive', 'op_plan', 'gerber_panel', 'drill_panel', 'rout')),
	CONSTRAINT "pcb_cam_artifacts_size_check" CHECK ("pcb_cam_artifacts"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pcb_cam_eq_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"job_id" uuid NOT NULL,
	"stage_run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"item_id" text NOT NULL,
	"kind" text,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"suggested_fix" jsonb,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"customer_reply" text,
	"customer_reply_at" timestamp with time zone,
	CONSTRAINT "pcb_cam_eq_items_stage_check" CHECK ("pcb_cam_eq_items"."stage" in ('intake', 'order_spec', 'align', 'drill', 'inner', 'outer', 'mask', 'silk', 'net_compare', 'panel', 'output', 'gatekeeper')),
	CONSTRAINT "pcb_cam_eq_items_severity_check" CHECK ("pcb_cam_eq_items"."severity" in ('error', 'warn', 'info')),
	CONSTRAINT "pcb_cam_eq_items_decision_check" CHECK ("pcb_cam_eq_items"."decision" in ('pending', 'accept_fix', 'ignore', 'manual', 'ask_customer'))
);
--> statement-breakpoint
CREATE TABLE "pcb_cam_factory_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"yaml" text NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pcb_cam_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_stage" text,
	"review_reason" text,
	"input_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"layer_map" jsonb,
	"layer_map_confirmed_at" timestamp with time zone,
	"order_spec_candidate" jsonb,
	"order_spec" jsonb,
	"profile_snapshot" jsonb,
	"worker_job_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	CONSTRAINT "pcb_cam_jobs_status_check" CHECK ("pcb_cam_jobs"."status" in ('pending', 'running', 'needs_review', 'blocked', 'done', 'failed', 'cancelled')),
	CONSTRAINT "pcb_cam_jobs_stage_check" CHECK ("pcb_cam_jobs"."current_stage" is null or "pcb_cam_jobs"."current_stage" in ('intake', 'order_spec', 'align', 'drill', 'inner', 'outer', 'mask', 'silk', 'net_compare', 'panel', 'output', 'gatekeeper')),
	CONSTRAINT "pcb_cam_jobs_retry_check" CHECK ("pcb_cam_jobs"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pcb_cam_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"customer_name" text,
	"factory_profile_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "pcb_cam_projects_status_check" CHECK ("pcb_cam_projects"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "pcb_cam_stage_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"job_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"report" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"error_message" text,
	CONSTRAINT "pcb_cam_stage_runs_stage_check" CHECK ("pcb_cam_stage_runs"."stage" in ('intake', 'order_spec', 'align', 'drill', 'inner', 'outer', 'mask', 'silk', 'net_compare', 'panel', 'output', 'gatekeeper')),
	CONSTRAINT "pcb_cam_stage_runs_status_check" CHECK ("pcb_cam_stage_runs"."status" in ('running', 'ok', 'needs_review', 'blocked', 'failed')),
	CONSTRAINT "pcb_cam_stage_runs_attempt_check" CHECK ("pcb_cam_stage_runs"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_departments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_roles" ADD CONSTRAINT "employee_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_leader_id_employees_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_artifacts" ADD CONSTRAINT "pcb_cam_artifacts_job_id_pcb_cam_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."pcb_cam_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_artifacts" ADD CONSTRAINT "pcb_cam_artifacts_stage_run_id_pcb_cam_stage_runs_id_fk" FOREIGN KEY ("stage_run_id") REFERENCES "public"."pcb_cam_stage_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_eq_items" ADD CONSTRAINT "pcb_cam_eq_items_job_id_pcb_cam_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."pcb_cam_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_eq_items" ADD CONSTRAINT "pcb_cam_eq_items_stage_run_id_pcb_cam_stage_runs_id_fk" FOREIGN KEY ("stage_run_id") REFERENCES "public"."pcb_cam_stage_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_jobs" ADD CONSTRAINT "pcb_cam_jobs_project_id_pcb_cam_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."pcb_cam_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_projects" ADD CONSTRAINT "pcb_cam_projects_factory_profile_id_pcb_cam_factory_profiles_id_fk" FOREIGN KEY ("factory_profile_id") REFERENCES "public"."pcb_cam_factory_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pcb_cam_stage_runs" ADD CONSTRAINT "pcb_cam_stage_runs_job_id_pcb_cam_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."pcb_cam_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_time_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_actor_idx" ON "audit_logs" USING btree ("tenant_id","actor_employee_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_target_idx" ON "audit_logs" USING btree ("tenant_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_action_idx" ON "audit_logs" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "login_devices_employee_idx" ON "login_devices" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "login_devices_expires_idx" ON "login_devices" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "qr_login_tickets_expires_idx" ON "qr_login_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "qr_login_tickets_employee_idx" ON "qr_login_tickets" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "revoked_tokens_expires_idx" ON "revoked_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "revoked_tokens_employee_idx" ON "revoked_tokens" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_tokens_hash_uq" ON "service_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "service_tokens_tenant_idx" ON "service_tokens" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_tokens_ai_session_uq" ON "service_tokens" USING btree ("tenant_id","employee_id") WHERE purpose = 'ai_session' AND revoked_at IS NULL AND is_deleted = false;--> statement-breakpoint
CREATE INDEX "db_backup_runs_date_idx" ON "db_backup_runs" USING btree ("local_date");--> statement-breakpoint
CREATE INDEX "db_backup_runs_live_idx" ON "db_backup_runs" USING btree ("verdict") WHERE pruned_at is null;--> statement-breakpoint
CREATE INDEX "db_backup_runs_restore_verified_idx" ON "db_backup_runs" USING btree ("restore_verified_at") WHERE restore_verdict = 'passed' and pruned_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "db_backup_runs_ok_per_day_uq" ON "db_backup_runs" USING btree ("local_date") WHERE verdict = 'ok' and pruned_at is null;--> statement-breakpoint
CREATE INDEX "departments_tenant_parent_idx" ON "departments" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE INDEX "departments_tenant_path_idx" ON "departments" USING btree ("tenant_id","path" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "employee_roles_role_idx" ON "employee_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_emp_no_uq" ON "employees" USING btree ("tenant_id","emp_no") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_phone_uq" ON "employees" USING btree ("tenant_id","phone") WHERE is_deleted = false;--> statement-breakpoint
CREATE INDEX "employees_tenant_dept_idx" ON "employees" USING btree ("tenant_id","department_id");--> statement-breakpoint
CREATE INDEX "employees_tenant_leader_idx" ON "employees" USING btree ("tenant_id","leader_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_code_uq" ON "roles" USING btree ("tenant_id","code") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_configs_tenant_idx" ON "llm_configs" USING btree ("tenant_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_provider_keys_tenant_provider_uq" ON "llm_provider_keys" USING btree ("tenant_id","provider") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_scene_configs_tenant_scene_uq" ON "llm_scene_configs" USING btree ("tenant_id","scene") WHERE is_deleted = false;--> statement-breakpoint
CREATE INDEX "llm_usage_logs_tenant_created_idx" ON "llm_usage_logs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "storage_configs_tenant_idx" ON "storage_configs" USING btree ("tenant_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_provider_configs_tenant_provider_uq" ON "storage_provider_configs" USING btree ("tenant_id","provider") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "notify_channel_configs_tenant_channel_uq" ON "notify_channel_configs" USING btree ("tenant_id","channel_type") WHERE is_deleted = false;--> statement-breakpoint
CREATE INDEX "inapp_notifications_recipient_idx" ON "inapp_notifications" USING btree ("tenant_id","recipient_id","is_read","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_settings_tenant_idx" ON "app_settings" USING btree ("tenant_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_toggles_tenant_key_idx" ON "feature_toggles" USING btree ("tenant_id","feature_key") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_orders_tenant_uq" ON "menu_orders" USING btree ("tenant_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE INDEX "pcb_cam_artifacts_job_kind_idx" ON "pcb_cam_artifacts" USING btree ("tenant_id","job_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "pcb_cam_artifacts_key_uq" ON "pcb_cam_artifacts" USING btree ("tenant_id","storage_key") WHERE is_deleted = false;--> statement-breakpoint
CREATE UNIQUE INDEX "pcb_cam_eq_items_item_uq" ON "pcb_cam_eq_items" USING btree ("job_id","stage","item_id") WHERE is_deleted = false;--> statement-breakpoint
CREATE INDEX "pcb_cam_eq_items_job_decision_idx" ON "pcb_cam_eq_items" USING btree ("tenant_id","job_id","decision");--> statement-breakpoint
CREATE INDEX "pcb_cam_eq_items_kind_idx" ON "pcb_cam_eq_items" USING btree ("tenant_id","kind","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pcb_cam_factory_profiles_name_uq" ON "pcb_cam_factory_profiles" USING btree ("tenant_id","name") WHERE is_deleted = false;--> statement-breakpoint
CREATE INDEX "pcb_cam_factory_profiles_tenant_idx" ON "pcb_cam_factory_profiles" USING btree ("tenant_id","is_default");--> statement-breakpoint
CREATE INDEX "pcb_cam_jobs_tenant_status_idx" ON "pcb_cam_jobs" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "pcb_cam_jobs_project_idx" ON "pcb_cam_jobs" USING btree ("tenant_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "pcb_cam_projects_tenant_idx" ON "pcb_cam_projects" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pcb_cam_stage_runs_attempt_uq" ON "pcb_cam_stage_runs" USING btree ("job_id","stage","attempt");--> statement-breakpoint
CREATE INDEX "pcb_cam_stage_runs_job_idx" ON "pcb_cam_stage_runs" USING btree ("tenant_id","job_id","started_at");