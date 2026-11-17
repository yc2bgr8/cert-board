-- PR-05：项目主路径所需的六张业务表。仅本迁移在合并前补充；0000 保持不变。
CREATE TYPE "public"."cert_market" AS ENUM('US', 'CA', 'US_CA');--> statement-breakpoint
CREATE TYPE "public"."cert_project_status" AS ENUM('preparing', 'submitted', 'under_review', 'deficiency', 'approved', 'rejected', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."cert_project_type" AS ENUM('registration', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('local_test');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'waiting_materials', 'waiting_external', 'waiting_decision', 'pending_review', 'human_controlled', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."model_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."submission_snapshot_kind" AS ENUM('approved_review', 'rehearsal', 'submission');--> statement-breakpoint
CREATE SEQUENCE "public"."cert_project_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "cert_project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) DEFAULT replace(format('C%4s', nextval('public.cert_project_code_seq')), ' ', '0') NOT NULL,
	"name" varchar(255) NOT NULL,
	"development_seed_key" varchar(80),
	"project_type" "cert_project_type" DEFAULT 'registration' NOT NULL,
	"market" "cert_market" NOT NULL,
	"pathway" varchar(255) NOT NULL,
	"model_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"applicant_entity_id" uuid,
	"holder_entity_id" uuid,
	"target_at" timestamp with time zone,
	"jurisdiction_tz" varchar(100) DEFAULT 'America/New_York' NOT NULL,
	"status" "cert_project_status" DEFAULT 'preparing' NOT NULL,
	"submission_number" varchar(255),
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"next_action" text,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cert_project_code_unique" UNIQUE("code"),
	CONSTRAINT "cert_project_development_seed_key_unique" UNIQUE("development_seed_key"),
	CONSTRAINT "cert_project_code_format" CHECK ("cert_project"."code" ~ '^C[0-9]{4,}$'),
	CONSTRAINT "cert_project_name_not_blank" CHECK (length(btrim("cert_project"."name")) > 0),
	CONSTRAINT "cert_project_pathway_not_blank" CHECK (length(btrim("cert_project"."pathway")) > 0),
	CONSTRAINT "cert_project_timezone_not_blank" CHECK (length(btrim("cert_project"."jurisdiction_tz")) > 0),
	CONSTRAINT "cert_project_owner_reviewer_distinct" CHECK ("cert_project"."owner_user_id" <> "cert_project"."reviewer_user_id"),
	CONSTRAINT "cert_project_submission_dates_order" CHECK ("cert_project"."submitted_at" IS NULL OR "cert_project"."accepted_at" IS NULL OR "cert_project"."accepted_at" >= "cert_project"."submitted_at"),
	CONSTRAINT "cert_project_version_positive" CHECK ("cert_project"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"channel" "contact_channel" DEFAULT 'local_test' NOT NULL,
	"address" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "contact_project_channel_address_unique" UNIQUE("project_id","channel","address"),
	CONSTRAINT "contact_name_not_blank" CHECK (length(btrim("contact"."name")) > 0),
	CONSTRAINT "contact_address_format" CHECK (length(btrim("contact"."address")) > 0 AND "contact"."address" !~ '[[:cntrl:]]'),
	CONSTRAINT "contact_source_not_blank" CHECK (length(btrim("contact"."source")) > 0),
	CONSTRAINT "contact_version_positive" CHECK ("contact"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"acceptance_criteria" text NOT NULL,
	"due_at" timestamp with time zone,
	"budget_usd" numeric(12, 6) DEFAULT '10' NOT NULL,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"direction_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "goal_title_not_blank" CHECK (length(btrim("goal"."title")) > 0),
	CONSTRAINT "goal_acceptance_not_blank" CHECK (length(btrim("goal"."acceptance_criteria")) > 0),
	CONSTRAINT "goal_budget_nonnegative_finite" CHECK ("goal"."budget_usd" >= 0 AND "goal"."budget_usd" < 'Infinity'::numeric),
	CONSTRAINT "goal_direction_version_positive" CHECK ("goal"."direction_version" > 0),
	CONSTRAINT "goal_version_positive" CHECK ("goal"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) DEFAULT '' NOT NULL,
	"udi_di" varchar(128),
	"upc" varchar(12),
	"upc_note" text,
	"packaging" text,
	"research_project_ref" varchar(120),
	"status" "model_status" DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "model_code_unique" UNIQUE("code"),
	CONSTRAINT "model_code_format" CHECK ("model"."code" ~ '^[A-Z0-9][A-Z0-9.-]{1,31}$'),
	CONSTRAINT "model_upc_format" CHECK ("model"."upc" IS NULL OR "model"."upc" ~ '^[0-9]{12}$'),
	CONSTRAINT "model_source_not_blank" CHECK (length(btrim("model"."source")) > 0),
	CONSTRAINT "model_version_positive" CHECK ("model"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "product_code_unique" UNIQUE("code"),
	CONSTRAINT "product_code_format" CHECK ("product"."code" ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
	CONSTRAINT "product_name_not_blank" CHECK (length(btrim("product"."name")) > 0),
	CONSTRAINT "product_version_positive" CHECK ("product"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "submission_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "submission_snapshot_kind" NOT NULL,
	"file_manifest" jsonb NOT NULL,
	"manifest_sha256" varchar(64) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_snapshot_project_sequence_unique" UNIQUE("project_id","sequence"),
	CONSTRAINT "submission_snapshot_sequence_positive" CHECK ("submission_snapshot"."sequence" > 0),
	CONSTRAINT "submission_snapshot_manifest_array" CHECK (jsonb_typeof("submission_snapshot"."file_manifest") = 'array'),
	CONSTRAINT "submission_snapshot_hash_format" CHECK ("submission_snapshot"."manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "cert_project" ADD CONSTRAINT "cert_project_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_project" ADD CONSTRAINT "cert_project_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_project" ADD CONSTRAINT "cert_project_reviewer_user_id_app_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_project" ADD CONSTRAINT "cert_project_applicant_entity_id_legal_entity_id_fk" FOREIGN KEY ("applicant_entity_id") REFERENCES "public"."legal_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_project" ADD CONSTRAINT "cert_project_holder_entity_id_legal_entity_id_fk" FOREIGN KEY ("holder_entity_id") REFERENCES "public"."legal_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_project" ADD CONSTRAINT "cert_project_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_snapshot" ADD CONSTRAINT "submission_snapshot_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_snapshot" ADD CONSTRAINT "submission_snapshot_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cert_project_model_idx" ON "cert_project" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "cert_project_owner_idx" ON "cert_project" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "cert_project_reviewer_idx" ON "cert_project" USING btree ("reviewer_user_id");--> statement-breakpoint
CREATE INDEX "contact_project_idx" ON "contact" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "goal_project_idx" ON "goal" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "goal_owner_idx" ON "goal" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "model_product_idx" ON "model" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "submission_snapshot_project_idx" ON "submission_snapshot" USING btree ("project_id");
--> statement-breakpoint

-- 冻结记录永不覆盖；语句级 ALWAYS 触发器也拒绝空表修改及 TRUNCATE。
CREATE FUNCTION public.reject_submission_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $snapshot_guard$
BEGIN
    RAISE EXCEPTION '冻结快照不能更新、删除或清空，请建立新的工作区版本并重新审核。'
        USING ERRCODE = '42501';
END;
$snapshot_guard$;
--> statement-breakpoint
CREATE TRIGGER submission_snapshot_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.submission_snapshot
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_submission_snapshot_mutation();
--> statement-breakpoint
ALTER TABLE public.submission_snapshot ENABLE ALWAYS TRIGGER submission_snapshot_immutable;
--> statement-breakpoint

-- 仅授予本次显式列出的业务表读取权限，不授予序列或任何写入权限。
GRANT SELECT ON public.product, public.model, public.cert_project, public.goal,
    public.contact, public.submission_snapshot TO cert_board_reader;
