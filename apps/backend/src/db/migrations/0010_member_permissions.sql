CREATE TYPE "public"."agent_code" AS ENUM('registration', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."permission_mode" AS ENUM('read_only', 'ask', 'full');--> statement-breakpoint
CREATE TYPE "public"."tool_approval_action" AS ENUM('allow_once', 'allow_conversation', 'reject');--> statement-breakpoint
CREATE TYPE "public"."tool_approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."tool_invocation_status" ADD VALUE 'pending_approval';--> statement-breakpoint
CREATE TABLE "conversation_tool_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_name" varchar(64) NOT NULL,
	"tool_version" varchar(128) NOT NULL,
	"source_decision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "conversation_tool_grant_scope_unique" UNIQUE("conversation_id","user_id","tool_name","tool_version")
);
--> statement-breakpoint
CREATE TABLE "internal_outbound_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"direction_version" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"recipient_version" integer NOT NULL,
	"recipient_user_version" integer NOT NULL,
	"recipient_name" varchar(120) NOT NULL,
	"recipient_address" varchar(255) NOT NULL,
	"channel" "contact_channel" DEFAULT 'local_test' NOT NULL,
	"subject" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"business_date" date DEFAULT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date NOT NULL,
	"status" "outbound_message_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_reason" varchar(500),
	"receipt_id" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "internal_outbound_message_invocation_id_unique" UNIQUE("invocation_id"),
	CONSTRAINT "internal_message_versions_positive" CHECK ("internal_outbound_message"."version">0 AND "internal_outbound_message"."direction_version">0 AND "internal_outbound_message"."recipient_version">0 AND "internal_outbound_message"."recipient_user_version">0),
	CONSTRAINT "internal_message_attempts_nonnegative" CHECK ("internal_outbound_message"."attempts">=0),
	CONSTRAINT "internal_message_hash_format" CHECK ("internal_outbound_message"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "internal_message_body_bound" CHECK (length(btrim("internal_outbound_message"."subject"))>0 AND length(btrim("internal_outbound_message"."body"))>0 AND length("internal_outbound_message"."body")<=8000),
	CONSTRAINT "internal_message_level_internal" CHECK ("internal_outbound_message"."data_level"='internal')
);
--> statement-breakpoint
CREATE TABLE "tool_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"tool_name" varchar(64) NOT NULL,
	"tool_version" varchar(128) NOT NULL,
	"arguments_hash" varchar(64) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"direction_version" integer NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"status" "tool_approval_status" DEFAULT 'pending' NOT NULL,
	"arguments_json" jsonb NOT NULL,
	"preview_json" jsonb NOT NULL,
	"target_versions_json" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "tool_approval_invocation_id_unique" UNIQUE("invocation_id"),
	CONSTRAINT "tool_approval_versions_positive" CHECK ("tool_approval"."version">0 AND "tool_approval"."direction_version">0),
	CONSTRAINT "tool_approval_hash_format" CHECK ("tool_approval"."arguments_hash" ~ '^[0-9a-f]{64}$' AND "tool_approval"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tool_approval_level_internal" CHECK ("tool_approval"."data_level" IN ('internal','confidential')),
	CONSTRAINT "tool_approval_payload_bound" CHECK (jsonb_typeof("tool_approval"."preview_json")='object' AND jsonb_typeof("tool_approval"."target_versions_json")='array' AND octet_length("tool_approval"."arguments_json"::text)<=73728 AND octet_length("tool_approval"."preview_json"::text)<=73728 AND octet_length("tool_approval"."target_versions_json"::text)<=73728)
);
--> statement-breakpoint
CREATE TABLE "tool_approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"action" "tool_approval_action" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_approval_decision_approval_id_unique" UNIQUE("approval_id"),
	CONSTRAINT "tool_approval_decision_request_unique" UNIQUE("actor_user_id","request_key"),
	CONSTRAINT "tool_approval_decision_version_positive" CHECK ("tool_approval_decision"."source_version">0),
	CONSTRAINT "tool_approval_decision_hash_format" CHECK ("tool_approval_decision"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tool_approval_decision_reason_bound" CHECK ("tool_approval_decision"."reason" IS NULL OR length("tool_approval_decision"."reason")<=4000)
);
--> statement-breakpoint
ALTER TABLE "role_binding" RENAME TO "legacy_role_binding";--> statement-breakpoint
ALTER TABLE "conversation" RENAME COLUMN "mode" TO "permission_mode";--> statement-breakpoint
ALTER TABLE public.conversation ALTER COLUMN permission_mode DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE public.conversation ALTER COLUMN permission_mode TYPE public.permission_mode
USING (CASE WHEN permission_mode::text='read_only' THEN 'read_only' ELSE 'ask' END)::public.permission_mode;
--> statement-breakpoint
ALTER TABLE public.conversation ALTER COLUMN permission_mode SET DEFAULT 'ask';
--> statement-breakpoint
ALTER TABLE "cert_project" DROP CONSTRAINT "cert_project_owner_reviewer_distinct";--> statement-breakpoint
ALTER TABLE "legacy_role_binding" DROP CONSTRAINT "role_binding_scope_consistent";--> statement-breakpoint
ALTER TABLE "legacy_role_binding" DROP CONSTRAINT "role_binding_version_positive";--> statement-breakpoint
ALTER TABLE "legacy_role_binding" DROP CONSTRAINT "role_binding_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "cert_project" ALTER COLUMN "reviewer_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "is_management" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "internal_user_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "agent_code" "agent_code" DEFAULT 'registration' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_tool_grant" ADD CONSTRAINT "conversation_tool_grant_source_decision_id_tool_approval_decision_id_fk" FOREIGN KEY ("source_decision_id") REFERENCES "public"."tool_approval_decision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_tool_grant" ADD CONSTRAINT "conversation_tool_grant_owner_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_outbound_message" ADD CONSTRAINT "internal_outbound_message_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_outbound_message" ADD CONSTRAINT "internal_message_invocation_context_fk" FOREIGN KEY ("invocation_id","run_id","conversation_id","user_id") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_outbound_message" ADD CONSTRAINT "internal_message_run_context_fk" FOREIGN KEY ("run_id","conversation_id","user_id","project_id","goal_id") REFERENCES "public"."run"("id","conversation_id","user_id","project_id","goal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_outbound_message" ADD CONSTRAINT "internal_message_contact_project_fk" FOREIGN KEY ("contact_id","project_id") REFERENCES "public"."contact"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval" ADD CONSTRAINT "tool_approval_invocation_context_fk" FOREIGN KEY ("invocation_id","run_id","conversation_id","user_id") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval" ADD CONSTRAINT "tool_approval_run_context_fk" FOREIGN KEY ("run_id","conversation_id","user_id","project_id","goal_id") REFERENCES "public"."run"("id","conversation_id","user_id","project_id","goal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_decision" ADD CONSTRAINT "tool_approval_decision_approval_id_tool_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."tool_approval"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_decision" ADD CONSTRAINT "tool_approval_decision_session_fk" FOREIGN KEY ("session_id","actor_user_id") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_message_daily_recipient_unique" ON "internal_outbound_message" USING btree ("goal_id","recipient_user_id","business_date") WHERE "internal_outbound_message"."status"<>'cancelled';--> statement-breakpoint
CREATE INDEX "tool_approval_conversation_status_idx" ON "tool_approval" USING btree ("conversation_id","status");--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_internal_user_id_app_user_id_fk" FOREIGN KEY ("internal_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_role_binding" ADD CONSTRAINT "legacy_role_binding_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_role_binding" ADD CONSTRAINT "role_binding_scope_consistent" CHECK (("legacy_role_binding"."scope_type" = 'project' AND "legacy_role_binding"."scope_id" IS NOT NULL) OR ("legacy_role_binding"."scope_type" IN ('global', 'own') AND "legacy_role_binding"."scope_id" IS NULL));--> statement-breakpoint
ALTER TABLE "legacy_role_binding" ADD CONSTRAINT "role_binding_version_positive" CHECK ("legacy_role_binding"."version" > 0);--> statement-breakpoint
DROP TYPE "public"."conversation_mode";
--> statement-breakpoint
UPDATE public.conversation c SET agent_code=p.project_type::text::public.agent_code
FROM public.cert_project p WHERE p.id=c.project_id;
--> statement-breakpoint
-- 只有原注册成员可延续部门身份；不能把原销售、管理层或纯维护账号自动升级为业务成员。
WITH prior AS MATERIALIZED (
  SELECT u.id,u.status,u.is_management,u.is_development,u.username,
    EXISTS(SELECT 1 FROM public.legacy_role_binding r WHERE r.user_id=u.id AND r.role IN ('RA','RB')) AS member,
    EXISTS(SELECT 1 FROM public.legacy_role_binding r WHERE r.user_id=u.id AND r.role='TECH' AND r.scope_type='global') AS manager
  FROM public.app_user u
), changed AS (
  UPDATE public.app_user u SET
    status=CASE WHEN NOT p.member OR (p.is_development AND p.username IN ('ra','rb','gm','sales','tech')) THEN 'disabled'::public.app_user_status ELSE p.status END,
    is_management=p.member AND p.manager AND NOT(p.is_development AND p.username IN ('ra','rb','gm','sales','tech')),
    version=u.version+1,updated_at=CURRENT_TIMESTAMP
  FROM prior p WHERE p.id=u.id RETURNING u.id,p.status AS prior_status,p.is_management AS prior_management,u.status,u.is_management
)
INSERT INTO public.audit_log(actor_kind,action,target_type,target_id,before_hash,after_hash)
SELECT 'system','authorization.members_migrated','app_user',id::text,
  encode(sha256(convert_to(jsonb_build_object('status',prior_status,'isManagement',prior_management)::text,'UTF8')),'hex'),
  encode(sha256(convert_to(jsonb_build_object('status',status,'isManagement',is_management)::text,'UTF8')),'hex') FROM changed;
