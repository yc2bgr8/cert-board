CREATE TYPE "public"."skill_release_action" AS ENUM('publish', 'disable', 'rollback');--> statement-breakpoint
CREATE TABLE "skill" (
	"id" varchar(3) PRIMARY KEY NOT NULL,
	"agent_code" "agent_code" NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_id_format" CHECK ("skill"."id" ~ '^[A-Z][0-9]{2}$'),
	CONSTRAINT "skill_revision_nonnegative" CHECK ("skill"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "skill_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" varchar(3) NOT NULL,
	"revision" integer NOT NULL,
	"action" "skill_release_action" NOT NULL,
	"target_version_id" uuid NOT NULL,
	"active_version_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_release_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "skill_release_revision_unique" UNIQUE("skill_id","revision"),
	CONSTRAINT "skill_release_revision_positive" CHECK ("skill_release"."revision" > 0),
	CONSTRAINT "skill_release_fingerprint" CHECK ("skill_release"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_release_active" CHECK (CASE WHEN "skill_release"."action" = 'disable' THEN "skill_release"."active_version_id" IS NULL ELSE "skill_release"."active_version_id" IS NOT DISTINCT FROM "skill_release"."target_version_id" END)
);
--> statement-breakpoint
CREATE TABLE "skill_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" varchar(3) NOT NULL,
	"version" varchar(128) NOT NULL,
	"metadata" jsonb NOT NULL,
	"body" text NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_version_name_unique" UNIQUE("skill_id","version"),
	CONSTRAINT "skill_version_owner_unique" UNIQUE("skill_id","id"),
	CONSTRAINT "skill_version_hash" CHECK ("skill_version"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_version_body_length" CHECK (octet_length("skill_version"."body") BETWEEN 1 AND 32000),
	CONSTRAINT "skill_version_metadata_identity" CHECK (("skill_version"."metadata"->>'id') IS NOT DISTINCT FROM "skill_version"."skill_id" AND ("skill_version"."metadata"->>'version') IS NOT DISTINCT FROM "skill_version"."version")
);
--> statement-breakpoint
ALTER TABLE "skill_release" ADD CONSTRAINT "skill_release_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_release" ADD CONSTRAINT "skill_release_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_release" ADD CONSTRAINT "skill_release_target_fk" FOREIGN KEY ("skill_id","target_version_id") REFERENCES "public"."skill_version"("skill_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_release" ADD CONSTRAINT "skill_release_active_fk" FOREIGN KEY ("skill_id","active_version_id") REFERENCES "public"."skill_version"("skill_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version" ADD CONSTRAINT "skill_version_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION public.reject_skill_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '技能版本与人工发布记录只允许追加。' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER skill_version_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.skill_version
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_skill_history_mutation();
--> statement-breakpoint
ALTER TABLE public.skill_version ENABLE ALWAYS TRIGGER skill_version_append_only;
--> statement-breakpoint
CREATE TRIGGER skill_release_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.skill_release
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_skill_history_mutation();
--> statement-breakpoint
ALTER TABLE public.skill_release ENABLE ALWAYS TRIGGER skill_release_append_only;
