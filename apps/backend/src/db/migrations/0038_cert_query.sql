CREATE TABLE "cert_milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"milestone_type" varchar(80) NOT NULL,
	"title" varchar(255) NOT NULL,
	"planned_date" date NOT NULL,
	"completed_date" date,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "cert_milestone_values" CHECK (length(btrim("cert_milestone"."milestone_type")) > 0
      AND length(btrim("cert_milestone"."title")) > 0 AND "cert_milestone"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "cert_query_coverage" (
	"project_id" uuid NOT NULL,
	"dataset" varchar(24) NOT NULL,
	"source" varchar(255) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	CONSTRAINT "cert_query_coverage_project_id_dataset_pk" PRIMARY KEY("project_id","dataset"),
	CONSTRAINT "cert_query_coverage_values" CHECK ("cert_query_coverage"."dataset" IN ('credential','market_authorization','cert_milestone')
      AND length(btrim("cert_query_coverage"."source")) > 0)
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"model_id" uuid,
	"holder_entity_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"credential_type" varchar(80) NOT NULL,
	"credential_number" varchar(120) NOT NULL,
	"market" "cert_market",
	"effective_date" date,
	"expiry_date" date,
	"expiry_kind" varchar(16) DEFAULT 'unknown' NOT NULL,
	"status" varchar(16) NOT NULL,
	"source" varchar(255) NOT NULL,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "credential_values" CHECK (length(btrim("credential"."credential_type")) > 0
      AND length(btrim("credential"."credential_number")) > 0 AND length(btrim("credential"."source")) > 0
      AND "credential"."version" > 0 AND "credential"."status" IN ('active','expired','revoked')),
	CONSTRAINT "credential_expiry" CHECK ("credential"."expiry_kind" IN ('dated','perpetual','unknown')
      AND ("credential"."expiry_kind" = 'dated') = ("credential"."expiry_date" IS NOT NULL)
      AND ("credential"."expiry_date" IS NULL OR "credential"."effective_date" IS NULL OR "credential"."effective_date" <= "credential"."expiry_date"))
);
--> statement-breakpoint
CREATE TABLE "market_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"market" "cert_market" NOT NULL,
	"status" varchar(16) NOT NULL,
	"credential_id" uuid,
	"source" varchar(255) NOT NULL,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "market_authorization_model_market_key" UNIQUE("model_id","market"),
	CONSTRAINT "market_authorization_market" CHECK ("market_authorization"."market" IN ('US','CA')),
	CONSTRAINT "market_authorization_status" CHECK ("market_authorization"."status" IN ('not_applied','in_progress','sellable','listed','inactive')
      AND ("market_authorization"."status" NOT IN ('sellable','listed') OR "market_authorization"."credential_id" IS NOT NULL)
      AND "market_authorization"."version" > 0 AND length(btrim("market_authorization"."source")) > 0)
);
--> statement-breakpoint
ALTER TABLE "run_event" ADD COLUMN "cert_query" jsonb;--> statement-breakpoint
ALTER TABLE "cert_milestone" ADD CONSTRAINT "cert_milestone_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_milestone" ADD CONSTRAINT "cert_milestone_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cert_query_coverage" ADD CONSTRAINT "cert_query_coverage_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_holder_entity_id_legal_entity_id_fk" FOREIGN KEY ("holder_entity_id") REFERENCES "public"."legal_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_authorization" ADD CONSTRAINT "market_authorization_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_authorization" ADD CONSTRAINT "market_authorization_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_authorization" ADD CONSTRAINT "market_authorization_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cert_milestone_project_date_idx" ON "cert_milestone" USING btree ("project_id","planned_date");--> statement-breakpoint
CREATE INDEX "credential_project_expiry_idx" ON "credential" USING btree ("project_id","expiry_date");--> statement-breakpoint
CREATE INDEX "market_authorization_project_idx" ON "market_authorization" USING btree ("project_id","market");
--> statement-breakpoint
-- 固定模板只读取结果、版本和范围所需的字段。正文、凭据和审核载荷不授权。
GRANT SELECT (id, code, model_id, market, jurisdiction_tz) ON public.cert_project TO cert_board_reader;
--> statement-breakpoint
GRANT SELECT (id, code, status) ON public.model TO cert_board_reader;
--> statement-breakpoint
GRANT SELECT (id, project_id, model_id, credential_type, credential_number, market,
  effective_date, expiry_date, expiry_kind, status, data_level, version)
  ON public.credential TO cert_board_reader;
--> statement-breakpoint
GRANT SELECT (id, project_id, model_id, market, status, credential_id, data_level, version)
  ON public.market_authorization TO cert_board_reader;
--> statement-breakpoint
GRANT SELECT (id, project_id, milestone_type, title, planned_date, completed_date, data_level, version)
  ON public.cert_milestone TO cert_board_reader;
--> statement-breakpoint
GRANT SELECT (project_id, dataset, verified_at, data_level)
  ON public.cert_query_coverage TO cert_board_reader;
--> statement-breakpoint
GRANT SELECT (id, project_id, conversation_id, status, version, data_level, created_at)
  ON public.review_card TO cert_board_reader;