--> statement-breakpoint
UPDATE public.web_session s SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP
FROM public.app_user u WHERE u.id=s.user_id AND u.status='disabled';
--> statement-breakpoint
CREATE FUNCTION public.reject_legacy_role_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION '旧角色仅保留历史，不再用于授权或修改。' USING ERRCODE='42501'; END; $$;
--> statement-breakpoint
CREATE TRIGGER legacy_role_binding_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.legacy_role_binding
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_legacy_role_mutation();
--> statement-breakpoint
ALTER TABLE public.legacy_role_binding ENABLE ALWAYS TRIGGER legacy_role_binding_read_only;
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_agent_code() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE project_type text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.agent_code<>OLD.agent_code THEN
    RAISE EXCEPTION '对话Agent已确定，请新建对话选择其他Agent。' USING ERRCODE='42501';
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    SELECT p.project_type::text INTO project_type FROM public.cert_project p WHERE p.id=NEW.project_id;
    IF project_type IS DISTINCT FROM NEW.agent_code::text THEN
      RAISE EXCEPTION '项目对话必须使用对应类型的Agent。' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER conversation_agent_code_guard BEFORE INSERT OR UPDATE ON public.conversation
FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_agent_code();
--> statement-breakpoint
ALTER TABLE public.conversation ENABLE ALWAYS TRIGGER conversation_agent_code_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_internal_contact_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.internal_user_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.internal_user_id IS DISTINCT FROM OLD.internal_user_id)
    AND NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.internal_user_id AND u.status='active' AND u.is_development) THEN
    RAISE EXCEPTION '本开发切片只能绑定有效的部门开发成员作为内部收件人。' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER contact_internal_binding_guard BEFORE INSERT OR UPDATE ON public.contact
