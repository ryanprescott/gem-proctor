CREATE TABLE "verification_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"items" jsonb,
	"summary" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "verification_job_status_check" CHECK ("verification_job"."status" IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "verification_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"test_version_id" uuid,
	"question_id" integer NOT NULL,
	"program_kind" text NOT NULL,
	"program" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"matched_option" text,
	"duration_ms" integer NOT NULL,
	"sandbox_version" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_run_kind_check" CHECK ("verification_run"."program_kind" IN ('author', 'blind')),
	CONSTRAINT "verification_run_status_check" CHECK ("verification_run"."status" IN ('ok', 'program_error', 'timeout', 'sandbox_denial', 'invalid_output'))
);
--> statement-breakpoint
ALTER TABLE "verification_job" ADD CONSTRAINT "verification_job_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_job_id_verification_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."verification_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_test_version_id_test_version_id_fk" FOREIGN KEY ("test_version_id") REFERENCES "public"."test_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_job_owner_idx" ON "verification_job" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_run_job_idx" ON "verification_run" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "verification_run_version_idx" ON "verification_run" USING btree ("test_version_id");