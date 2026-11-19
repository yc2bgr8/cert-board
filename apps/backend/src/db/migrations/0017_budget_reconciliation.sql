CREATE TABLE "budget_reconciliation" (
	"ledger_id" uuid PRIMARY KEY NOT NULL,
	"outcome" varchar(24) NOT NULL,
	"evidence" varchar(500) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_reconciliation_outcome_known" CHECK ("budget_reconciliation"."outcome" IN ('charged','not_sent','reserved_estimate')),
	CONSTRAINT "budget_reconciliation_evidence_present" CHECK (length(btrim("budget_reconciliation"."evidence")) > 0 AND "budget_reconciliation"."evidence" !~ '[[:cntrl:]]'),
	CONSTRAINT "budget_reconciliation_fingerprint_format" CHECK ("budget_reconciliation"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_state_consistent";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "settled_by_estimate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_reconciliation" ADD CONSTRAINT "budget_reconciliation_ledger_id_usage_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."usage_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_state_consistent" CHECK (("usage_ledger"."status" = 'reserved' AND NOT "usage_ledger"."settled_by_estimate" AND "usage_ledger"."actual_nano" IS NULL AND "usage_ledger"."settlement_fingerprint" IS NULL)
          OR ("usage_ledger"."status" = 'settled' AND "usage_ledger"."actual_nano" IS NOT NULL AND "usage_ledger"."settlement_fingerprint" IS NOT NULL
              AND ((NOT "usage_ledger"."settled_by_estimate" AND "usage_ledger"."input_tokens" IS NOT NULL AND "usage_ledger"."cache_read_tokens" IS NOT NULL AND "usage_ledger"."output_tokens" IS NOT NULL)
                   OR ("usage_ledger"."settled_by_estimate" AND "usage_ledger"."actual_nano" = "usage_ledger"."reserved_nano" AND "usage_ledger"."input_tokens" IS NULL AND "usage_ledger"."cache_read_tokens" IS NULL AND "usage_ledger"."output_tokens" IS NULL)))
          OR ("usage_ledger"."status" = 'unknown' AND NOT "usage_ledger"."settled_by_estimate" AND "usage_ledger"."reason_code" IS NOT NULL)
          OR ("usage_ledger"."status" = 'not_sent' AND NOT "usage_ledger"."settled_by_estimate" AND ("usage_ledger"."actual_nano" IS NULL OR "usage_ledger"."actual_nano" = 0)));
--> statement-breakpoint
CREATE TRIGGER budget_reconciliation_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.budget_reconciliation
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_audit_log_mutation();
--> statement-breakpoint
ALTER TABLE public.budget_reconciliation ENABLE ALWAYS TRIGGER budget_reconciliation_append_only;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.guard_usage_ledger()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $usage_ledger_guard$
DECLARE
    actual_project uuid;
    actual_goal uuid;
    policy_night varchar(80);
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.request_key,NEW.request_fingerprint,NEW.policy_id,NEW.run_id,NEW.conversation_id,
               NEW.user_id,NEW.project_id,NEW.goal_id,NEW.model_id,NEW.purpose,NEW.month_key,NEW.night_key,
               NEW.reserved_nano,NEW.estimated_input_tokens,NEW.max_output_tokens,NEW.price_snapshot,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id,OLD.request_key,OLD.request_fingerprint,OLD.policy_id,OLD.run_id,OLD.conversation_id,
               OLD.user_id,OLD.project_id,OLD.goal_id,OLD.model_id,OLD.purpose,OLD.month_key,OLD.night_key,
               OLD.reserved_nano,OLD.estimated_input_tokens,OLD.max_output_tokens,OLD.price_snapshot,OLD.created_at) THEN
            RAISE EXCEPTION '预占身份、价格与预算归属不能改写，不能借此重置已计费用。' USING ERRCODE='42501';
        END IF;
        IF OLD.status IN ('settled','not_sent') AND
           ROW(NEW.status,NEW.actual_nano,NEW.input_tokens,NEW.cache_read_tokens,NEW.output_tokens,
               NEW.settlement_fingerprint,NEW.reason_code,NEW.settled_by_estimate)
           IS DISTINCT FROM ROW(OLD.status,OLD.actual_nano,OLD.input_tokens,OLD.cache_read_tokens,OLD.output_tokens,
               OLD.settlement_fingerprint,OLD.reason_code,OLD.settled_by_estimate) THEN
            RAISE EXCEPTION '已结算记录不能覆盖，请保留原账目。' USING ERRCODE='42501';
        END IF;
        IF OLD.status='unknown' AND NEW.status NOT IN ('unknown','settled') AND NOT (
            NEW.status='not_sent' AND EXISTS (
                SELECT 1 FROM public.budget_reconciliation WHERE ledger_id=NEW.id AND outcome='not_sent'
            )
        ) THEN
            RAISE EXCEPTION '计量不完整的预占不能释放或重新发出，请先完成对账。' USING ERRCODE='42501';
        END IF;
        IF NEW.settled_by_estimate AND NOT OLD.settled_by_estimate AND NOT (
            OLD.status='unknown' AND EXISTS (
                SELECT 1 FROM public.budget_reconciliation WHERE ledger_id=NEW.id AND outcome='reserved_estimate'
            )
        ) THEN
            RAISE EXCEPTION '按预占计费需要已记录的核账依据。' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.settled_by_estimate THEN
        RAISE EXCEPTION '新用量记录不能直接以预占金额结算。' USING ERRCODE='42501';
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

-- 审计行先于账本更新写入，提交时必须与最终账目对应。
CREATE FUNCTION public.check_budget_reconciliation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $reconciliation_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.usage_ledger
        WHERE id=NEW.ledger_id AND (
            (NEW.outcome='not_sent' AND status='not_sent') OR
            (NEW.outcome='charged' AND status='settled' AND NOT settled_by_estimate) OR
            (NEW.outcome='reserved_estimate' AND status='settled' AND settled_by_estimate)
        )
    ) THEN
        RAISE EXCEPTION '核账依据必须与同一事务中的最终账目一致。' USING ERRCODE='23514';
    END IF;
    RETURN NULL;
END;
$reconciliation_check$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER budget_reconciliation_complete
AFTER INSERT ON public.budget_reconciliation
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_budget_reconciliation();
--> statement-breakpoint
ALTER TABLE public.budget_reconciliation ENABLE ALWAYS TRIGGER budget_reconciliation_complete;
