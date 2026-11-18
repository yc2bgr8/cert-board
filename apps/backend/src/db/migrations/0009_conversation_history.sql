CREATE TYPE "public"."conversation_event_type" AS ENUM('user_message', 'assistant_message', 'model_started', 'tool_started', 'tool_completed', 'tool_failed', 'plan_updated', 'question', 'review_submitted', 'run_status');--> statement-breakpoint
CREATE TABLE "conversation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" "conversation_event_type" NOT NULL,
	"payload_json" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_event_request_unique" UNIQUE("run_id","request_key"),
	CONSTRAINT "conversation_event_seq_unique" UNIQUE("conversation_id","seq"),
	CONSTRAINT "conversation_event_seq_safe" CHECK ("conversation_event"."seq" > 0 AND "conversation_event"."seq" <= 9007199254740991),
	CONSTRAINT "conversation_event_json_shape" CHECK (jsonb_typeof("conversation_event"."payload_json") = 'object' AND octet_length("conversation_event"."payload_json"::text) <= 73728),
	CONSTRAINT "conversation_event_hash_format" CHECK ("conversation_event"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversation_event_level_internal" CHECK ("conversation_event"."data_level" IN ('internal','confidential'))
);
--> statement-breakpoint
CREATE TABLE "conversation_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"message_json" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_message_request_unique" UNIQUE("run_id","request_key"),
	CONSTRAINT "conversation_message_seq_unique" UNIQUE("conversation_id","seq"),
	CONSTRAINT "conversation_message_seq_safe" CHECK ("conversation_message"."seq" > 0 AND "conversation_message"."seq" <= 9007199254740991),
	CONSTRAINT "conversation_message_json_shape" CHECK (jsonb_typeof("conversation_message"."message_json") = 'object' AND "conversation_message"."message_json"->>'role' IN ('system','user','assistant','tool') AND octet_length("conversation_message"."message_json"::text) <= 270336),
	CONSTRAINT "conversation_message_hash_format" CHECK ("conversation_message"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "conversation_message_level_internal" CHECK ("conversation_message"."data_level" IN ('internal','confidential'))
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "last_message_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "last_event_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_event" ADD CONSTRAINT "conversation_event_run_context_fk" FOREIGN KEY ("run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_run_context_fk" FOREIGN KEY ("run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_message_seq_safe" CHECK ("conversation"."last_message_seq" >= 0 AND "conversation"."last_message_seq" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_event_seq_safe" CHECK ("conversation"."last_event_seq" >= 0 AND "conversation"."last_event_seq" <= 9007199254740991);
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_history_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $history_insert$
DECLARE c public.conversation%ROWTYPE; r public.run%ROWTYPE; last_seq bigint;
BEGIN
    SELECT * INTO c FROM public.conversation WHERE id=NEW.conversation_id FOR UPDATE;
    IF NOT FOUND OR c.user_id<>NEW.user_id THEN
        RAISE EXCEPTION '对话记录不属于当前用户。' USING ERRCODE='42501';
    END IF;
    SELECT * INTO r FROM public.run WHERE id=NEW.run_id FOR SHARE;
    IF NOT FOUND OR r.conversation_id<>NEW.conversation_id OR r.user_id<>NEW.user_id THEN
        RAISE EXCEPTION '对话记录必须绑定同一用户的实际运行。' USING ERRCODE='42501';
    END IF;
    IF NEW.data_level < GREATEST(c.max_data_level,r.max_data_level) THEN
        RAISE EXCEPTION '对话记录必须保留已接触的最高资料级别。' USING ERRCODE='42501';
    END IF;
    last_seq := CASE WHEN TG_TABLE_NAME='conversation_message' THEN c.last_message_seq ELSE c.last_event_seq END;
    IF NEW.seq<>last_seq+1 THEN
        RAISE EXCEPTION '对话记录序号必须连续追加。' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='conversation_message' THEN
        UPDATE public.conversation SET last_message_seq=NEW.seq,max_data_level=GREATEST(max_data_level,NEW.data_level),version=version+1,updated_at=clock_timestamp() WHERE id=c.id;
    ELSE
        UPDATE public.conversation SET last_event_seq=NEW.seq,max_data_level=GREATEST(max_data_level,NEW.data_level),version=version+1,updated_at=clock_timestamp() WHERE id=c.id;
    END IF;
    RETURN NEW;
END;
$history_insert$;
--> statement-breakpoint
CREATE TRIGGER conversation_message_insert_guard BEFORE INSERT ON public.conversation_message
FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_history_insert();
--> statement-breakpoint
ALTER TABLE public.conversation_message ENABLE ALWAYS TRIGGER conversation_message_insert_guard;
--> statement-breakpoint
CREATE TRIGGER conversation_event_insert_guard BEFORE INSERT ON public.conversation_event
FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_history_insert();
--> statement-breakpoint
ALTER TABLE public.conversation_event ENABLE ALWAYS TRIGGER conversation_event_insert_guard;
--> statement-breakpoint
CREATE FUNCTION public.reject_conversation_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $history_immutable$
BEGIN
    RAISE EXCEPTION '对话消息和过程记录只允许追加，不能改写、删除或清空。' USING ERRCODE='42501';
END;
$history_immutable$;
--> statement-breakpoint
CREATE TRIGGER conversation_message_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.conversation_message
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_conversation_history_mutation();
--> statement-breakpoint
ALTER TABLE public.conversation_message ENABLE ALWAYS TRIGGER conversation_message_append_only;
--> statement-breakpoint
CREATE TRIGGER conversation_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.conversation_event
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_conversation_history_mutation();
--> statement-breakpoint
ALTER TABLE public.conversation_event ENABLE ALWAYS TRIGGER conversation_event_append_only;
--> statement-breakpoint
CREATE FUNCTION public.guard_conversation_history_counters()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $history_counters$
BEGIN
    IF NEW.last_message_seq<OLD.last_message_seq OR NEW.last_event_seq<OLD.last_event_seq THEN
        RAISE EXCEPTION '对话记录序号不能回退。' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$history_counters$;
--> statement-breakpoint
CREATE TRIGGER conversation_history_counters_guard BEFORE UPDATE ON public.conversation
FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_history_counters();
--> statement-breakpoint
ALTER TABLE public.conversation ENABLE ALWAYS TRIGGER conversation_history_counters_guard;
--> statement-breakpoint
-- 私有对话正文和界面过程不授予 cert_board_reader，不进入 run_event。
