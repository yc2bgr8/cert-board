CREATE TYPE "public"."run_continuation_state" AS ENUM('pending', 'queued', 'claimed', 'tool_recorded', 'model_started', 'completed', 'blocked');--> statement-breakpoint
ALTER TYPE "public"."conversation_event_type" ADD VALUE 'approval_requested';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_type" ADD VALUE 'approval_resolved';--> statement-breakpoint
CREATE TABLE "run_continuation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "run_continuation_state" DEFAULT 'pending' NOT NULL,
	"claimed_generation" bigint,
	"reason_code" varchar(80),
	"tool_recorded_at" timestamp with time zone,
	"model_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "run_continuation_approval_id_unique" UNIQUE("approval_id"),
	CONSTRAINT "run_continuation_decision_id_unique" UNIQUE("decision_id"),
	CONSTRAINT "run_continuation_invocation_id_unique" UNIQUE("invocation_id"),
	CONSTRAINT "run_continuation_version_positive" CHECK ("run_continuation"."version">0),
	CONSTRAINT "run_continuation_generation_safe" CHECK ("run_continuation"."claimed_generation" IS NULL OR ("run_continuation"."claimed_generation">0 AND "run_continuation"."claimed_generation"<=9007199254740991)),
	CONSTRAINT "run_continuation_reason_code" CHECK ("run_continuation"."reason_code" IS NULL OR "run_continuation"."reason_code" ~ '^[A-Z][A-Z0-9_]{1,79}$')
);
--> statement-breakpoint
ALTER TABLE "run_continuation" ADD CONSTRAINT "run_continuation_approval_id_tool_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."tool_approval"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_continuation" ADD CONSTRAINT "run_continuation_decision_id_tool_approval_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."tool_approval_decision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_continuation" ADD CONSTRAINT "run_continuation_invocation_owner_fk" FOREIGN KEY ("invocation_id","run_id","conversation_id","user_id") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_continuation" ADD CONSTRAINT "run_continuation_run_owner_fk" FOREIGN KEY ("run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_continuation_run_state_idx" ON "run_continuation" USING btree ("run_id","state");
--> statement-breakpoint
-- 继续票据只引用既有浏览器决定，不复制或改写批准内容、工具参数和对话历史。
CREATE FUNCTION public.guard_run_continuation_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.state<>'pending' OR NEW.version<>1 OR NEW.claimed_generation IS NOT NULL OR NEW.reason_code IS NOT NULL
    OR NEW.tool_recorded_at IS NOT NULL OR NEW.model_started_at IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
    RAISE EXCEPTION '新继续票据必须等待原运行释放执行权。' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tool_approval a JOIN public.tool_approval_decision d ON d.approval_id=a.id
    JOIN public.tool_invocation i ON i.id=a.invocation_id
    WHERE a.id=NEW.approval_id AND d.id=NEW.decision_id AND d.actor_user_id=a.user_id
      AND d.content_hash=a.content_hash AND d.source_version+1=a.version
      AND ((d.action='reject' AND a.status='rejected') OR (d.action IN ('allow_once','allow_conversation') AND a.status='approved'))
      AND a.invocation_id=NEW.invocation_id AND a.run_id=NEW.run_id AND a.conversation_id=NEW.conversation_id AND a.user_id=NEW.user_id
      AND i.status='pending_approval' AND i.operation='execute' AND i.effect='reversible_write') THEN
    RAISE EXCEPTION '继续票据必须绑定本人已决定的原始待批准工具调用。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER run_continuation_insert_guard BEFORE INSERT ON public.run_continuation FOR EACH ROW EXECUTE FUNCTION public.guard_run_continuation_insert();
