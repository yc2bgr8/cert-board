-- PR-09：仅本地测试渠道。提案正文固定，审批保留真实浏览器会话关联。
CREATE TYPE "public"."outbound_message_status" AS ENUM('queued', 'done', 'failed', 'reconcile', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."proposal_decision_action" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('proposed', 'approved', 'executing', 'done', 'failed', 'reconcile', 'rejected', 'expired');--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_id_project_unique" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_proposal_context_unique" UNIQUE("id","conversation_id","user_id","project_id","goal_id");--> statement-breakpoint
ALTER TABLE "web_session" ADD CONSTRAINT "web_session_actor_unique" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"action" "proposal_decision_action" NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_actor_request_unique" UNIQUE("actor_user_id","request_key"),
	CONSTRAINT "decision_proposal_source_unique" UNIQUE("proposal_id","source_version"),
	CONSTRAINT "decision_proposal_identity_unique" UNIQUE("id","proposal_id"),
	CONSTRAINT "decision_source_version_positive" CHECK ("decision"."source_version" > 0),
	CONSTRAINT "decision_content_hash_format" CHECK ("decision"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "outbound_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"approved_version" integer NOT NULL,
	"channel" "contact_channel" DEFAULT 'local_test' NOT NULL,
	"status" "outbound_message_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_reason" varchar(500),
	"receipt_id" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "outbound_message_decision_id_unique" UNIQUE("decision_id"),
	CONSTRAINT "outbound_message_approved_version_positive" CHECK ("outbound_message"."approved_version" > 0),
	CONSTRAINT "outbound_message_attempts_nonnegative" CHECK ("outbound_message"."attempts" >= 0),
	CONSTRAINT "outbound_message_version_positive" CHECK ("outbound_message"."version" > 0),
	CONSTRAINT "outbound_message_processed_time_order" CHECK ("outbound_message"."processed_at" IS NULL OR "outbound_message"."processed_at" >= "outbound_message"."created_at"),
	CONSTRAINT "outbound_message_receipt_complete" CHECK ("outbound_message"."receipt_id" IS NULL OR "outbound_message"."processed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"recipient_version" integer NOT NULL,
	"recipient_name" varchar(120) NOT NULL,
	"recipient_address" varchar(255) NOT NULL,
	"channel" "contact_channel" DEFAULT 'local_test' NOT NULL,
	"subject" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"status" "proposal_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "proposal_invocation_id_unique" UNIQUE("invocation_id"),
	CONSTRAINT "proposal_queue_context_unique" UNIQUE("id","project_id","goal_id","contact_id"),
	CONSTRAINT "proposal_recipient_version_positive" CHECK ("proposal"."recipient_version" > 0),
	CONSTRAINT "proposal_recipient_name_not_blank" CHECK (length(btrim("proposal"."recipient_name")) > 0),
	CONSTRAINT "proposal_recipient_address_not_blank" CHECK (length(btrim("proposal"."recipient_address")) > 0),
	CONSTRAINT "proposal_subject_not_blank" CHECK (length(btrim("proposal"."subject")) > 0 AND "proposal"."subject" !~ '[[:cntrl:]]'),
	CONSTRAINT "proposal_body_limit" CHECK (length(btrim("proposal"."body")) > 0 AND length("proposal"."body") <= 8000),
	CONSTRAINT "proposal_content_hash_format" CHECK ("proposal"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "proposal_data_level_internal" CHECK ("proposal"."data_level" IN ('internal', 'confidential')),
	CONSTRAINT "proposal_version_positive" CHECK ("proposal"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "goal" ADD COLUMN "outbound_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision" ADD CONSTRAINT "decision_browser_session_actor_fk" FOREIGN KEY ("session_id","actor_user_id") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_proposal_context_fk" FOREIGN KEY ("proposal_id","project_id","goal_id","contact_id") REFERENCES "public"."proposal"("id","project_id","goal_id","contact_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_decision_proposal_fk" FOREIGN KEY ("decision_id","proposal_id") REFERENCES "public"."decision"("id","proposal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_run_context_fk" FOREIGN KEY ("run_id","conversation_id","proposed_by","project_id","goal_id") REFERENCES "public"."run"("id","conversation_id","user_id","project_id","goal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_invocation_context_fk" FOREIGN KEY ("invocation_id","run_id","conversation_id","proposed_by") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_contact_project_fk" FOREIGN KEY ("contact_id","project_id") REFERENCES "public"."contact"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_proposal_idx" ON "decision" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "outbound_message_status_idx" ON "outbound_message" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbound_message_goal_idx" ON "outbound_message" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "proposal_project_status_idx" ON "proposal" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "proposal_goal_idx" ON "proposal" USING btree ("goal_id");--> statement-breakpoint

CREATE FUNCTION public.guard_proposal_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $proposal_insert$
DECLARE
    call_effect public.tool_effect;
    call_operation public.tool_invocation_operation;
    call_status public.tool_invocation_status;
    run_level public.document_data_level;
    conversation_level public.document_data_level;
    recipient public.contact%ROWTYPE;
BEGIN
    SELECT i.effect,i.operation,i.status,r.max_data_level,c.max_data_level
    INTO call_effect,call_operation,call_status,run_level,conversation_level
    FROM public.tool_invocation i JOIN public.run r ON r.id=i.run_id
    JOIN public.conversation c ON c.id=r.conversation_id WHERE i.id=NEW.invocation_id;
    IF NOT FOUND OR call_effect <> 'external' OR call_operation <> 'execute' OR call_status <> 'started' THEN
        RAISE EXCEPTION '提案只能由正在执行的已登记对外工具创建，不能用读取、撤销或旧调用绕过。' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'proposed' OR NEW.version <> 1 THEN
        RAISE EXCEPTION '新提案必须等待浏览器审核，不能直接标为已批准或已执行。' USING ERRCODE = '42501';
    END IF;
    IF NEW.data_level < run_level OR NEW.data_level < conversation_level THEN
        RAISE EXCEPTION '提案不能降低运行或对话已接触的资料级别。' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO recipient FROM public.contact WHERE id=NEW.contact_id AND project_id=NEW.project_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '联系人不属于当前项目，请先选择登记联系人。' USING ERRCODE = '23503';
    END IF;
    IF NOT recipient.active OR recipient.version <> NEW.recipient_version
       OR recipient.name <> NEW.recipient_name OR recipient.address <> NEW.recipient_address OR recipient.channel <> NEW.channel THEN
        RAISE EXCEPTION '联系人已停用或已改变，请重新核对后生成新提案。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$proposal_insert$;
--> statement-breakpoint
CREATE TRIGGER proposal_insert_guard BEFORE INSERT ON public.proposal
FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_insert();
--> statement-breakpoint
ALTER TABLE public.proposal ENABLE ALWAYS TRIGGER proposal_insert_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_proposal_content()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $proposal_content$
BEGIN
    IF ROW(NEW.project_id,NEW.goal_id,NEW.conversation_id,NEW.run_id,NEW.invocation_id,NEW.proposed_by,NEW.contact_id,NEW.recipient_version,NEW.recipient_name,NEW.recipient_address,NEW.channel,NEW.subject,NEW.body,NEW.content_hash,NEW.data_level,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.project_id,OLD.goal_id,OLD.conversation_id,OLD.run_id,OLD.invocation_id,OLD.proposed_by,OLD.contact_id,OLD.recipient_version,OLD.recipient_name,OLD.recipient_address,OLD.channel,OLD.subject,OLD.body,OLD.content_hash,OLD.data_level,OLD.created_at) THEN
        RAISE EXCEPTION '提案正文、收件人和来源创建后不能改写，请建立新提案重新审核。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$proposal_content$;
--> statement-breakpoint
CREATE TRIGGER proposal_content_immutable BEFORE UPDATE ON public.proposal
FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_content();
--> statement-breakpoint
ALTER TABLE public.proposal ENABLE ALWAYS TRIGGER proposal_content_immutable;
--> statement-breakpoint

CREATE FUNCTION public.guard_proposal_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $proposal_decision$
DECLARE
    target public.proposal%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
        WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_user_id AND s.revoked_at IS NULL
        AND s.expires_at>clock_timestamp() AND u.status='active') THEN
        RAISE EXCEPTION '审批需要仍有效的浏览器用户会话，请重新登录。' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO target FROM public.proposal WHERE id=NEW.proposal_id FOR SHARE;
    IF NOT FOUND OR NEW.content_hash <> target.content_hash THEN
        RAISE EXCEPTION '审批引用的内容不匹配，请重新打开审核卡。' USING ERRCODE = '23514';
    END IF;
    IF NOT ((target.status='proposed' AND target.version=NEW.source_version)
        OR (target.status::text=NEW.action::text AND target.version=NEW.source_version+1)) THEN
        RAISE EXCEPTION '审核卡版本或状态已变化，请刷新后重新判断。' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$proposal_decision$;
--> statement-breakpoint
CREATE TRIGGER decision_insert_guard BEFORE INSERT ON public.decision
FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_decision();
--> statement-breakpoint
ALTER TABLE public.decision ENABLE ALWAYS TRIGGER decision_insert_guard;
--> statement-breakpoint

CREATE FUNCTION public.reject_decision_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $decision_immutable$
BEGIN
    RAISE EXCEPTION '人工决定只允许追加，不能修改、删除或清空。' USING ERRCODE = '42501';
END;
$decision_immutable$;
--> statement-breakpoint
CREATE TRIGGER decision_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.decision
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_decision_mutation();
--> statement-breakpoint
ALTER TABLE public.decision ENABLE ALWAYS TRIGGER decision_append_only;
--> statement-breakpoint

CREATE FUNCTION public.guard_outbound_message()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $outbound_message$
DECLARE
    approved public.decision%ROWTYPE;
    target public.proposal%ROWTYPE;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.proposal_id,NEW.decision_id,NEW.goal_id,NEW.project_id,NEW.contact_id,NEW.approved_version,NEW.channel,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.proposal_id,OLD.decision_id,OLD.goal_id,OLD.project_id,OLD.contact_id,OLD.approved_version,OLD.channel,OLD.created_at) THEN
            RAISE EXCEPTION '队列的审批来源与收件人不能改写，请重新审批生成新队列项。' USING ERRCODE = '42501';
        END IF;
        IF OLD.status <> 'queued' AND ROW(NEW.status,NEW.attempts,NEW.receipt_id,NEW.processed_at)
           IS DISTINCT FROM ROW(OLD.status,OLD.attempts,OLD.receipt_id,OLD.processed_at) THEN
            RAISE EXCEPTION '已结束或待对账的队列不能自动重放，请先人工核对。' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO approved FROM public.decision WHERE id=NEW.decision_id;
    SELECT * INTO target FROM public.proposal WHERE id=NEW.proposal_id;
    IF approved.id IS NULL OR target.id IS NULL OR approved.action <> 'approved'
       OR approved.proposal_id <> NEW.proposal_id OR NEW.approved_version <> approved.source_version+1
       OR approved.content_hash <> target.content_hash OR target.status <> 'approved'
       OR target.version <> NEW.approved_version OR target.channel <> NEW.channel THEN
        RAISE EXCEPTION '队列必须引用当前提案的有效批准及对应版本，不能绕过浏览器审批。' USING ERRCODE = '42501';
    END IF;
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 OR NEW.receipt_id IS NOT NULL OR NEW.processed_at IS NOT NULL THEN
        RAISE EXCEPTION '新队列只能从待执行开始，不能伪造测试回执。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$outbound_message$;
--> statement-breakpoint
CREATE TRIGGER outbound_message_guard BEFORE INSERT OR UPDATE ON public.outbound_message
FOR EACH ROW EXECUTE FUNCTION public.guard_outbound_message();
--> statement-breakpoint
ALTER TABLE public.outbound_message ENABLE ALWAYS TRIGGER outbound_message_guard;
--> statement-breakpoint

-- 不授予 cert_board_reader 提案正文、审批会话或发送队列的访问权限。
