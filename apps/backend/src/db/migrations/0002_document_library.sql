-- PR-06：资料版本是导入快照；实际存储内容哈希与原始文件声明哈希分开保存。
CREATE TYPE "public"."document_author_type" AS ENUM('ai', 'human', 'external');--> statement-breakpoint
CREATE TYPE "public"."document_content_kind" AS ENUM('parsed_text', 'original');--> statement-breakpoint
CREATE TYPE "public"."document_data_level" AS ENUM('public', 'internal', 'confidential');--> statement-breakpoint
CREATE TYPE "public"."document_locator_kind" AS ENUM('physical_page', 'extraction_unit');--> statement-breakpoint
CREATE TYPE "public"."document_page_method" AS ENUM('text', 'ocr', 'docx');--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_key" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_path" varchar(2048) NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"imported_by" uuid,
	"voided" boolean DEFAULT false NOT NULL,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "document_project_source_unique" UNIQUE("project_id","source_key"),
	CONSTRAINT "document_source_key_not_blank" CHECK (length(btrim("document"."source_key")) > 0),
	CONSTRAINT "document_name_not_blank" CHECK (length(btrim("document"."name")) > 0),
	CONSTRAINT "document_source_path_not_blank" CHECK (length(btrim("document"."source_path")) > 0),
	CONSTRAINT "document_void_reason_consistent" CHECK ((NOT "document"."voided" AND "document"."void_reason" IS NULL) OR ("document"."voided" AND "document"."void_reason" IS NOT NULL AND length(btrim("document"."void_reason")) > 0)),
	CONSTRAINT "document_version_positive" CHECK ("document"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "document_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"text" text NOT NULL,
	"method" "document_page_method" NOT NULL,
	"locator_kind" "document_locator_kind" NOT NULL,
	"ocr_score" double precision,
	"is_placeholder" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_page_number_unique" UNIQUE("version_id","page_number"),
	CONSTRAINT "document_page_number_positive" CHECK ("document_page"."page_number" > 0),
	CONSTRAINT "document_page_text_limit" CHECK (length("document_page"."text") <= 1000000),
	CONSTRAINT "document_page_ocr_score_range" CHECK ("document_page"."ocr_score" IS NULL OR ("document_page"."ocr_score" >= 0 AND "document_page"."ocr_score" <= 1))
);
--> statement-breakpoint
CREATE TABLE "document_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"source_snapshot" varchar(64) NOT NULL,
	"original_sha256" varchar(64),
	"content_sha256" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"media_type" varchar(255) NOT NULL,
	"content_kind" "document_content_kind" NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"author_type" "document_author_type" NOT NULL,
	"imported_by" uuid,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_number_unique" UNIQUE("document_id","version_no"),
	CONSTRAINT "document_version_snapshot_unique" UNIQUE("document_id","source_snapshot"),
	CONSTRAINT "document_version_number_positive" CHECK ("document_version"."version_no" > 0),
	CONSTRAINT "document_version_snapshot_hash_format" CHECK ("document_version"."source_snapshot" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_version_original_hash_format" CHECK ("document_version"."original_sha256" IS NULL OR "document_version"."original_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_version_content_hash_format" CHECK ("document_version"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_version_size_safe" CHECK ("document_version"."byte_size" >= 0 AND "document_version"."byte_size" <= 9007199254740991),
	CONSTRAINT "document_version_media_type_not_blank" CHECK (length(btrim("document_version"."media_type")) > 0),
	CONSTRAINT "document_version_source_metadata_object" CHECK (jsonb_typeof("document_version"."source_metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_imported_by_app_user_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_page" ADD CONSTRAINT "document_page_version_id_document_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_imported_by_app_user_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_project_idx" ON "document" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "document_owner_idx" ON "document" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "document_page_version_idx" ON "document_page" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "document_version_document_idx" ON "document_version" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_version_content_idx" ON "document_version" USING btree ("content_sha256");
--> statement-breakpoint

CREATE FUNCTION public.reject_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $document_guard$
BEGIN
    RAISE EXCEPTION '资料不能删除或清空，请登记作废原因并保留原版本。'
        USING ERRCODE = '42501';
END;
$document_guard$;
--> statement-breakpoint
CREATE TRIGGER document_no_deletion
BEFORE DELETE OR TRUNCATE ON public.document
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_document_deletion();
--> statement-breakpoint
ALTER TABLE public.document ENABLE ALWAYS TRIGGER document_no_deletion;
--> statement-breakpoint

CREATE FUNCTION public.reject_document_content_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $content_guard$
BEGIN
    RAISE EXCEPTION '资料版本和逐页原文只允许追加，请导入新快照而不是覆盖或删除原文。'
        USING ERRCODE = '42501';
END;
$content_guard$;
--> statement-breakpoint
CREATE TRIGGER document_version_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.document_version
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_document_content_mutation();
--> statement-breakpoint
ALTER TABLE public.document_version ENABLE ALWAYS TRIGGER document_version_append_only;
--> statement-breakpoint
CREATE TRIGGER document_page_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.document_page
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_document_content_mutation();
--> statement-breakpoint
ALTER TABLE public.document_page ENABLE ALWAYS TRIGGER document_page_append_only;
--> statement-breakpoint
GRANT SELECT ON public.document, public.document_version, public.document_page TO cert_board_reader;