FOR EACH ROW EXECUTE FUNCTION public.guard_internal_contact_binding();
--> statement-breakpoint
ALTER TABLE public.contact ENABLE ALWAYS TRIGGER contact_internal_binding_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_tool_approval_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status<>'pending' OR NEW.version<>1 OR NEW.decided_at IS NOT NULL THEN
    RAISE EXCEPTION '新过程批准必须等待浏览器决定。' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tool_invocation i JOIN public.run r ON r.id=i.run_id
    JOIN public.conversation c ON c.id=r.conversation_id WHERE i.id=NEW.invocation_id
    AND i.status='started' AND i.operation='execute' AND i.effect='reversible_write'
    AND i.tool_name=NEW.tool_name AND i.tool_version=NEW.tool_version AND i.arguments_hash=NEW.arguments_hash
    AND r.direction_version=NEW.direction_version AND NEW.data_level>=GREATEST(r.max_data_level,c.max_data_level)) THEN
    RAISE EXCEPTION '批准请求必须来自当前已登记工具及一致的参数、方向和数据级别。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER tool_approval_insert_guard BEFORE INSERT ON public.tool_approval FOR EACH ROW EXECUTE FUNCTION public.guard_tool_approval_insert();
--> statement-breakpoint
ALTER TABLE public.tool_approval ENABLE ALWAYS TRIGGER tool_approval_insert_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_tool_approval_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.id,NEW.invocation_id,NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.project_id,NEW.goal_id,NEW.tool_name,NEW.tool_version,NEW.arguments_hash,NEW.content_hash,NEW.direction_version,NEW.data_level,NEW.arguments_json,NEW.preview_json,NEW.target_versions_json,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.invocation_id,OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.project_id,OLD.goal_id,OLD.tool_name,OLD.tool_version,OLD.arguments_hash,OLD.content_hash,OLD.direction_version,OLD.data_level,OLD.arguments_json,OLD.preview_json,OLD.target_versions_json,OLD.created_at) THEN
    RAISE EXCEPTION '过程批准的工具、内容、版本快照和归属不能改写。' USING ERRCODE='42501';
  END IF;
  IF OLD.status<>'pending' AND ROW(NEW.status,NEW.version,NEW.decided_at) IS DISTINCT FROM ROW(OLD.status,OLD.version,OLD.decided_at) THEN
    RAISE EXCEPTION '已决定的过程批准不能再次决定。' USING ERRCODE='42501';
  END IF;
  IF (NEW.status<>OLD.status AND NEW.version<>OLD.version+1) OR (NEW.status=OLD.status AND NEW.version<>OLD.version)
    OR (NEW.status IN ('approved','rejected'))<>(NEW.decided_at IS NOT NULL) THEN
    RAISE EXCEPTION '过程批准状态、版本或决定时间不一致。' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER tool_approval_update_guard BEFORE UPDATE ON public.tool_approval FOR EACH ROW EXECUTE FUNCTION public.guard_tool_approval_update();
