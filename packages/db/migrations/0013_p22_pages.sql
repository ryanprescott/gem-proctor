CREATE TABLE "source_file_page" (
	"file_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"markdown" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_file_page_file_id_page_pk" PRIMARY KEY("file_id","page")
);
--> statement-breakpoint
ALTER TABLE "source_file" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "source_file_page" ADD CONSTRAINT "source_file_page_file_id_source_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."source_file"("id") ON DELETE no action ON UPDATE no action;