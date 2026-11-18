-- PR-16：审核内容固定；人的判断与决定绑定真实会话，均为追加记录。
CREATE TYPE "public"."review_card_type" AS ENUM('finalize');--> statement-breakpoint
CREATE TYPE "public"."review_decision_action" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."review_risk" AS ENUM('standard', 'high');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "review_card" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"workspace_version_id" uuid NOT NULL,
	"skill_id" varchar(64) NOT NULL,
	"skill_version" varchar(128) NOT NULL,
	"risk" "review_risk" NOT NULL,
	"card_type" "review_card_type" NOT NULL,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"structured_result" jsonb NOT NULL,
	"check_report" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_card_invocation_id_unique" UNIQUE("invocation_id"),
	CONSTRAINT "review_card_skill_not_blank" CHECK (length(btrim("review_card"."skill_id")) > 0 AND length(btrim("review_card"."skill_version")) > 0),
	CONSTRAINT "review_card_payload_shapes" CHECK (jsonb_typeof("review_card"."structured_result") = 'object' AND jsonb_typeof("review_card"."check_report") = 'object' AND jsonb_typeof("review_card"."diff") = 'object' AND jsonb_typeof("review_card"."evidence_refs") = 'array'),
	CONSTRAINT "review_card_hash_format" CHECK ("review_card"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_card_data_level_internal" CHECK ("review_card"."data_level" IN ('internal', 'confidential')),
	CONSTRAINT "review_card_version_positive" CHECK ("review_card"."version" > 0),
	CONSTRAINT "review_card_decided_time" CHECK ("review_card"."decided_at" IS NULL OR "review_card"."decided_at" >= "review_card"."created_at")
);
--> statement-breakpoint
CREATE TABLE "review_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"action" "review_decision_action" NOT NULL,
	"reason" text,
	"snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decision_actor_request_unique" UNIQUE("actor_user_id","request_key"),
	CONSTRAINT "review_decision_card_source_unique" UNIQUE("card_id","source_version"),
	CONSTRAINT "review_decision_version_positive" CHECK ("review_decision"."source_version" > 0),
	CONSTRAINT "review_decision_hash_format" CHECK ("review_decision"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_decision_reason_limit" CHECK ("review_decision"."reason" IS NULL OR (length(btrim("review_decision"."reason")) > 0 AND length("review_decision"."reason") <= 4000)),
	CONSTRAINT "review_decision_rejection_reason" CHECK ("review_decision"."action" <> 'rejected' OR "review_decision"."reason" IS NOT NULL),
	CONSTRAINT "review_decision_snapshot_required" CHECK (("review_decision"."action" = 'approved' AND "review_decision"."snapshot_id" IS NOT NULL) OR ("review_decision"."action" = 'rejected' AND "review_decision"."snapshot_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "review_judgment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"statement" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_judgment_actor_request_unique" UNIQUE("actor_user_id","request_key"),
	CONSTRAINT "review_judgment_actor_content_unique" UNIQUE("card_id","actor_user_id","content_hash"),
	CONSTRAINT "review_judgment_version_positive" CHECK ("review_judgment"."source_version" > 0),
	CONSTRAINT "review_judgment_hash_format" CHECK ("review_judgment"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_judgment_statement_limit" CHECK (length(btrim("review_judgment"."statement")) > 0 AND length("review_judgment"."statement") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "review_card" ADD CONSTRAINT "review_card_run_context_fk" FOREIGN KEY ("run_id","conversation_id","created_by","project_id","goal_id") REFERENCES "public"."run"("id","conversation_id","user_id","project_id","goal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_card" ADD CONSTRAINT "review_card_invocation_context_fk" FOREIGN KEY ("invocation_id","run_id","conversation_id","created_by") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_card" ADD CONSTRAINT "review_card_workspace_project_fk" FOREIGN KEY ("project_id","workspace_version_id") REFERENCES "public"."workspace_version"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_card_id_review_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."review_card"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_snapshot_id_submission_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."submission_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_browser_session_fk" FOREIGN KEY ("session_id","actor_user_id") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_judgment" ADD CONSTRAINT "review_judgment_card_id_review_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."review_card"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_judgment" ADD CONSTRAINT "review_judgment_browser_session_fk" FOREIGN KEY ("session_id","actor_user_id") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_card_project_status_idx" ON "review_card" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "review_card_project_decided_idx" ON "review_card" USING btree ("project_id","decided_at");
--> statement-breakpoint

CREATE FUNCTION public.guard_review_card_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_card_insert$
BEGIN
    IF NEW.status <> 'pending' OR NEW.version <> 1 OR NEW.decided_at IS NOT NULL THEN
        RAISE EXCEPTION '新审核卡必须等待浏览器中的人工决定。' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.tool_invocation i JOIN public.undo_record u ON u.invocation_id=i.id
       WHERE i.id=NEW.invocation_id AND i.tool_name='submit_for_review' AND i.effect='reversible_write'
       AND i.operation='execute' AND i.status='started' AND u.status='pending'
       AND u.target_type='review_card' AND u.target_id=NEW.id AND u.before_version IS NULL) THEN
        RAISE EXCEPTION '提交审核必须经过已登记的工具和预先保存的撤销凭据。' USING ERRCODE='42501';
    END IF;
    IF (NEW.check_report->>'passed') IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION '关键检查未通过，不能建立审核卡。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$review_card_insert$;
--> statement-breakpoint
CREATE TRIGGER review_card_insert_guard BEFORE INSERT ON public.review_card
FOR EACH ROW EXECUTE FUNCTION public.guard_review_card_insert();
--> statement-breakpoint
ALTER TABLE public.review_card ENABLE ALWAYS TRIGGER review_card_insert_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_review_card_content()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_card_content$
BEGIN
    IF ROW(NEW.id,NEW.project_id,NEW.goal_id,NEW.conversation_id,NEW.run_id,NEW.invocation_id,NEW.created_by,NEW.workspace_version_id,NEW.skill_id,NEW.skill_version,NEW.risk,NEW.card_type,NEW.structured_result,NEW.check_report,NEW.diff,NEW.evidence_refs,NEW.content_hash,NEW.data_level,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.goal_id,OLD.conversation_id,OLD.run_id,OLD.invocation_id,OLD.created_by,OLD.workspace_version_id,OLD.skill_id,OLD.skill_version,OLD.risk,OLD.card_type,OLD.structured_result,OLD.check_report,OLD.diff,OLD.evidence_refs,OLD.content_hash,OLD.data_level,OLD.created_at) THEN
        RAISE EXCEPTION '审核卡内容、来源与风险策略不能改写，请重新提交新卡片。' USING ERRCODE='42501';
    END IF;
    IF OLD.status <> 'pending' AND ROW(NEW.status,NEW.version,NEW.decided_at) IS DISTINCT FROM ROW(OLD.status,OLD.version,OLD.decided_at) THEN
        RAISE EXCEPTION '已决定或取消的卡片不能恢复为待审状态。' USING ERRCODE='42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.version <> OLD.version+1 THEN
        RAISE EXCEPTION '审核状态变化必须递增卡片版本。' USING ERRCODE='23514';
    END IF;
    IF NEW.status IN ('approved','rejected') AND NEW.decided_at IS NULL THEN
        RAISE EXCEPTION '人工决定必须记录决定时间。' USING ERRCODE='23514';
    END IF;
    IF NEW.status IN ('pending','cancelled') AND NEW.decided_at IS NOT NULL THEN
        RAISE EXCEPTION '未发生人工决定时不能填入决定时间。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$review_card_content$;
--> statement-breakpoint
CREATE TRIGGER review_card_content_immutable BEFORE UPDATE ON public.review_card
FOR EACH ROW EXECUTE FUNCTION public.guard_review_card_content();
--> statement-breakpoint
ALTER TABLE public.review_card ENABLE ALWAYS TRIGGER review_card_content_immutable;
--> statement-breakpoint

CREATE FUNCTION public.reject_review_card_removal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_card_removal$
BEGIN
    RAISE EXCEPTION '审核卡不能删除或清空；待审卡只能保留记录并取消。' USING ERRCODE='42501';
END;
$review_card_removal$;
--> statement-breakpoint
CREATE TRIGGER review_card_no_removal BEFORE DELETE OR TRUNCATE ON public.review_card
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_review_card_removal();
--> statement-breakpoint
ALTER TABLE public.review_card ENABLE ALWAYS TRIGGER review_card_no_removal;
--> statement-breakpoint

CREATE FUNCTION public.guard_review_judgment()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_judgment$
DECLARE card public.review_card%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
       WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_user_id AND s.revoked_at IS NULL
       AND s.expires_at>clock_timestamp() AND u.status='active') THEN
        RAISE EXCEPTION '独立判断需要有效的浏览器用户会话。' USING ERRCODE='42501';
    END IF;
    SELECT * INTO card FROM public.review_card WHERE id=NEW.card_id FOR SHARE;
    IF NOT FOUND OR card.version <> NEW.source_version OR card.content_hash <> NEW.content_hash THEN
        RAISE EXCEPTION '独立判断对应的卡片版本或内容已变化，请重新打开卡片。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$review_judgment$;
--> statement-breakpoint
CREATE TRIGGER review_judgment_insert_guard BEFORE INSERT ON public.review_judgment
FOR EACH ROW EXECUTE FUNCTION public.guard_review_judgment();
--> statement-breakpoint
ALTER TABLE public.review_judgment ENABLE ALWAYS TRIGGER review_judgment_insert_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_review_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_decision$
DECLARE card public.review_card%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
       WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_user_id AND s.revoked_at IS NULL
       AND s.expires_at>clock_timestamp() AND u.status='active') THEN
        RAISE EXCEPTION '审核决定需要有效的浏览器用户会话。' USING ERRCODE='42501';
    END IF;
    SELECT * INTO card FROM public.review_card WHERE id=NEW.card_id FOR SHARE;
    IF NOT FOUND OR card.content_hash <> NEW.content_hash OR NOT (
      (card.status='pending' AND card.version=NEW.source_version) OR
      (card.status::text=NEW.action::text AND card.version=NEW.source_version+1)) THEN
        RAISE EXCEPTION '审核决定引用的卡片版本、状态或内容不一致。' USING ERRCODE='23514';
    END IF;
    IF card.risk='high' AND NOT EXISTS(SELECT 1 FROM public.review_judgment j
       WHERE j.card_id=card.id AND j.actor_user_id=NEW.actor_user_id AND j.content_hash=card.content_hash) THEN
        RAISE EXCEPTION '高风险审核必须先提交本人的独立判断。' USING ERRCODE='42501';
    END IF;
    IF NEW.action='approved' AND NOT EXISTS(SELECT 1 FROM public.submission_snapshot s
       WHERE s.id=NEW.snapshot_id AND s.project_id=card.project_id AND s.workspace_version_id=card.workspace_version_id
       AND s.created_by=NEW.actor_user_id AND s.kind='approved_review') THEN
        RAISE EXCEPTION '冻结快照必须对应本卡片的项目、工作区版本和决定人。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$review_decision$;
--> statement-breakpoint
CREATE TRIGGER review_decision_insert_guard BEFORE INSERT ON public.review_decision
FOR EACH ROW EXECUTE FUNCTION public.guard_review_decision();
--> statement-breakpoint
ALTER TABLE public.review_decision ENABLE ALWAYS TRIGGER review_decision_insert_guard;
--> statement-breakpoint

CREATE FUNCTION public.reject_review_human_record_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_human_record$
BEGIN
    RAISE EXCEPTION '人的独立判断和审核决定只允许追加，不能改写、删除或清空。' USING ERRCODE='42501';
END;
$review_human_record$;
--> statement-breakpoint
CREATE TRIGGER review_judgment_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.review_judgment
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_review_human_record_mutation();
--> statement-breakpoint
ALTER TABLE public.review_judgment ENABLE ALWAYS TRIGGER review_judgment_append_only;
--> statement-breakpoint
CREATE TRIGGER review_decision_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.review_decision
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_review_human_record_mutation();
--> statement-breakpoint
ALTER TABLE public.review_decision ENABLE ALWAYS TRIGGER review_decision_append_only;
--> statement-breakpoint
-- 三张表均含私有审核内容，不授予 cert_board_reader 读取权限。
