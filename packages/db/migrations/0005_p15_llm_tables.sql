CREATE TABLE "endpoint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"api_key_ciphertext" text,
	"location" text NOT NULL,
	"server" text,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"timeout_ms" integer DEFAULT 300000 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "endpoint_location_check" CHECK ("endpoint"."location" IN ('local', 'cloud')),
	CONSTRAINT "endpoint_server_check" CHECK ("endpoint"."server" IN ('vllm', 'llamacpp', 'ollama', 'lmstudio', 'gateway', 'other')),
	CONSTRAINT "endpoint_concurrency_check" CHECK ("endpoint"."concurrency" >= 1),
	CONSTRAINT "endpoint_timeout_check" CHECK ("endpoint"."timeout_ms" >= 1)
);
--> statement-breakpoint
CREATE TABLE "llm_call_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"model" text NOT NULL,
	"role" text,
	"kind" text NOT NULL,
	"prompt_id" text,
	"prompt_version" text,
	"prompt_file" text,
	"mode" text NOT NULL,
	"finish_reason" text,
	"outcome" text NOT NULL,
	"error_code" text,
	"repair_attempts" integer DEFAULT 0 NOT NULL,
	"normalization_fixes" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"queued_ms" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"actor_id" uuid,
	"eval_run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_body" jsonb,
	"response_body" jsonb,
	CONSTRAINT "llm_call_log_kind_check" CHECK ("llm_call_log"."kind" IN ('call', 'probe', 'eval')),
	CONSTRAINT "llm_call_log_outcome_check" CHECK ("llm_call_log"."outcome" IN ('ok', 'salvaged', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "llm_eval_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"eval_set" text NOT NULL,
	"role" text NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text NOT NULL,
	"trials" integer NOT NULL,
	"summary" jsonb,
	"items" jsonb,
	"error_code" text,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "llm_eval_run_status_check" CHECK ("llm_eval_run"."status" IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "role_assignment" (
	"role" text PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"model" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"embedding" jsonb,
	"params" jsonb,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignment_role_check" CHECK ("role_assignment"."role" IN ('authoring.objectives', 'authoring.generate', 'authoring.judge', 'verify.solve', 'analysis', 'embeddings')),
	CONSTRAINT "role_assignment_embedding_check" CHECK (("role_assignment"."role" = 'embeddings') = ("role_assignment"."embedding" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "endpoint" ADD CONSTRAINT "endpoint_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_log" ADD CONSTRAINT "llm_call_log_endpoint_id_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_log" ADD CONSTRAINT "llm_call_log_eval_run_id_llm_eval_run_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."llm_eval_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_eval_run" ADD CONSTRAINT "llm_eval_run_endpoint_id_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_eval_run" ADD CONSTRAINT "llm_eval_run_started_by_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_endpoint_id_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_call_log_at_idx" ON "llm_call_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "llm_call_log_stats_idx" ON "llm_call_log" USING btree ("role","endpoint_id","model","at");--> statement-breakpoint
CREATE INDEX "llm_eval_run_created_idx" ON "llm_eval_run" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_eval_run_active_unique" ON "llm_eval_run" USING btree ("role") WHERE "llm_eval_run"."status" IN ('queued', 'running');