--> statement-breakpoint
ALTER TABLE public.tool_approval ENABLE ALWAYS TRIGGER tool_approval_update_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_tool_approval_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a public.tool_approval%ROWTYPE; expected_status text;
BEGIN
  SELECT * INTO a FROM public.tool_approval WHERE id=NEW.approval_id FOR UPDATE;
  expected_status:=CASE WHEN NEW.action='reject' THEN 'rejected' ELSE 'approved' END;
  IF NOT FOUND OR NEW.actor_user_id<>a.user_id OR NEW.content_hash<>a.content_hash OR NOT(
    (a.status='pending' AND a.version=NEW.source_version) OR (a.status::text=expected_status AND a.version=NEW.source_version+1)) THEN
    RAISE EXCEPTION '只有发起人可以决定当前版本的过程批准。' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
    WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active') THEN
    RAISE EXCEPTION '过程批准需要有效的浏览器会话。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER tool_approval_decision_guard BEFORE INSERT ON public.tool_approval_decision FOR EACH ROW EXECUTE FUNCTION public.guard_tool_approval_decision();
--> statement-breakpoint
ALTER TABLE public.tool_approval_decision ENABLE ALWAYS TRIGGER tool_approval_decision_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_tool_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.conversation_id,NEW.user_id,NEW.tool_name,NEW.tool_version,NEW.source_decision_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.conversation_id,OLD.user_id,OLD.tool_name,OLD.tool_version,OLD.source_decision_id,OLD.created_at)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION '会话工具授权不可改换来源或恢复已撤销状态。' USING ERRCODE='42501';
    END IF;
  ELSE
    IF NEW.revoked_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.tool_approval_decision d JOIN public.tool_approval a ON a.id=d.approval_id
      WHERE d.id=NEW.source_decision_id AND d.action='allow_conversation' AND d.actor_user_id=NEW.user_id
      AND a.conversation_id=NEW.conversation_id AND a.user_id=NEW.user_id AND a.tool_name=NEW.tool_name AND a.tool_version=NEW.tool_version) THEN
      RAISE EXCEPTION '会话工具授权只能来自本人对同一对话和工具版本的明确允许。' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER conversation_tool_grant_guard BEFORE INSERT OR UPDATE ON public.conversation_tool_grant FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_tool_grant();
--> statement-breakpoint
ALTER TABLE public.conversation_tool_grant ENABLE ALWAYS TRIGGER conversation_tool_grant_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_internal_message_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  NEW.business_date:=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  IF NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.version<>1 OR NEW.receipt_id IS NOT NULL OR NEW.processed_at IS NOT NULL THEN
    RAISE EXCEPTION '内部测试消息必须从未处理队列状态建立。' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tool_invocation i JOIN public.run r ON r.id=i.run_id JOIN public.undo_record u ON u.invocation_id=i.id
    WHERE i.id=NEW.invocation_id AND i.tool_name='queue_internal_message' AND i.effect='reversible_write' AND i.operation='execute' AND i.status='started'
    AND r.direction_version=NEW.direction_version AND u.status='pending' AND u.target_type='internal_outbound_message' AND u.target_id=NEW.id AND u.before_version IS NULL) THEN
    RAISE EXCEPTION '内部消息必须经登记工具并预先保存撤销凭据。' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.contact c JOIN public.app_user u ON u.id=c.internal_user_id
    WHERE c.id=NEW.contact_id AND c.project_id=NEW.project_id AND c.active AND c.internal_user_id=NEW.recipient_user_id
    AND c.version=NEW.recipient_version AND c.name=NEW.recipient_name AND c.address=NEW.recipient_address AND c.channel=NEW.channel
    AND u.version=NEW.recipient_user_version AND u.status='active' AND u.is_development) THEN
    RAISE EXCEPTION '内部收件人必须与当前绑定的有效开发成员和快照一致。' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER internal_message_insert_guard BEFORE INSERT ON public.internal_outbound_message FOR EACH ROW EXECUTE FUNCTION public.guard_internal_message_insert();
