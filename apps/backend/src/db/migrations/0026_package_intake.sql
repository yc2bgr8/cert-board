CREATE TYPE "public"."intake_job_state" AS ENUM('queued', 'running', 'expanded', 'failed');--> statement-breakpoint
CREATE TABLE "intake_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"relative_path" varchar(1024) NOT NULL,
	"parent_path" varchar(1024),
	"source_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"duplicate" boolean DEFAULT false NOT NULL,
	"category" varchar(32) NOT NULL,
	"confidence" double precision,
	"version_id" uuid,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_item_path_unique" UNIQUE("job_id","relative_path"),
	CONSTRAINT "intake_item_sha256" CHECK ("intake_item"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "intake_item_byte_size" CHECK ("intake_item"."byte_size" BETWEEN 0 AND 100663296),
	CONSTRAINT "intake_item_confidence" CHECK ("intake_item"."confidence" IS NULL OR "intake_item"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "intake_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"state" "intake_job_state" DEFAULT 'queued' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_job_project_content_unique" UNIQUE("project_id","sha256","data_level"),
	CONSTRAINT "intake_job_sha256" CHECK ("intake_job"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "intake_job_byte_size" CHECK ("intake_job"."byte_size" BETWEEN 1 AND 201326592),
	CONSTRAINT "intake_job_attempts" CHECK ("intake_job"."attempts" BETWEEN 0 AND 3),
	CONSTRAINT "intake_job_lease" CHECK (
    ("intake_job"."state" = 'running' AND "intake_job"."lease_token" IS NOT NULL AND "intake_job"."lease_until" IS NOT NULL) OR
    ("intake_job"."state" <> 'running' AND "intake_job"."lease_token" IS NULL AND "intake_job"."lease_until" IS NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_job_id_intake_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."intake_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_version_id_document_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_job" ADD CONSTRAINT "intake_job_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_job" ADD CONSTRAINT "intake_job_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_job_dispatch_idx" ON "intake_job" USING btree ("state","created_at");