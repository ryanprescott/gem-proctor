CREATE TABLE "authoring_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"status" text NOT NULL,
	"plan" jsonb NOT NULL,
	"error_code" text,
	"failed_items" jsonb NOT NULL,
	"call_log_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "authoring_batch_status_check" CHECK ("authoring_batch"."status" IN ('queued', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "authoring_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"model" text,
	"test_type" text NOT NULL,
	"blueprint" jsonb,
	"used_values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "authoring_session_status_check" CHECK ("authoring_session"."status" IN ('draft', 'generating', 'review', 'published'))
);
--> statement-breakpoint
CREATE TABLE "authoring_session_source" (
	"session_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"section_ids" uuid[],
	CONSTRAINT "authoring_session_source_session_id_source_id_pk" PRIMARY KEY("session_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "draft_question" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"batch_id" uuid,
	"temp_id" text NOT NULL,
	"position" integer NOT NULL,
	"content" jsonb NOT NULL,
	"status" text NOT NULL,
	"creator_note" text,
	"supersedes_id" uuid,
	"edited_by" uuid,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_question_status_check" CHECK ("draft_question"."status" IN ('proposed', 'accepted', 'rejected', 'locked'))
);
--> statement-breakpoint
CREATE TABLE "objective" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"evidence" jsonb NOT NULL,
	"origin" text NOT NULL,
	"order" integer NOT NULL,
	"section_ids" uuid[] NOT NULL,
	CONSTRAINT "objective_origin_check" CHECK ("objective"."origin" IN ('llm', 'human', 'heading'))
);
--> statement-breakpoint
CREATE TABLE "question_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"draft_question_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"revision_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_event_kind_check" CHECK ("question_event"."kind" IN ('generated', 'regenerated', 'edited', 'accepted', 'rejected', 'locked', 'fix_accepted', 'answer_computed', 'reclassified'))
);
--> statement-breakpoint
CREATE TABLE "retrieval_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid,
	"objective_id" uuid,
	"query" text NOT NULL,
	"scope" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"embedding_model" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"trigger" text NOT NULL,
	"request" jsonb NOT NULL,
	"usage" jsonb,
	"seed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_trigger_check" CHECK ("revision"."trigger" IN ('generate', 'revise'))
);
--> statement-breakpoint
CREATE TABLE "source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"citation_label" text NOT NULL,
	"author" text,
	"edition" text,
	"url" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "source_visibility_check" CHECK ("source"."visibility" IN ('private'))
);
--> statement-breakpoint
CREATE TABLE "source_chunk" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"chunk_key" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"content_hash" text NOT NULL,
	"text" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(768),
	"embedding_model" text,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text) || to_tsvector('simple', text)) STORED NOT NULL,
	"flagged_at" timestamp with time zone,
	"flag_reason" text,
	CONSTRAINT "source_chunk_offsets_check" CHECK ("source_chunk"."char_start" >= 0 AND "source_chunk"."char_end" > "source_chunk"."char_start")
);
--> statement-breakpoint
CREATE TABLE "source_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"markdown" text NOT NULL,
	"format" text NOT NULL,
	"content_hash" text NOT NULL,
	"embed_status" text NOT NULL,
	"embed_error" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_revision_status_check" CHECK ("source_revision"."embed_status" IN ('pending', 'embedding', 'ready', 'failed')),
	CONSTRAINT "source_revision_format_check" CHECK ("source_revision"."format" IN ('markdown', 'text'))
);
--> statement-breakpoint
CREATE TABLE "source_section" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"parent_id" uuid,
	"level" integer NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"order" integer NOT NULL,
	"heading_path" text[] NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"draft_question_id" uuid NOT NULL,
	"revision_id" uuid,
	"layer" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_result_layer_check" CHECK ("validation_result"."layer" IN ('L1', 'L2', 'L3', 'L7')),
	CONSTRAINT "validation_result_outcome_check" CHECK ("validation_result"."outcome" IN ('pass', 'warn', 'fail'))
);
--> statement-breakpoint
ALTER TABLE "verification_run" ADD COLUMN "draft_question_id" uuid;--> statement-breakpoint
ALTER TABLE "authoring_batch" ADD CONSTRAINT "authoring_batch_session_id_authoring_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."authoring_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_batch" ADD CONSTRAINT "authoring_batch_revision_id_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_session" ADD CONSTRAINT "authoring_session_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_session_source" ADD CONSTRAINT "authoring_session_source_session_id_authoring_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."authoring_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_session_source" ADD CONSTRAINT "authoring_session_source_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authoring_session_source" ADD CONSTRAINT "authoring_session_source_revision_id_source_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_question" ADD CONSTRAINT "draft_question_session_id_authoring_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."authoring_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_question" ADD CONSTRAINT "draft_question_revision_id_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_question" ADD CONSTRAINT "draft_question_batch_id_authoring_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."authoring_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_question" ADD CONSTRAINT "draft_question_edited_by_user_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_question" ADD CONSTRAINT "draft_question_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."draft_question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective" ADD CONSTRAINT "objective_session_id_authoring_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."authoring_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_event" ADD CONSTRAINT "question_event_draft_question_id_draft_question_id_fk" FOREIGN KEY ("draft_question_id") REFERENCES "public"."draft_question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_event" ADD CONSTRAINT "question_event_revision_id_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_log" ADD CONSTRAINT "retrieval_log_revision_id_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision" ADD CONSTRAINT "revision_session_id_authoring_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."authoring_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunk" ADD CONSTRAINT "source_chunk_revision_id_source_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_chunk" ADD CONSTRAINT "source_chunk_section_id_source_section_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."source_section"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_section" ADD CONSTRAINT "source_section_revision_id_source_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."source_revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_section" ADD CONSTRAINT "source_section_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."source_section"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_draft_question_id_draft_question_id_fk" FOREIGN KEY ("draft_question_id") REFERENCES "public"."draft_question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_result" ADD CONSTRAINT "validation_result_revision_id_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revision"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authoring_batch_session_idx" ON "authoring_batch" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "authoring_session_owner_idx" ON "authoring_session" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "draft_question_session_idx" ON "draft_question" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_question_position_unique" ON "draft_question" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "objective_session_idx" ON "objective" USING btree ("session_id","order");--> statement-breakpoint
CREATE INDEX "question_event_question_idx" ON "question_event" USING btree ("draft_question_id","at");--> statement-breakpoint
CREATE INDEX "retrieval_log_revision_idx" ON "retrieval_log" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_number_unique" ON "revision" USING btree ("session_id","number");--> statement-breakpoint
CREATE INDEX "source_owner_idx" ON "source" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_chunk_key_unique" ON "source_chunk" USING btree ("revision_id","chunk_key");--> statement-breakpoint
CREATE INDEX "source_chunk_section_idx" ON "source_chunk" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "source_chunk_hash_idx" ON "source_chunk" USING btree ("content_hash","embedding_model");--> statement-breakpoint
CREATE INDEX "source_chunk_embedding_idx" ON "source_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "source_chunk_tsv_idx" ON "source_chunk" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revision_number_unique" ON "source_revision" USING btree ("source_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "source_section_order_unique" ON "source_section" USING btree ("revision_id","order");--> statement-breakpoint
CREATE INDEX "validation_result_question_idx" ON "validation_result" USING btree ("draft_question_id","at");--> statement-breakpoint
ALTER TABLE "test" ADD CONSTRAINT "test_authoring_session_fk" FOREIGN KEY ("authoring_session_id") REFERENCES "public"."authoring_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_run" ADD CONSTRAINT "verification_run_draft_question_id_draft_question_id_fk" FOREIGN KEY ("draft_question_id") REFERENCES "public"."draft_question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_run_draft_idx" ON "verification_run" USING btree ("draft_question_id");