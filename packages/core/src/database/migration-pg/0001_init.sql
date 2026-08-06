CREATE TABLE "workspace" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"branch" text,
	"directory" text,
	"extra" jsonb,
	"project_id" text NOT NULL,
	"time_used" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_migration" (
	"name" text PRIMARY KEY,
	"time_completed" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_state" (
	"id" bigint PRIMARY KEY,
	"active_account_id" text,
	"active_org_id" text
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"url" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expiry" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_account" (
	"email" text,
	"url" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expiry" bigint,
	"active" boolean NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "control_account_pkey" PRIMARY KEY("email","url")
);
--> statement-breakpoint
CREATE TABLE "event_sequence" (
	"aggregate_id" text PRIMARY KEY,
	"seq" bigint NOT NULL,
	"owner_id" text
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" text PRIMARY KEY,
	"aggregate_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_directory" (
	"project_id" text,
	"directory" text,
	"type" text,
	"strategy" text,
	"time_created" bigint NOT NULL,
	CONSTRAINT "project_directory_pkey" PRIMARY KEY("project_id","directory")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"worktree" text NOT NULL,
	"vcs" text,
	"name" text,
	"icon_url" text,
	"icon_url_override" text,
	"icon_color" text,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_initialized" bigint,
	"sandboxes" text NOT NULL,
	"commands" jsonb
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_context_epoch" (
	"session_id" text PRIMARY KEY,
	"baseline" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"baseline_seq" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_input" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"prompt" jsonb NOT NULL,
	"delivery" text NOT NULL,
	"admitted_seq" bigint NOT NULL,
	"promoted_seq" bigint,
	"time_created" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_message" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"seq" bigint NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"workspace_id" text,
	"parent_id" text,
	"slug" text NOT NULL,
	"directory" text NOT NULL,
	"path" text,
	"title" text NOT NULL,
	"version" text NOT NULL,
	"share_url" text,
	"summary_additions" bigint,
	"summary_deletions" bigint,
	"summary_files" bigint,
	"summary_diffs" jsonb,
	"metadata" jsonb,
	"cost" double precision DEFAULT 0 NOT NULL,
	"tokens_input" bigint DEFAULT 0 NOT NULL,
	"tokens_output" bigint DEFAULT 0 NOT NULL,
	"tokens_reasoning" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_read" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_write" bigint DEFAULT 0 NOT NULL,
	"revert" jsonb,
	"permission" jsonb,
	"agent" text,
	"model" jsonb,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	"time_compacting" bigint,
	"time_archived" bigint
);
--> statement-breakpoint
CREATE TABLE "todo" (
	"session_id" text,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"position" bigint,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL,
	CONSTRAINT "todo_pkey" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "session_share" (
	"session_id" text PRIMARY KEY,
	"id" text NOT NULL,
	"secret" text NOT NULL,
	"url" text NOT NULL,
	"time_created" bigint NOT NULL,
	"time_updated" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "event_aggregate_seq_idx" ON "event" ("aggregate_id","seq");--> statement-breakpoint
CREATE INDEX "event_aggregate_type_seq_idx" ON "event" ("aggregate_id","type","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_project_action_resource_idx" ON "permission" ("project_id","action","resource");--> statement-breakpoint
CREATE INDEX "message_session_time_created_id_idx" ON "message" ("session_id","time_created","id");--> statement-breakpoint
CREATE INDEX "part_message_id_id_idx" ON "part" ("message_id","id");--> statement-breakpoint
CREATE INDEX "part_session_idx" ON "part" ("session_id");--> statement-breakpoint
CREATE INDEX "session_input_session_pending_delivery_seq_idx" ON "session_input" ("session_id","promoted_seq","delivery","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_input_session_admitted_seq_idx" ON "session_input" ("session_id","admitted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_input_session_promoted_seq_idx" ON "session_input" ("session_id","promoted_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_message_session_seq_idx" ON "session_message" ("session_id","seq");--> statement-breakpoint
CREATE INDEX "session_message_session_type_seq_idx" ON "session_message" ("session_id","type","seq");--> statement-breakpoint
CREATE INDEX "session_message_session_time_created_id_idx" ON "session_message" ("session_id","time_created","id");--> statement-breakpoint
CREATE INDEX "session_message_time_created_idx" ON "session_message" ("time_created");--> statement-breakpoint
CREATE INDEX "session_project_idx" ON "session" ("project_id");--> statement-breakpoint
CREATE INDEX "session_workspace_idx" ON "session" ("workspace_id");--> statement-breakpoint
CREATE INDEX "session_parent_idx" ON "session" ("parent_id");--> statement-breakpoint
CREATE INDEX "todo_session_idx" ON "todo" ("session_id");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_state" ADD CONSTRAINT "account_state_active_account_id_account_id_fkey" FOREIGN KEY ("active_account_id") REFERENCES "account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_aggregate_id_event_sequence_aggregate_id_fkey" FOREIGN KEY ("aggregate_id") REFERENCES "event_sequence"("aggregate_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "permission" ADD CONSTRAINT "permission_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_directory" ADD CONSTRAINT "project_directory_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "part" ADD CONSTRAINT "part_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_context_epoch" ADD CONSTRAINT "session_context_epoch_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_input" ADD CONSTRAINT "session_input_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_message" ADD CONSTRAINT "session_message_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "todo" ADD CONSTRAINT "todo_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session_share" ADD CONSTRAINT "session_share_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;