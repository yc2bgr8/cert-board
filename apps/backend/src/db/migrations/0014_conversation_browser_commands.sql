ALTER TYPE "public"."conversation_event_type" ADD VALUE 'question_answered';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_type" ADD VALUE 'permission_changed';--> statement-breakpoint
ALTER TYPE "public"."conversation_event_type" ADD VALUE 'changes';--> statement-breakpoint
CREATE TABLE "conversation_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question_invocation_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"question_call_id" varchar(128) NOT NULL,
	"new_run_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "conversation_answer_question_invocation_id_unique" UNIQUE("question_invocation_id"),
	CONSTRAINT "conversation_answer_new_run_id_unique" UNIQUE("new_run_id"),
	CONSTRAINT "conversation_answer_user_request_unique" UNIQUE("user_id","request_key"),
	CONSTRAINT "conversation_answer_distinct_run" CHECK ("conversation_answer"."source_run_id"<>"conversation_answer"."new_run_id"),
	CONSTRAINT "conversation_answer_text_bound" CHECK (length(btrim("conversation_answer"."text"))>0 AND length("conversation_answer"."text")<=8000 AND octet_length("conversation_answer"."text")<=32000)
);
--> statement-breakpoint
CREATE TABLE "conversation_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"action" varchar(24) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"result_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_command_user_request_unique" UNIQUE("user_id","request_key"),
	CONSTRAINT "conversation_command_action" CHECK ("conversation_command"."action" IN ('create','message','answer','mode','stop')),
	CONSTRAINT "conversation_command_hash" CHECK ("conversation_command"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversation_command_result_bound" CHECK (jsonb_typeof("conversation_command"."result_json")='object' AND octet_length("conversation_command"."result_json"::text)<=16384)
);
--> statement-breakpoint
CREATE TABLE "run_steering_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"delivered_message_id" uuid,
	"delivered_seq" bigint,
	"delivered_at" timestamp with time zone,
	"delivered_generation" bigint,
	CONSTRAINT "run_steering_message_run_request_unique" UNIQUE("run_id","request_key"),
	CONSTRAINT "run_steering_message_content_bound" CHECK (length(btrim("run_steering_message"."content"))>0 AND length("run_steering_message"."content")<=8000 AND octet_length("run_steering_message"."content")<=32000),
	CONSTRAINT "run_steering_message_delivery_complete" CHECK (("run_steering_message"."delivered_message_id" IS NULL AND "run_steering_message"."delivered_seq" IS NULL AND "run_steering_message"."delivered_at" IS NULL AND "run_steering_message"."delivered_generation" IS NULL) OR ("run_steering_message"."delivered_message_id" IS NOT NULL AND "run_steering_message"."delivered_seq">0 AND "run_steering_message"."delivered_seq"<=9007199254740991 AND "run_steering_message"."delivered_at" IS NOT NULL AND "run_steering_message"."delivered_generation">0 AND "run_steering_message"."delivered_generation"<=9007199254740991))
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "permission_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "current_run_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_answer" ADD CONSTRAINT "conversation_answer_question_owner_fk" FOREIGN KEY ("question_invocation_id","source_run_id","conversation_id","user_id") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_answer" ADD CONSTRAINT "conversation_answer_new_run_owner_fk" FOREIGN KEY ("new_run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_command" ADD CONSTRAINT "conversation_command_owner_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_command" ADD CONSTRAINT "conversation_command_session_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steering_message" ADD CONSTRAINT "run_steering_message_delivered_message_id_conversation_message_id_fk" FOREIGN KEY ("delivered_message_id") REFERENCES "public"."conversation_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steering_message" ADD CONSTRAINT "run_steering_message_owner_fk" FOREIGN KEY ("run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_steering_message_pending_idx" ON "run_steering_message" USING btree ("run_id","created_at","id") WHERE "run_steering_message"."delivered_at" IS NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_current_run_owner_fk" FOREIGN KEY ("current_run_id","id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_permission_version_positive" CHECK ("conversation"."permission_version">0);
--> statement-breakpoint
-- 只指向既有、同属本对话发起人的最新真实运行，不为历史对话制造运行。
UPDATE public.conversation c SET current_run_id=(SELECT r.id FROM public.run r
  WHERE r.conversation_id=c.id AND r.user_id=c.user_id ORDER BY r.created_at DESC,r.id DESC LIMIT 1)
WHERE EXISTS(SELECT 1 FROM public.run r WHERE r.conversation_id=c.id AND r.user_id=c.user_id);
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_permission_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.permission_mode IS DISTINCT FROM OLD.permission_mode THEN
    IF NEW.permission_version NOT IN (OLD.permission_version,OLD.permission_version+1) THEN
      RAISE EXCEPTION '权限模式版本不一致。' USING ERRCODE='23514';
    END IF;
    NEW.permission_version:=OLD.permission_version+1;
  ELSIF NEW.permission_version<>OLD.permission_version THEN
    RAISE EXCEPTION '权限版本只能随模式变化递增。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER conversation_permission_version_guard BEFORE UPDATE ON public.conversation FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_permission_version();
--> statement-breakpoint
ALTER TABLE public.conversation ENABLE ALWAYS TRIGGER conversation_permission_version_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_command_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
    WHERE s.id=NEW.session_id AND s.user_id=NEW.user_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active') THEN
    RAISE EXCEPTION '浏览器写入回执需要当前有效的用户会话。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER conversation_command_insert_guard BEFORE INSERT ON public.conversation_command FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_command_insert();
--> statement-breakpoint
ALTER TABLE public.conversation_command ENABLE ALWAYS TRIGGER conversation_command_insert_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_steering_message() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.delivered_message_id IS NOT NULL OR NEW.delivered_seq IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.delivered_generation IS NOT NULL THEN
      RAISE EXCEPTION '新插话只能等待持有执行权的内核投递。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.delivered_at IS NOT NULL OR ROW(NEW.id,NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.request_key,NEW.content,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.request_key,OLD.content,OLD.created_at) THEN
    RAISE EXCEPTION '插话原文、归属与已投递回执不能改写。' USING ERRCODE='42501';
  END IF;
  IF NEW.delivered_message_id IS NULL OR NEW.delivered_seq IS NULL OR NEW.delivered_at IS NULL OR NEW.delivered_generation IS NULL THEN
    RAISE EXCEPTION '插话投递需要完整回执。' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.run r JOIN public.conversation_message m ON m.run_id=r.id
    WHERE r.id=NEW.run_id AND r.user_id=NEW.user_id AND r.conversation_id=NEW.conversation_id AND r.status='running'
      AND r.lease_owner IS NOT NULL AND r.lease_generation=NEW.delivered_generation AND r.lease_expires_at>clock_timestamp()
      AND m.id=NEW.delivered_message_id AND m.user_id=NEW.user_id AND m.conversation_id=NEW.conversation_id
      AND m.request_key=NEW.request_key AND m.seq=NEW.delivered_seq
      AND m.message_json=jsonb_build_object('role','user','content',NEW.content)) THEN
    RAISE EXCEPTION '插话只能在原运行的真实执行权内与原文消息同时投递。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER run_steering_message_guard BEFORE INSERT OR UPDATE ON public.run_steering_message FOR EACH ROW EXECUTE FUNCTION public.guard_steering_message();
--> statement-breakpoint
ALTER TABLE public.run_steering_message ENABLE ALWAYS TRIGGER run_steering_message_guard;
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_answer_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.tool_invocation i JOIN public.conversation_tool_result p ON p.invocation_id=i.id
    JOIN public.run r ON r.id=i.run_id JOIN public.conversation c ON c.id=r.conversation_id
    WHERE i.id=NEW.question_invocation_id AND i.run_id=NEW.source_run_id AND i.conversation_id=NEW.conversation_id AND i.user_id=NEW.user_id
      AND i.call_id=NEW.question_call_id AND i.tool_name='ask_user' AND i.effect='read' AND i.operation='execute' AND i.status='completed'
      AND p.content_json->>'status'='completed' AND p.content_json#>>'{result,data,question}' IS NOT NULL
      AND r.status='waiting' AND (r.lease_owner IS NULL OR r.lease_expires_at<=clock_timestamp())
      AND c.current_run_id=r.id) THEN
    RAISE EXCEPTION '回答必须对应本人当前等待中的真实提问。' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER conversation_answer_insert_guard BEFORE INSERT ON public.conversation_answer FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_answer_insert();
