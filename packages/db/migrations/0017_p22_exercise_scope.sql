ALTER TABLE "authoring_session_source" ADD COLUMN "exercise_section_ids" uuid[];--> statement-breakpoint
ALTER TABLE "objective" ADD COLUMN "kind" text DEFAULT 'content' NOT NULL;--> statement-breakpoint
ALTER TABLE "objective" ADD CONSTRAINT "objective_kind_check" CHECK ("objective"."kind" IN ('content', 'exercise'));