--> statement-breakpoint
ALTER TABLE public.internal_outbound_message ENABLE ALWAYS TRIGGER internal_message_insert_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_internal_message_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.id,NEW.invocation_id,NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.project_id,NEW.goal_id,NEW.direction_version,NEW.contact_id,NEW.recipient_user_id,NEW.recipient_version,NEW.recipient_user_version,NEW.recipient_name,NEW.recipient_address,NEW.channel,NEW.subject,NEW.body,NEW.content_hash,NEW.data_level,NEW.business_date,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.invocation_id,OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.project_id,OLD.goal_id,OLD.direction_version,OLD.contact_id,OLD.recipient_user_id,OLD.recipient_version,OLD.recipient_user_version,OLD.recipient_name,OLD.recipient_address,OLD.channel,OLD.subject,OLD.body,OLD.content_hash,OLD.data_level,OLD.business_date,OLD.created_at) THEN
    RAISE EXCEPTION '内部消息的内容、收件人和来源快照不可改写。' USING ERRCODE='42501';
  END IF;
  IF OLD.status<>'queued' AND ROW(NEW.status,NEW.version,NEW.attempts,NEW.last_reason,NEW.receipt_id,NEW.processed_at) IS DISTINCT FROM ROW(OLD.status,OLD.version,OLD.attempts,OLD.last_reason,OLD.receipt_id,OLD.processed_at) THEN
    RAISE EXCEPTION '已结束的内部消息不能再次处理或撤销。' USING ERRCODE='42501';
  END IF;
  IF NEW.status<>OLD.status THEN
    IF NEW.version<>OLD.version+1 OR (NEW.status='cancelled' AND (OLD.attempts<>0 OR NEW.attempts<>0)) THEN
      RAISE EXCEPTION '内部消息状态变化需要递增版本，已处理消息不能撤销。' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.version,NEW.attempts,NEW.last_reason,NEW.receipt_id,NEW.processed_at) IS DISTINCT FROM ROW(OLD.version,OLD.attempts,OLD.last_reason,OLD.receipt_id,OLD.processed_at) THEN
    RAISE EXCEPTION '内部消息处理必须同时完成状态转移。' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER internal_message_update_guard BEFORE UPDATE ON public.internal_outbound_message FOR EACH ROW EXECUTE FUNCTION public.guard_internal_message_update();
--> statement-breakpoint
ALTER TABLE public.internal_outbound_message ENABLE ALWAYS TRIGGER internal_message_update_guard;
--> statement-breakpoint
CREATE FUNCTION public.reject_permission_record_removal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION '批准、授权和内部消息记录必须保留，不能删除或清空。' USING ERRCODE='42501'; END; $$;
--> statement-breakpoint
CREATE TRIGGER tool_approval_no_removal BEFORE DELETE OR TRUNCATE ON public.tool_approval FOR EACH STATEMENT EXECUTE FUNCTION public.reject_permission_record_removal();
--> statement-breakpoint
ALTER TABLE public.tool_approval ENABLE ALWAYS TRIGGER tool_approval_no_removal;
--> statement-breakpoint
CREATE TRIGGER tool_approval_decision_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.tool_approval_decision FOR EACH STATEMENT EXECUTE FUNCTION public.reject_permission_record_removal();
--> statement-breakpoint
ALTER TABLE public.tool_approval_decision ENABLE ALWAYS TRIGGER tool_approval_decision_append_only;
--> statement-breakpoint
CREATE TRIGGER conversation_tool_grant_no_removal BEFORE DELETE OR TRUNCATE ON public.conversation_tool_grant FOR EACH STATEMENT EXECUTE FUNCTION public.reject_permission_record_removal();
--> statement-breakpoint
ALTER TABLE public.conversation_tool_grant ENABLE ALWAYS TRIGGER conversation_tool_grant_no_removal;
--> statement-breakpoint
CREATE TRIGGER internal_message_no_removal BEFORE DELETE OR TRUNCATE ON public.internal_outbound_message FOR EACH STATEMENT EXECUTE FUNCTION public.reject_permission_record_removal();
--> statement-breakpoint
ALTER TABLE public.internal_outbound_message ENABLE ALWAYS TRIGGER internal_message_no_removal;
--> statement-breakpoint
-- 旧角色归档、过程批准及内部消息均不授予cert_board_reader。
