CREATE TYPE "public"."external_model_exchange_status" AS ENUM('reserved', 'awaiting_receipt', 'settled', 'unknown', 'not_sent');--> statement-breakpoint
CREATE TABLE "external_model_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_model_conversation_title_present" CHECK (length(btrim("external_model_conversation"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "external_model_exchange" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"model" varchar(64) NOT NULL,
	"original_text" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"search" boolean NOT NULL,
	"sent" jsonb NOT NULL,
	"returned" jsonb,
	"answer" text,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replacement_count" integer NOT NULL,
	"month_key" varchar(7) NOT NULL,
	"status" "external_model_exchange_status" DEFAULT 'reserved' NOT NULL,
	"reserved_nano" bigint NOT NULL,
	"actual_nano" bigint,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_model_exchange_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "external_model_exchange_fingerprint" CHECK ("external_model_exchange"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "external_model_exchange_month" CHECK ("external_model_exchange"."month_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "external_model_exchange_amounts" CHECK ("external_model_exchange"."reserved_nano" >= 0 AND "external_model_exchange"."replacement_count" >= 0
      AND ("external_model_exchange"."actual_nano" IS NULL OR "external_model_exchange"."actual_nano" >= 0)),
	CONSTRAINT "external_model_exchange_state" CHECK (
      ("external_model_exchange"."status"='settled' AND "external_model_exchange"."actual_nano" IS NOT NULL AND ("external_model_exchange"."answer" IS NULL OR "external_model_exchange"."returned" IS NOT NULL))
      OR ("external_model_exchange"."status" IN ('reserved','unknown','awaiting_receipt') AND "external_model_exchange"."actual_nano" IS NULL AND "external_model_exchange"."answer" IS NULL
          AND ("external_model_exchange"."status"<>'awaiting_receipt' OR ("external_model_exchange"."dispatched_at" IS NOT NULL AND "external_model_exchange"."returned" IS NULL)))
      OR ("external_model_exchange"."status"='not_sent' AND "external_model_exchange"."actual_nano" IS NOT NULL AND "external_model_exchange"."actual_nano"=0 AND "external_model_exchange"."answer" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "external_model_word" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phrase" varchar(120) NOT NULL,
	"normalized" varchar(240) NOT NULL,
	"category" varchar(24) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_model_word_normalized_unique" UNIQUE("normalized"),
	CONSTRAINT "external_model_word_phrase_present" CHECK (length(btrim("external_model_word"."phrase")) > 0),
	CONSTRAINT "external_model_word_category_known" CHECK ("external_model_word"."category" IN ('customer','product','price','contract','other'))
);
--> statement-breakpoint
ALTER TABLE "external_model_conversation" ADD CONSTRAINT "external_model_conversation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_model_exchange" ADD CONSTRAINT "external_model_exchange_conversation_id_external_model_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."external_model_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_model_word" ADD CONSTRAINT "external_model_word_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_model_conversation_owner_idx" ON "external_model_conversation" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "external_model_exchange_conversation_idx" ON "external_model_exchange" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "external_model_exchange_month_idx" ON "external_model_exchange" USING btree ("month_key");
--> statement-breakpoint
CREATE FUNCTION public.guard_external_model_exchange()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $external_exchange_guard$
BEGIN
    IF (OLD.status<>'reserved' AND NOT (OLD.status='awaiting_receipt' AND NEW.status IN ('settled','unknown'))) OR
       ROW(NEW.id,NEW.conversation_id,NEW.request_key,NEW.request_fingerprint,NEW.model,
           NEW.original_text,NEW.attachments,NEW.search,NEW.sent,NEW.replacement_count,NEW.month_key,
           NEW.reserved_nano,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id,OLD.conversation_id,OLD.request_key,OLD.request_fingerprint,OLD.model,
           OLD.original_text,OLD.attachments,OLD.search,OLD.sent,OLD.replacement_count,OLD.month_key,
           OLD.reserved_nano,OLD.created_at) OR
       (NEW.status='reserved' AND (OLD.dispatched_at IS NOT NULL OR NEW.dispatched_at IS NULL OR
           NEW.returned IS DISTINCT FROM OLD.returned OR NEW."references" IS DISTINCT FROM OLD."references")) OR
       (NEW.status<>'reserved' AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
    THEN
        RAISE EXCEPTION '外部请求存档与已结算记录不可改写。' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$external_exchange_guard$;
--> statement-breakpoint
CREATE TRIGGER external_model_exchange_immutable
BEFORE UPDATE ON public.external_model_exchange
FOR EACH ROW EXECUTE FUNCTION public.guard_external_model_exchange();
--> statement-breakpoint
ALTER TABLE public.external_model_exchange ENABLE ALWAYS TRIGGER external_model_exchange_immutable;
--> statement-breakpoint
CREATE TRIGGER external_model_exchange_no_deletion
BEFORE DELETE OR TRUNCATE ON public.external_model_exchange
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_audit_log_mutation();
--> statement-breakpoint
ALTER TABLE public.external_model_exchange ENABLE ALWAYS TRIGGER external_model_exchange_no_deletion;
