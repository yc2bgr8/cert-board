CREATE TYPE "public"."verification_channel" AS ENUM('cursor', 'gateway');--> statement-breakpoint
CREATE TYPE "public"."verification_post_kind" AS ENUM('host', 'human', 'model', 'system', 'summary');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('discussing', 'completed', 'paused');--> statement-breakpoint
CREATE TABLE "verification_post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" "verification_post_kind" NOT NULL,
	"author" varchar(120) NOT NULL,
	"user_id" uuid,
	"model" varchar(64),
	"channel" "verification_channel",
	"round" integer,
	"text" text NOT NULL,
	"mention" varchar(64),
	"compacts_through" integer,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archive_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_post_position_unique" UNIQUE("room_id","position"),
	CONSTRAINT "verification_post_position_positive" CHECK ("verification_post"."position">0),
	CONSTRAINT "verification_post_text_present" CHECK (length(btrim("verification_post"."text"))>0)
);
--> statement-breakpoint
CREATE TABLE "verification_preference" (
	"id" uuid PRIMARY KEY NOT NULL,
	"auto_rounds" integer DEFAULT 7 NOT NULL,
	"models" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_auto_rounds_range" CHECK ("verification_preference"."auto_rounds" BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "host_agent" "agent_code" DEFAULT 'registration' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "state" "verification_status" DEFAULT 'discussing' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "participants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "next_position" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "last_handled_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "human_joined" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "stopped_by" uuid;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "active_model" varchar(64);--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "leased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD COLUMN "conclusion" jsonb;--> statement-breakpoint
ALTER TABLE "external_model_exchange" ADD COLUMN "channel" "verification_channel" DEFAULT 'gateway' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_post" ADD CONSTRAINT "verification_post_room_id_external_model_conversation_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."external_model_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_post" ADD CONSTRAINT "verification_post_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_post" ADD CONSTRAINT "verification_post_archive_id_external_model_exchange_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."external_model_exchange"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD CONSTRAINT "external_model_conversation_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD CONSTRAINT "external_model_conversation_stopped_by_app_user_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_model_conversation_project_idx" ON "external_model_conversation" USING btree ("project_id","updated_at");
--> statement-breakpoint
CREATE TRIGGER verification_post_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.verification_post
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_audit_log_mutation();
--> statement-breakpoint
ALTER TABLE public.verification_post ENABLE ALWAYS TRIGGER verification_post_append_only;
--> statement-breakpoint
CREATE TRIGGER external_model_exchange_channel_immutable
BEFORE UPDATE OF channel ON public.external_model_exchange
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_audit_log_mutation();
--> statement-breakpoint
ALTER TABLE public.external_model_exchange ENABLE ALWAYS TRIGGER external_model_exchange_channel_immutable;