--> statement-breakpoint
ALTER TABLE public.conversation_answer ENABLE ALWAYS TRIGGER conversation_answer_insert_guard;
--> statement-breakpoint
CREATE TRIGGER conversation_command_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.conversation_command FOR EACH STATEMENT EXECUTE FUNCTION public.reject_conversation_history_mutation();
--> statement-breakpoint
ALTER TABLE public.conversation_command ENABLE ALWAYS TRIGGER conversation_command_append_only;
--> statement-breakpoint
CREATE TRIGGER conversation_answer_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.conversation_answer FOR EACH STATEMENT EXECUTE FUNCTION public.reject_conversation_history_mutation();
--> statement-breakpoint
ALTER TABLE public.conversation_answer ENABLE ALWAYS TRIGGER conversation_answer_append_only;
--> statement-breakpoint
CREATE TRIGGER run_steering_message_no_removal BEFORE DELETE OR TRUNCATE ON public.run_steering_message FOR EACH STATEMENT EXECUTE FUNCTION public.reject_conversation_history_mutation();
--> statement-breakpoint
ALTER TABLE public.run_steering_message ENABLE ALWAYS TRIGGER run_steering_message_no_removal;
--> statement-breakpoint
-- 浏览器命令、回答和插话正文均属私有会话数据，不授予cert_board_reader。
