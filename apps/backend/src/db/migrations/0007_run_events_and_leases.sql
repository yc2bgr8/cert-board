-- PR-11：执行事件只含显式白名单元数据；请求正文放在独立可清理的私有表。
CREATE TYPE "public"."run_event_reason" AS ENUM('authorization_denied', 'validation_failed', 'version_conflict', 'budget_limit', 'metering_incomplete', 'provider_unavailable', 'timeout', 'cancelled', 'lease_expired', 'lease_replaced', 'internal_error');--> statement-breakpoint
CREATE TYPE "public"."run_event_type" AS ENUM('run_started', 'model_started', 'model_completed', 'tool_started', 'tool_completed', 'tool_failed', 'run_waiting', 'run_completed', 'run_failed', 'run_stopped', 'budget_stopped');--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD CONSTRAINT "tool_invocation_id_run_unique" UNIQUE("id","run_id");--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_request_run_unique" UNIQUE("request_key","run_id");--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_request_run_user_unique" UNIQUE("request_key","run_id","user_id");--> statement-breakpoint
CREATE TABLE "model_request_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"content_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_request_content_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "model_request_content_expiry_order" CHECK ("model_request_content"."expires_at" >= "model_request_content"."created_at")
);
--> statement-breakpoint
CREATE TABLE "run_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" "run_event_type" NOT NULL,
	"invocation_id" uuid,
	"request_id" uuid,
	"content_hash" varchar(64),
	"data_level" "document_data_level",
	"reason_code" "run_event_reason",
	"input_tokens" bigint,
	"output_tokens" bigint,
	"total_tokens" bigint,
	"cost_nano" bigint,
	"duration_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_event_sequence_unique" UNIQUE("run_id","seq"),
	CONSTRAINT "run_event_seq_positive" CHECK ("run_event"."seq" > 0 AND "run_event"."seq" <= 9007199254740991),
	CONSTRAINT "run_event_hash_format" CHECK ("run_event"."content_hash" IS NULL OR "run_event"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "run_event_input_tokens_safe" CHECK ("run_event"."input_tokens" IS NULL OR ("run_event"."input_tokens" >= 0 AND "run_event"."input_tokens" <= 9007199254740991)),
	CONSTRAINT "run_event_output_tokens_safe" CHECK ("run_event"."output_tokens" IS NULL OR ("run_event"."output_tokens" >= 0 AND "run_event"."output_tokens" <= 9007199254740991)),
	CONSTRAINT "run_event_total_tokens_safe" CHECK ("run_event"."total_tokens" IS NULL OR ("run_event"."total_tokens" >= 0 AND "run_event"."total_tokens" <= 9007199254740991)),
	CONSTRAINT "run_event_cost_safe" CHECK ("run_event"."cost_nano" IS NULL OR ("run_event"."cost_nano" >= 0 AND "run_event"."cost_nano" <= 999999999999999999)),
	CONSTRAINT "run_event_duration_safe" CHECK ("run_event"."duration_ms" IS NULL OR ("run_event"."duration_ms" >= 0 AND "run_event"."duration_ms" <= 9007199254740991))
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "lease_owner" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "lease_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "last_event_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_request_content" ADD CONSTRAINT "model_request_content_usage_owner_fk" FOREIGN KEY ("request_id","run_id","user_id") REFERENCES "public"."usage_ledger"("request_key","run_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_invocation_run_fk" FOREIGN KEY ("invocation_id","run_id") REFERENCES "public"."tool_invocation"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_request_run_fk" FOREIGN KEY ("request_id","run_id") REFERENCES "public"."usage_ledger"("request_key","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_request_content_expiry_idx" ON "model_request_content" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_lease_generation_safe" CHECK ("run"."lease_generation" >= 0 AND "run"."lease_generation" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_event_seq_safe" CHECK ("run"."last_event_seq" >= 0 AND "run"."last_event_seq" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_lease_complete" CHECK (("run"."lease_owner" IS NULL AND "run"."lease_expires_at" IS NULL) OR ("run"."lease_owner" IS NOT NULL AND "run"."lease_expires_at" IS NOT NULL AND "run"."lease_generation" > 0));
--> statement-breakpoint

CREATE FUNCTION public.guard_run_lease_sequence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $run_lease_sequence$
BEGIN
    IF NEW.lease_generation < OLD.lease_generation OR NEW.last_event_seq < OLD.last_event_seq THEN
        RAISE EXCEPTION '租约代数和事件序号不能回退。' USING ERRCODE='42501';
    END IF;
    IF NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       AND NEW.lease_generation <= OLD.lease_generation THEN
        RAISE EXCEPTION '领取新租约必须增加代数，不能复用旧执行权。' USING ERRCODE='42501';
    END IF;
    IF OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at > clock_timestamp()
       AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner <> OLD.lease_owner THEN
        RAISE EXCEPTION '当前租约尚有效，不能抢占其他执行者。' USING ERRCODE='42501';
    END IF;
    IF OLD.lease_owner IS NOT NULL AND NEW.lease_owner=OLD.lease_owner
       AND OLD.lease_expires_at <= clock_timestamp() AND NEW.lease_expires_at > OLD.lease_expires_at
       AND NEW.lease_generation <= OLD.lease_generation THEN
        RAISE EXCEPTION '过期租约不能直接续期，请重新领取并使用新代数。' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$run_lease_sequence$;
--> statement-breakpoint
CREATE TRIGGER run_lease_sequence_guard BEFORE UPDATE ON public.run
FOR EACH ROW EXECUTE FUNCTION public.guard_run_lease_sequence();
--> statement-breakpoint
ALTER TABLE public.run ENABLE ALWAYS TRIGGER run_lease_sequence_guard;
--> statement-breakpoint

CREATE FUNCTION public.reject_run_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $run_event_immutable$
BEGIN
    RAISE EXCEPTION '执行事件只允许追加，不能修改、删除或清空。' USING ERRCODE='42501';
END;
$run_event_immutable$;
--> statement-breakpoint
CREATE TRIGGER run_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.run_event
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_run_event_mutation();
--> statement-breakpoint
ALTER TABLE public.run_event ENABLE ALWAYS TRIGGER run_event_append_only;
--> statement-breakpoint

-- run_event 和 model_request_content 都按所属对话授权；不授予通用语义只读角色。
-- model_request_content 允许到期清理 DELETE，不能对它套用执行事件的不可删规则。