--> statement-breakpoint
ALTER TABLE public.run_continuation ENABLE ALWAYS TRIGGER run_continuation_insert_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_run_continuation_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.id,NEW.approval_id,NEW.decision_id,NEW.invocation_id,NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.approval_id,OLD.decision_id,OLD.invocation_id,OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.created_at) THEN
    RAISE EXCEPTION '继续票据不能改换原决定、调用或归属。' USING ERRCODE='42501';
  END IF;
  IF NEW.state=OLD.state THEN
    IF ROW(NEW.version,NEW.claimed_generation,NEW.reason_code,NEW.tool_recorded_at,NEW.model_started_at,NEW.finished_at)
      IS DISTINCT FROM ROW(OLD.version,OLD.claimed_generation,OLD.reason_code,OLD.tool_recorded_at,OLD.model_started_at,OLD.finished_at) THEN
      RAISE EXCEPTION '继续票据的控制字段只能随合法状态转移更新。' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state='pending' AND NEW.state IN ('queued','blocked'))
    OR (OLD.state='queued' AND NEW.state IN ('claimed','blocked'))
    OR (OLD.state='claimed' AND NEW.state IN ('tool_recorded','blocked'))
    OR (OLD.state='tool_recorded' AND NEW.state IN ('model_started','completed','blocked'))
    OR (OLD.state='model_started' AND NEW.state IN ('completed','blocked')))
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION '继续票据状态不能回退、重试或跳过执行阶段。' USING ERRCODE='42501';
  END IF;
  IF OLD.claimed_generation IS NOT NULL AND NEW.claimed_generation IS DISTINCT FROM OLD.claimed_generation THEN
    RAISE EXCEPTION '已领取的继续票据不能改换执行代次。' USING ERRCODE='42501';
  END IF;
  IF NEW.state='queued' AND (NEW.claimed_generation IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM public.run r WHERE r.id=NEW.run_id AND r.status='queued' AND r.lease_owner IS NULL AND r.lease_expires_at IS NULL)) THEN
    RAISE EXCEPTION '继续投递必须先准备无占用执行权的原运行。' USING ERRCODE='42501';
  END IF;
  IF NEW.state IN ('claimed','tool_recorded','model_started') AND NOT EXISTS(
    SELECT 1 FROM public.run r WHERE r.id=NEW.run_id AND r.status='running'
      AND r.lease_generation=NEW.claimed_generation AND r.lease_owner IS NOT NULL AND r.lease_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION '继续票据需要同一运行的当前有效执行权。' USING ERRCODE='42501';
  END IF;
  IF NEW.state='tool_recorded' AND (NEW.tool_recorded_at IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.tool_invocation i JOIN public.conversation_tool_result p ON p.invocation_id=i.id
    WHERE i.id=NEW.invocation_id AND i.status IN ('completed','denied') AND p.conversation_id=NEW.conversation_id AND p.user_id=NEW.user_id)) THEN
    RAISE EXCEPTION '继续之前必须原子保存原调用的真实回执。' USING ERRCODE='23514';
  END IF;
  IF NEW.state IN ('queued','claimed') AND (NEW.tool_recorded_at IS NOT NULL OR NEW.model_started_at IS NOT NULL) THEN
    RAISE EXCEPTION '尚未执行的继续票据不能填写后续阶段时间。' USING ERRCODE='23514';
  END IF;
  IF (NEW.state='model_started' AND NEW.model_started_at IS NULL)
    OR (NEW.state IN ('completed','blocked'))<>(NEW.finished_at IS NOT NULL)
    OR (NEW.state='blocked')<>(NEW.reason_code IS NOT NULL)
    OR (OLD.tool_recorded_at IS NOT NULL AND NEW.tool_recorded_at IS DISTINCT FROM OLD.tool_recorded_at)
    OR (OLD.model_started_at IS NOT NULL AND NEW.model_started_at IS DISTINCT FROM OLD.model_started_at) THEN
    RAISE EXCEPTION '继续票据的阶段时间和终态原因不一致。' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER run_continuation_update_guard BEFORE UPDATE ON public.run_continuation FOR EACH ROW EXECUTE FUNCTION public.guard_run_continuation_update();
--> statement-breakpoint
ALTER TABLE public.run_continuation ENABLE ALWAYS TRIGGER run_continuation_update_guard;
--> statement-breakpoint
CREATE TRIGGER run_continuation_no_removal BEFORE DELETE OR TRUNCATE ON public.run_continuation FOR EACH STATEMENT EXECUTE FUNCTION public.reject_permission_record_removal();
--> statement-breakpoint
ALTER TABLE public.run_continuation ENABLE ALWAYS TRIGGER run_continuation_no_removal;
--> statement-breakpoint
-- 私有继续状态与工具参数无关，不授予cert_board_reader。
