CREATE TABLE "eval_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"review_id" uuid,
	"scheme_version" varchar(16) NOT NULL,
	"input_fingerprint" varchar(64) NOT NULL,
	"deterministic" jsonb NOT NULL,
	"semantic" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_report_input_unique" UNIQUE("run_id","scheme_version","input_fingerprint"),
	CONSTRAINT "eval_report_input_format" CHECK ("eval_report"."input_fingerprint" ~ '^[0-9a-f]{64}$' AND "eval_report"."scheme_version" ~ '^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$'),
	CONSTRAINT "eval_report_payload_shapes" CHECK (jsonb_typeof("eval_report"."deterministic")='object' AND jsonb_typeof("eval_report"."semantic")='object' AND jsonb_typeof("eval_report"."result")='object')
);
--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD COLUMN "evaluated_mode" "permission_mode";--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD COLUMN "requires_process_approval" boolean;--> statement-breakpoint
ALTER TABLE "review_card" ADD CONSTRAINT "review_card_id_run_unique" UNIQUE("id","run_id");--> statement-breakpoint
ALTER TABLE "eval_report" ADD CONSTRAINT "eval_report_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_report" ADD CONSTRAINT "eval_report_review_run_fk" FOREIGN KEY ("review_id","run_id") REFERENCES "public"."review_card"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_report_review_idx" ON "eval_report" USING btree ("review_id","created_at");--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD CONSTRAINT "tool_invocation_eval_policy_pair" CHECK (("tool_invocation"."evaluated_mode" IS NULL) = ("tool_invocation"."requires_process_approval" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_tool_invocation_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $invocation_identity$
BEGIN
    IF ROW(NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.call_id,NEW.tool_name,NEW.tool_version,NEW.arguments_hash,NEW.effect,NEW.operation,NEW.evaluated_mode,NEW.requires_process_approval,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.call_id,OLD.tool_name,OLD.tool_version,OLD.arguments_hash,OLD.effect,OLD.operation,OLD.evaluated_mode,OLD.requires_process_approval,OLD.created_at) THEN
        RAISE EXCEPTION '工具调用身份、参数摘要、权限模式及操作类型不能改写，请使用新调用编号。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$invocation_identity$;
--> statement-breakpoint
CREATE FUNCTION public.guard_eval_report_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $eval_report_identity$
DECLARE
    ranks text[] := ARRAY['not_evaluated','passed','needs_review','failed'];
    axes text[] := ARRAY['task_completion','answer_quality','evidence','tool_reliability','policy','efficiency','collaboration'];
    dimension text;
    review_status text;
    base_rank int;
    expected_rank int;
    proposed_rank int;
    expected_findings jsonb;
    base_overall int := 1;
    final_overall int := 1;
    critical_unmeasured boolean := false;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '评测结果必须保留。' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id,NEW.run_id,NEW.review_id,NEW.scheme_version,NEW.input_fingerprint,NEW.deterministic,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.review_id,OLD.scheme_version,OLD.input_fingerprint,OLD.deterministic,OLD.created_at)
           OR (OLD.semantic->>'status'='completed' AND ROW(NEW.semantic,NEW.result) IS DISTINCT FROM ROW(OLD.semantic,OLD.result))
           OR (NEW.semantic IS NOT DISTINCT FROM OLD.semantic AND NEW.result IS DISTINCT FROM OLD.result)
           OR (OLD.semantic->>'status'<>'not_evaluated' AND NEW.semantic->>'status'='not_evaluated') THEN
            RAISE EXCEPTION '已存档的评测身份、确定性结果和已完成的语义复核不能改写。' USING ERRCODE = '42501';
        END IF;
    END IF;
    review_status := NEW.semantic->>'status';
    IF review_status IS NULL OR review_status NOT IN ('not_evaluated','unavailable','completed') THEN
        RAISE EXCEPTION '语义复核状态无效。' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(NEW.deterministic->'dimensions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.result->'dimensions') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION '运行评测需要七项维度。' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.deterministic->'dimensions')) <> 7
       OR (SELECT count(*) FROM jsonb_object_keys(NEW.result->'dimensions')) <> 7 THEN
        RAISE EXCEPTION '运行评测需要七项维度。' USING ERRCODE = '42501';
    END IF;
    IF review_status = 'completed' THEN
        IF jsonb_typeof(NEW.semantic->'dimensions') IS DISTINCT FROM 'object'
           OR NEW.semantic->'dimensions' = '{}'::jsonb THEN
            RAISE EXCEPTION '语义结果缺少允许的维度。' USING ERRCODE = '42501';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_each_text(NEW.semantic->'dimensions') AS item(key,value)
                   WHERE key NOT IN ('answer_quality','evidence','collaboration') OR value IS NULL OR value NOT IN ('passed','needs_review','failed')) THEN
            RAISE EXCEPTION '语义结果含不支持的维度或状态。' USING ERRCODE = '42501';
        END IF;
    END IF;
    FOREACH dimension IN ARRAY axes LOOP
        base_rank := array_position(ranks, NEW.deterministic->'dimensions'->dimension->>'status');
        IF base_rank IS NULL THEN
            RAISE EXCEPTION '确定性维度状态无效。' USING ERRCODE = '42501';
        END IF;
        base_overall := greatest(base_overall, base_rank);
        expected_rank := base_rank;
        IF base_rank = 1 THEN
            critical_unmeasured := critical_unmeasured OR dimension IN ('task_completion','answer_quality','evidence','policy');
        ELSIF review_status = 'completed' THEN
            proposed_rank := array_position(ranks, NEW.semantic->'dimensions'->>dimension);
            expected_rank := greatest(base_rank, coalesce(proposed_rank, CASE WHEN dimension IN ('answer_quality','evidence') THEN 3 ELSE base_rank END));
        ELSIF dimension IN ('answer_quality','evidence') THEN
            expected_rank := greatest(base_rank, 3);
        END IF;
        expected_findings := NEW.deterministic->'dimensions'->dimension->'findings';
        IF expected_rank > base_rank THEN expected_findings := expected_findings || '["semantic_downgrade"]'::jsonb; END IF;
        IF jsonb_typeof(expected_findings) IS DISTINCT FROM 'array'
           OR (NEW.result->'dimensions'->dimension->>'status') IS DISTINCT FROM ranks[expected_rank]
           OR (NEW.result->'dimensions'->dimension->'findings') IS DISTINCT FROM expected_findings THEN
            RAISE EXCEPTION '最终维度必须符合确定性评分和语义降级规则。' USING ERRCODE = '42501';
        END IF;
        final_overall := greatest(final_overall, expected_rank);
    END LOOP;
    IF critical_unmeasured AND base_overall = 2 THEN base_overall := 3; END IF;
    IF critical_unmeasured AND final_overall = 2 THEN final_overall := 3; END IF;
    IF (NEW.deterministic->>'overall') IS DISTINCT FROM ranks[base_overall]
       OR (NEW.result->>'overall') IS DISTINCT FROM ranks[final_overall] THEN
        RAISE EXCEPTION '评测总结果与各维度不一致。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$eval_report_identity$;
--> statement-breakpoint
CREATE TRIGGER eval_report_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON public.eval_report
FOR EACH ROW EXECUTE FUNCTION public.guard_eval_report_identity();
--> statement-breakpoint
ALTER TABLE public.eval_report ENABLE ALWAYS TRIGGER eval_report_identity_guard;
