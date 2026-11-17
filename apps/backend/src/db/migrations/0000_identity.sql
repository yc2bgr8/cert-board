-- PR-02：Drizzle 生成的身份、审计和法律主体基础结构。
-- 文件末尾补充数据库级审计保护和只读角色；合并后不得修改本迁移。
CREATE TYPE "public"."audit_actor_kind" AS ENUM('browser', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."entity_role_type" AS ENUM('applicant', 'manufacturer', 'holder', 'importer', 'us_agent');--> statement-breakpoint
CREATE TYPE "public"."legal_entity_type" AS ENUM('company', 'affiliate', 'agent', 'importer', 'external_manufacturer');--> statement-breakpoint
CREATE TYPE "public"."role_scope_type" AS ENUM('global', 'project', 'own');--> statement-breakpoint
CREATE TYPE "public"."app_role" AS ENUM('RA', 'RB', 'GM', 'SALES', 'TECH');--> statement-breakpoint
CREATE TYPE "public"."app_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(80) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"status" "app_user_status" DEFAULT 'active' NOT NULL,
	"is_development" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "app_user_username_unique" UNIQUE("username"),
	CONSTRAINT "app_user_username_format" CHECK ("app_user"."username" ~ '^[a-z0-9][a-z0-9_.@-]{1,79}$'),
	CONSTRAINT "app_user_password_hash_format" CHECK ("app_user"."password_hash" LIKE '$argon2id$%'),
	CONSTRAINT "app_user_display_name_not_blank" CHECK (length(btrim("app_user"."display_name")) > 0),
	CONSTRAINT "app_user_version_positive" CHECK ("app_user"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"action" varchar(120) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" varchar(255) NOT NULL,
	"before_hash" varchar(64),
	"after_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_required" CHECK ("audit_log"."actor_kind" = 'system' OR "audit_log"."actor_user_id" IS NOT NULL),
	CONSTRAINT "audit_log_action_not_blank" CHECK (length(btrim("audit_log"."action")) > 0),
	CONSTRAINT "audit_log_target_type_not_blank" CHECK (length(btrim("audit_log"."target_type")) > 0),
	CONSTRAINT "audit_log_target_id_not_blank" CHECK (length(btrim("audit_log"."target_id")) > 0),
	CONSTRAINT "audit_log_before_hash_format" CHECK ("audit_log"."before_hash" IS NULL OR "audit_log"."before_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_log_after_hash_format" CHECK ("audit_log"."after_hash" IS NULL OR "audit_log"."after_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "entity_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"market" varchar(16) NOT NULL,
	"role" "entity_role_type" NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "entity_role_identity_unique" UNIQUE NULLS NOT DISTINCT("entity_id","market","role","valid_from"),
	CONSTRAINT "entity_role_market_format" CHECK ("entity_role"."market" ~ '^[A-Z][A-Z0-9_-]{1,15}$'),
	CONSTRAINT "entity_role_validity_order" CHECK ("entity_role"."valid_from" IS NULL OR "entity_role"."valid_until" IS NULL OR "entity_role"."valid_until" >= "entity_role"."valid_from"),
	CONSTRAINT "entity_role_source_not_blank" CHECK (length(btrim("entity_role"."source")) > 0),
	CONSTRAINT "entity_role_version_positive" CHECK ("entity_role"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "legal_entity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"address" text NOT NULL,
	"country" varchar(2) NOT NULL,
	"type" "legal_entity_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "legal_entity_name_not_blank" CHECK (length(btrim("legal_entity"."name")) > 0),
	CONSTRAINT "legal_entity_address_not_blank" CHECK (length(btrim("legal_entity"."address")) > 0),
	CONSTRAINT "legal_entity_country_format" CHECK ("legal_entity"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "legal_entity_version_positive" CHECK ("legal_entity"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "role_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app_role" NOT NULL,
	"scope_type" "role_scope_type" NOT NULL,
	"scope_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "role_binding_identity_unique" UNIQUE NULLS NOT DISTINCT("user_id","role","scope_type","scope_id"),
	CONSTRAINT "role_binding_scope_consistent" CHECK (("role_binding"."scope_type" = 'project' AND "role_binding"."scope_id" IS NOT NULL) OR ("role_binding"."scope_type" IN ('global', 'own') AND "role_binding"."scope_id" IS NULL)),
	CONSTRAINT "role_binding_version_positive" CHECK ("role_binding"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "web_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"csrf_token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_session_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "web_session_token_hash_format" CHECK ("web_session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "web_session_csrf_hash_format" CHECK ("web_session"."csrf_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "web_session_expiry_order" CHECK ("web_session"."expires_at" > "web_session"."created_at"),
	CONSTRAINT "web_session_revocation_order" CHECK ("web_session"."revoked_at" IS NULL OR "web_session"."revoked_at" >= "web_session"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_role" ADD CONSTRAINT "entity_role_entity_id_legal_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_binding" ADD CONSTRAINT "role_binding_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_session" ADD CONSTRAINT "web_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_actor_time_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_time_idx" ON "audit_log" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "entity_role_entity_idx" ON "entity_role" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "legal_entity_name_idx" ON "legal_entity" USING btree ("name");--> statement-breakpoint
CREATE INDEX "role_binding_user_idx" ON "role_binding" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "web_session_user_idx" ON "web_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "web_session_expiry_idx" ON "web_session" USING btree ("expires_at");
--> statement-breakpoint

-- 使用语句级触发器连空表的变更也拒绝；TRUNCATE 不能绕过行级保护。
CREATE FUNCTION public.reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $audit_guard$
BEGIN
    RAISE EXCEPTION '审计记录只允许追加，不能更新、删除或清空。'
        USING ERRCODE = '42501';
END;
$audit_guard$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.audit_log
FOR EACH STATEMENT
EXECUTE FUNCTION public.reject_audit_log_mutation();
--> statement-breakpoint
ALTER TABLE public.audit_log ENABLE ALWAYS TRIGGER audit_log_append_only;
--> statement-breakpoint

-- 只读角色不配置登录凭据。语义查询仅授权业务表，不接触账号或会话秘密。
DO $reader_role$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cert_board_reader') THEN
        CREATE ROLE cert_board_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOREPLICATION NOBYPASSRLS NOINHERIT;
    END IF;
END;
$reader_role$;
--> statement-breakpoint
ALTER ROLE cert_board_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS NOINHERIT;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SCHEMA public FROM cert_board_reader;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO cert_board_reader;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM cert_board_reader;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM cert_board_reader;
--> statement-breakpoint
GRANT SELECT ON public.legal_entity, public.entity_role TO cert_board_reader;
