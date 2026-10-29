CREATE TABLE "practice_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"test_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"shuffle_seed" text NOT NULL,
	"question_ids" integer[],
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"duration_ms" bigint,
	"score" numeric(10, 2),
	"max_score" numeric(10, 2) NOT NULL,
	CONSTRAINT "practice_attempt_kind_check" CHECK ("practice_attempt"."kind" IN ('full', 'retake_missed')),
	CONSTRAINT "practice_attempt_seed_check" CHECK ("practice_attempt"."shuffle_seed" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "practice_attempt_question_ids_check" CHECK (("practice_attempt"."kind" = 'full') = ("practice_attempt"."question_ids" IS NULL)),
	CONSTRAINT "practice_attempt_submitted_check" CHECK (("practice_attempt"."submitted_at" IS NULL) = ("practice_attempt"."score" IS NULL) AND ("practice_attempt"."submitted_at" IS NULL) = ("practice_attempt"."duration_ms" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "response" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" integer NOT NULL,
	"answer" jsonb,
	"auto_result" text,
	"points_awarded" numeric(10, 2) DEFAULT 0 NOT NULL,
	"self_graded" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered_at" timestamp with time zone,
	"time_spent_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "response_attempt_question_unique" UNIQUE("attempt_id","question_id"),
	CONSTRAINT "response_auto_result_check" CHECK ("response"."auto_result" IN ('correct', 'partial', 'incorrect')),
	CONSTRAINT "response_time_spent_check" CHECK ("response"."time_spent_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "practice_attempt" ADD CONSTRAINT "practice_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_attempt" ADD CONSTRAINT "practice_attempt_test_version_id_test_version_id_fk" FOREIGN KEY ("test_version_id") REFERENCES "public"."test_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response" ADD CONSTRAINT "response_attempt_id_practice_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."practice_attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "practice_attempt_user_idx" ON "practice_attempt" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "practice_attempt_version_idx" ON "practice_attempt" USING btree ("test_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_attempt_in_progress_unique" ON "practice_attempt" USING btree ("user_id","test_version_id") WHERE "practice_attempt"."submitted_at" IS NULL;