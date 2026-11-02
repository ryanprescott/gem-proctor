CREATE TABLE "source_file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"strategy" text NOT NULL,
	"page_range" text,
	"status" text NOT NULL,
	"error_code" text,
	"error_params" jsonb,
	"markdown" text,
	"page_count" integer,
	"pages_converted" integer,
	"figures" integer,
	"warnings" jsonb NOT NULL,
	"converter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "source_file_status_check" CHECK ("source_file"."status" IN ('pending', 'converting', 'ready', 'failed')),
	CONSTRAINT "source_file_strategy_check" CHECK ("source_file"."strategy" IN ('rasterize', 'text'))
);
--> statement-breakpoint
ALTER TABLE "role_assignment" DROP CONSTRAINT "role_assignment_role_check";--> statement-breakpoint
ALTER TABLE "source_revision" ADD COLUMN "source_file_id" uuid;--> statement-breakpoint
ALTER TABLE "source_file" ADD CONSTRAINT "source_file_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_file_owner_idx" ON "source_file" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_source_file_id_source_file_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "public"."source_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_role_check" CHECK ("role_assignment"."role" IN ('authoring.objectives', 'authoring.generate', 'authoring.judge', 'verify.solve', 'analysis', 'embeddings', 'document.ocr'));