-- PR-10：金额均为整数 nanoUSD。这里只建表，不为生产或开发自动启用运营额度。
CREATE TYPE "public"."budget_environment" AS ENUM('development', 'test', 'production');--> statement-breakpoint
CREATE TYPE "public"."budget_incomplete_reason" AS ENUM('missing_usage', 'missing_price', 'request_uncertain', 'reservation_exceeded', 'timeout', 'aborted', 'provider_error', 'manual_stop');--> statement-breakpoint
CREATE TYPE "public"."usage_ledger_status" AS ENUM('reserved', 'settled', 'unknown', 'not_sent');--> statement-breakpoint
CREATE TABLE "budget_policy" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"environment" "budget_environment" NOT NULL,
	"night_key" varchar(80) NOT NULL,
	"run_limit_nano" bigint NOT NULL,
	"month_limit_nano" bigint NOT NULL,
	"night_limit_nano" bigint NOT NULL,
	"max_steps" bigint NOT NULL,
	"max_tokens" bigint NOT NULL,
	"alert_percent" integer NOT NULL,
	"blocked_reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "budget_policy_singleton" CHECK ("budget_policy"."id" = 'default'),
	CONSTRAINT "budget_policy_night_key_format" CHECK ("budget_policy"."night_key" ~ '^[A-Za-z0-9_-]{1,80}$'),
	CONSTRAINT "budget_policy_run_limit_positive" CHECK ("budget_policy"."run_limit_nano" > 0 AND "budget_policy"."run_limit_nano" <= 999999999999999999),
	CONSTRAINT "budget_policy_month_limit_positive" CHECK ("budget_policy"."month_limit_nano" > 0 AND "budget_policy"."month_limit_nano" <= 999999999999999999),
	CONSTRAINT "budget_policy_night_limit_positive" CHECK ("budget_policy"."night_limit_nano" > 0 AND "budget_policy"."night_limit_nano" <= 999999999999999999),
	CONSTRAINT "budget_policy_step_limit_safe" CHECK ("budget_policy"."max_steps" > 0 AND "budget_policy"."max_steps" <= 9007199254740991),
	CONSTRAINT "budget_policy_token_limit_safe" CHECK ("budget_policy"."max_tokens" > 0 AND "budget_policy"."max_tokens" <= 9007199254740991),
	CONSTRAINT "budget_policy_alert_range" CHECK ("budget_policy"."alert_percent" >= 1 AND "budget_policy"."alert_percent" <= 100),
	CONSTRAINT "budget_policy_version_positive" CHECK ("budget_policy"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" uuid NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"settlement_fingerprint" varchar(64),
	"policy_id" varchar(32) NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"model_id" varchar(200) NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"month_key" varchar(7) NOT NULL,
	"night_key" varchar(80) NOT NULL,
	"status" "usage_ledger_status" DEFAULT 'reserved' NOT NULL,
	"reserved_nano" bigint NOT NULL,
	"actual_nano" bigint,
	"estimated_input_tokens" bigint NOT NULL,
	"max_output_tokens" bigint NOT NULL,
	"input_tokens" bigint,
	"cache_read_tokens" bigint,
	"output_tokens" bigint,
	"price_snapshot" jsonb NOT NULL,
	"reason_code" "budget_incomplete_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "usage_ledger_request_fingerprint_format" CHECK ("usage_ledger"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "usage_ledger_settlement_fingerprint_format" CHECK ("usage_ledger"."settlement_fingerprint" IS NULL OR "usage_ledger"."settlement_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "usage_ledger_model_id_format" CHECK ("usage_ledger"."model_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
	CONSTRAINT "usage_ledger_purpose_format" CHECK ("usage_ledger"."purpose" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "usage_ledger_month_key_format" CHECK ("usage_ledger"."month_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "usage_ledger_night_key_format" CHECK ("usage_ledger"."night_key" ~ '^[A-Za-z0-9_-]{1,80}$'),
	CONSTRAINT "usage_ledger_reserved_nano_safe" CHECK ("usage_ledger"."reserved_nano" >= 0 AND "usage_ledger"."reserved_nano" <= 999999999999999999),
	CONSTRAINT "usage_ledger_actual_nano_safe" CHECK ("usage_ledger"."actual_nano" IS NULL OR ("usage_ledger"."actual_nano" >= 0 AND "usage_ledger"."actual_nano" <= 999999999999999999)),
	CONSTRAINT "usage_ledger_estimated_tokens_safe" CHECK ("usage_ledger"."estimated_input_tokens" >= 0 AND "usage_ledger"."estimated_input_tokens" <= 9007199254740991 AND "usage_ledger"."max_output_tokens" >= 0 AND "usage_ledger"."max_output_tokens" <= 9007199254740991),
	CONSTRAINT "usage_ledger_input_tokens_safe" CHECK ("usage_ledger"."input_tokens" IS NULL OR ("usage_ledger"."input_tokens" >= 0 AND "usage_ledger"."input_tokens" <= 9007199254740991)),
	CONSTRAINT "usage_ledger_output_tokens_safe" CHECK ("usage_ledger"."output_tokens" IS NULL OR ("usage_ledger"."output_tokens" >= 0 AND "usage_ledger"."output_tokens" <= 9007199254740991)),
	CONSTRAINT "usage_ledger_cache_tokens_safe" CHECK ("usage_ledger"."cache_read_tokens" IS NULL OR ("usage_ledger"."cache_read_tokens" >= 0 AND "usage_ledger"."cache_read_tokens" <= 9007199254740991 AND ("usage_ledger"."input_tokens" IS NULL OR "usage_ledger"."cache_read_tokens" <= "usage_ledger"."input_tokens"))),
	CONSTRAINT "usage_ledger_price_snapshot_object" CHECK (jsonb_typeof("usage_ledger"."price_snapshot") = 'object'),
	CONSTRAINT "usage_ledger_state_consistent" CHECK (("usage_ledger"."status" = 'reserved' AND "usage_ledger"."actual_nano" IS NULL AND "usage_ledger"."settlement_fingerprint" IS NULL) OR ("usage_ledger"."status" = 'settled' AND "usage_ledger"."actual_nano" IS NOT NULL AND "usage_ledger"."settlement_fingerprint" IS NOT NULL AND "usage_ledger"."input_tokens" IS NOT NULL AND "usage_ledger"."cache_read_tokens" IS NOT NULL AND "usage_ledger"."output_tokens" IS NOT NULL) OR ("usage_ledger"."status" = 'unknown' AND "usage_ledger"."reason_code" IS NOT NULL) OR ("usage_ledger"."status" = 'not_sent' AND ("usage_ledger"."actual_nano" IS NULL OR "usage_ledger"."actual_nano" = 0)))
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "budget_steps" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "budget_total_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "budget_cost_nano" bigint;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "budget_stop_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_policy_id_budget_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policy"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_owner_fk" FOREIGN KEY ("run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_run_context_fk" FOREIGN KEY ("run_id","conversation_id","user_id","project_id","goal_id") REFERENCES "public"."run"("id","conversation_id","user_id","project_id","goal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_ledger_run_idx" ON "usage_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_goal_idx" ON "usage_ledger" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_month_idx" ON "usage_ledger" USING btree ("policy_id","month_key");--> statement-breakpoint
CREATE INDEX "usage_ledger_night_idx" ON "usage_ledger" USING btree ("policy_id","night_key");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_budget_steps_safe" CHECK ("run"."budget_steps" >= 0 AND "run"."budget_steps" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_budget_tokens_safe" CHECK ("run"."budget_total_tokens" >= 0 AND "run"."budget_total_tokens" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_budget_cost_safe" CHECK ("run"."budget_cost_nano" IS NULL OR ("run"."budget_cost_nano" >= 0 AND "run"."budget_cost_nano" <= 999999999999999999));
--> statement-breakpoint

CREATE FUNCTION public.guard_budget_policy_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $budget_policy_identity$
BEGIN
    IF ROW(NEW.id,NEW.environment,NEW.night_key,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.environment,OLD.night_key,OLD.created_at) THEN
        RAISE EXCEPTION '预算政策的环境与本次开发标识不能通过改名重置，请另行审核预算变更。' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$budget_policy_identity$;
--> statement-breakpoint
CREATE TRIGGER budget_policy_identity_guard BEFORE UPDATE ON public.budget_policy
FOR EACH ROW EXECUTE FUNCTION public.guard_budget_policy_identity();
--> statement-breakpoint
ALTER TABLE public.budget_policy ENABLE ALWAYS TRIGGER budget_policy_identity_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_usage_ledger()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $usage_ledger_guard$
DECLARE
    actual_project uuid;
    actual_goal uuid;
    policy_night varchar(80);
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.request_key,NEW.request_fingerprint,NEW.policy_id,NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.project_id,NEW.goal_id,NEW.model_id,NEW.purpose,NEW.month_key,NEW.night_key,NEW.reserved_nano,NEW.estimated_input_tokens,NEW.max_output_tokens,NEW.price_snapshot,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id,OLD.request_key,OLD.request_fingerprint,OLD.policy_id,OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.project_id,OLD.goal_id,OLD.model_id,OLD.purpose,OLD.month_key,OLD.night_key,OLD.reserved_nano,OLD.estimated_input_tokens,OLD.max_output_tokens,OLD.price_snapshot,OLD.created_at) THEN
            RAISE EXCEPTION '预占身份、价格与预算归属不能改写，不能借此重置已计费用。' USING ERRCODE='42501';
        END IF;
        IF OLD.status IN ('settled','not_sent') AND ROW(NEW.status,NEW.actual_nano,NEW.input_tokens,NEW.cache_read_tokens,NEW.output_tokens,NEW.settlement_fingerprint,NEW.reason_code)
           IS DISTINCT FROM ROW(OLD.status,OLD.actual_nano,OLD.input_tokens,OLD.cache_read_tokens,OLD.output_tokens,OLD.settlement_fingerprint,OLD.reason_code) THEN
            RAISE EXCEPTION '已结算记录不能覆盖，请保留原账目。' USING ERRCODE='42501';
        END IF;
        IF OLD.status='unknown' AND NEW.status NOT IN ('unknown','settled') THEN
            RAISE EXCEPTION '计量不完整的预占不能释放或重新发出，请先完成对账。' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
    END IF;
    SELECT project_id,goal_id INTO actual_project,actual_goal FROM public.run
    WHERE id=NEW.run_id AND conversation_id=NEW.conversation_id AND user_id=NEW.user_id;
    IF NOT FOUND OR actual_project IS DISTINCT FROM NEW.project_id OR actual_goal IS DISTINCT FROM NEW.goal_id THEN
        RAISE EXCEPTION '计量请求与运行的身份或目标不一致。' USING ERRCODE='23503';
    END IF;
    SELECT night_key INTO policy_night FROM public.budget_policy WHERE id=NEW.policy_id;
    IF NOT FOUND OR policy_night <> NEW.night_key THEN
        RAISE EXCEPTION '计量请求必须使用已配置的本次开发预算标识。' USING ERRCODE='23514';
    END IF;
    IF NEW.month_key <> to_char(NEW.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') THEN
        RAISE EXCEPTION '预算月份必须按计量时间的北京时间月份确定。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$usage_ledger_guard$;
--> statement-breakpoint
CREATE TRIGGER usage_ledger_guard BEFORE INSERT OR UPDATE ON public.usage_ledger
FOR EACH ROW EXECUTE FUNCTION public.guard_usage_ledger();
--> statement-breakpoint
ALTER TABLE public.usage_ledger ENABLE ALWAYS TRIGGER usage_ledger_guard;
--> statement-breakpoint

CREATE FUNCTION public.reject_budget_record_deletion()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $budget_no_deletion$
BEGIN
    RAISE EXCEPTION '预算政策与用量记录不能删除或清空，不能据此恢复已使用额度。' USING ERRCODE='42501';
END;
$budget_no_deletion$;
--> statement-breakpoint
CREATE TRIGGER usage_ledger_no_deletion BEFORE DELETE OR TRUNCATE ON public.usage_ledger
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_budget_record_deletion();
--> statement-breakpoint
ALTER TABLE public.usage_ledger ENABLE ALWAYS TRIGGER usage_ledger_no_deletion;
--> statement-breakpoint
CREATE TRIGGER budget_policy_no_deletion BEFORE DELETE OR TRUNCATE ON public.budget_policy
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_budget_record_deletion();
--> statement-breakpoint
ALTER TABLE public.budget_policy ENABLE ALWAYS TRIGGER budget_policy_no_deletion;
--> statement-breakpoint
-- 不对通用语义只读角色开放预算政策和个人运行用量。
