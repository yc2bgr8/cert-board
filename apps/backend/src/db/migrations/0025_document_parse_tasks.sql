CREATE TYPE "public"."document_parse_state" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
ALTER TYPE "public"."document_page_method" ADD VALUE 'xlsx';--> statement-breakpoint
CREATE TABLE "document_parse_task" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"format" varchar(8) NOT NULL,
	"state" "document_parse_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_parse_task_format" CHECK ("document_parse_task"."format" IN ('pdf','estar','doc','docx','xlsx')),
	CONSTRAINT "document_parse_task_attempts" CHECK ("document_parse_task"."attempts" BETWEEN 0 AND 3),
	CONSTRAINT "document_parse_task_lease" CHECK (
      ("document_parse_task"."state" = 'running' AND "document_parse_task"."lease_token" IS NOT NULL AND "document_parse_task"."lease_until" IS NOT NULL) OR
      ("document_parse_task"."state" <> 'running' AND "document_parse_task"."lease_token" IS NULL AND "document_parse_task"."lease_until" IS NULL)
    ),
	CONSTRAINT "document_parse_task_error_code" CHECK ("document_parse_task"."error_code" IS NULL OR "document_parse_task"."error_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
ALTER TABLE "document_parse_task" ADD CONSTRAINT "document_parse_task_version_id_document_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_parse_task_dispatch_idx" ON "document_parse_task" USING btree ("state","available_at");
--> statement-breakpoint
GRANT SELECT (version_id,state,attempts,error_code) ON public.document_parse_task TO cert_board_reader;
