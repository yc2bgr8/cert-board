-- PR-08：工具调用元数据与私有会话结果分开。原值仅供撤销，不是执行事件正文。
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'budget_exhausted');--> statement-breakpoint
CREATE TYPE "public"."run_trigger_type" AS ENUM('conversation', 'wakeup', 'evaluation');--> statement-breakpoint
CREATE TYPE "public"."tool_effect" AS ENUM('read', 'reversible_write', 'external', 'irreversible');--> statement-breakpoint
CREATE TYPE "public"."tool_invocation_status" AS ENUM('started', 'completed', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tool_invocation_operation" AS ENUM('execute', 'undo');--> statement-breakpoint
CREATE TYPE "public"."undo_record_status" AS ENUM('pending', 'available', 'undone');--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_owner_unique" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "conversation_tool_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_json" jsonb NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_tool_result_invocation_id_unique" UNIQUE("invocation_id")
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"goal_id" uuid,
	"direction_version" integer DEFAULT 1 NOT NULL,
	"trigger_type" "run_trigger_type" DEFAULT 'conversation' NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"max_data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "run_conversation_user_unique" UNIQUE("id","conversation_id","user_id"),
	CONSTRAINT "run_goal_requires_project" CHECK ("run"."goal_id" IS NULL OR "run"."project_id" IS NOT NULL),
	CONSTRAINT "run_direction_version_positive" CHECK ("run"."direction_version" > 0),
	CONSTRAINT "run_data_level_internal" CHECK ("run"."max_data_level" IN ('internal', 'confidential')),
	CONSTRAINT "run_finished_time_order" CHECK ("run"."finished_at" IS NULL OR "run"."finished_at" >= "run"."created_at"),
	CONSTRAINT "run_version_positive" CHECK ("run"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "tool_invocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"call_id" varchar(128) NOT NULL,
	"tool_name" varchar(64) NOT NULL,
	"tool_version" varchar(128) NOT NULL,
	"arguments_hash" varchar(64) NOT NULL,
	"effect" "tool_effect" NOT NULL,
	"operation" "tool_invocation_operation" DEFAULT 'execute' NOT NULL,
	"status" "tool_invocation_status" DEFAULT 'started' NOT NULL,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_invocation_call_unique" UNIQUE("run_id","call_id"),
	CONSTRAINT "tool_invocation_owner_unique" UNIQUE("id","conversation_id","user_id"),
	CONSTRAINT "tool_invocation_run_owner_unique" UNIQUE("id","run_id","conversation_id","user_id"),
	CONSTRAINT "tool_invocation_call_not_blank" CHECK (length(btrim("tool_invocation"."call_id")) > 0),
	CONSTRAINT "tool_invocation_name_not_blank" CHECK (length(btrim("tool_invocation"."tool_name")) > 0),
	CONSTRAINT "tool_invocation_version_not_blank" CHECK (length(btrim("tool_invocation"."tool_version")) > 0),
	CONSTRAINT "tool_invocation_arguments_hash_format" CHECK ("tool_invocation"."arguments_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "undo_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_name" varchar(64) NOT NULL,
	"tool_version" varchar(128) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" uuid NOT NULL,
	"before_state" jsonb NOT NULL,
	"before_version" varchar(128),
	"after_version" varchar(128),
	"status" "undo_record_status" DEFAULT 'pending' NOT NULL,
	"undone_version" varchar(128),
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "undo_record_invocation_id_unique" UNIQUE("invocation_id"),
	CONSTRAINT "undo_record_tool_name_not_blank" CHECK (length(btrim("undo_record"."tool_name")) > 0),
	CONSTRAINT "undo_record_tool_version_not_blank" CHECK (length(btrim("undo_record"."tool_version")) > 0),
	CONSTRAINT "undo_record_target_type_not_blank" CHECK (length(btrim("undo_record"."target_type")) > 0),
	CONSTRAINT "undo_record_before_version_not_blank" CHECK ("undo_record"."before_version" IS NULL OR length(btrim("undo_record"."before_version")) > 0),
	CONSTRAINT "undo_record_after_version_not_blank" CHECK ("undo_record"."after_version" IS NULL OR length(btrim("undo_record"."after_version")) > 0),
	CONSTRAINT "undo_record_undone_version_not_blank" CHECK ("undo_record"."undone_version" IS NULL OR length(btrim("undo_record"."undone_version")) > 0),
	CONSTRAINT "undo_record_state_consistent" CHECK (("undo_record"."status" = 'pending' AND "undo_record"."after_version" IS NULL AND "undo_record"."undone_version" IS NULL AND "undo_record"."undone_at" IS NULL AND "undo_record"."undone_by" IS NULL) OR ("undo_record"."status" = 'available' AND "undo_record"."after_version" IS NOT NULL AND "undo_record"."undone_version" IS NULL AND "undo_record"."undone_at" IS NULL AND "undo_record"."undone_by" IS NULL) OR ("undo_record"."status" = 'undone' AND "undo_record"."after_version" IS NOT NULL AND "undo_record"."undone_version" IS NOT NULL AND "undo_record"."undone_at" IS NOT NULL AND "undo_record"."undone_by" IS NOT NULL)),
	CONSTRAINT "undo_record_undone_time_order" CHECK ("undo_record"."undone_at" IS NULL OR "undo_record"."undone_at" >= "undo_record"."created_at")
);
--> statement-breakpoint
ALTER TABLE "conversation_tool_result" ADD CONSTRAINT "conversation_tool_result_invocation_owner_fk" FOREIGN KEY ("invocation_id","conversation_id","user_id") REFERENCES "public"."tool_invocation"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_conversation_owner_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_conversation_owner_project_fk" FOREIGN KEY ("conversation_id","user_id","project_id") REFERENCES "public"."conversation"("id","user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_goal_project_fk" FOREIGN KEY ("goal_id","project_id") REFERENCES "public"."goal"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocation" ADD CONSTRAINT "tool_invocation_run_owner_fk" FOREIGN KEY ("run_id","conversation_id","user_id") REFERENCES "public"."run"("id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "undo_record" ADD CONSTRAINT "undo_record_undone_by_app_user_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "undo_record" ADD CONSTRAINT "undo_record_invocation_run_owner_fk" FOREIGN KEY ("invocation_id","run_id","conversation_id","user_id") REFERENCES "public"."tool_invocation"("id","run_id","conversation_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_tool_result_conversation_idx" ON "conversation_tool_result" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "run_conversation_idx" ON "run" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "run_user_status_idx" ON "run" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tool_invocation_conversation_idx" ON "tool_invocation" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "undo_record_conversation_idx" ON "undo_record" USING btree ("conversation_id");--> statement-breakpoint

-- nullable 项目不能借 MATCH SIMPLE 跳过身份或目标归属：使用明确的 NULL 相等判断。
CREATE FUNCTION public.guard_run_context()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $run_context$
DECLARE
    context_project uuid;
    context_goal uuid;
    context_level public.document_data_level;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.conversation_id,NEW.user_id,NEW.project_id,NEW.goal_id,NEW.direction_version,NEW.trigger_type,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.conversation_id,OLD.user_id,OLD.project_id,OLD.goal_id,OLD.direction_version,OLD.trigger_type,OLD.created_at) THEN
            RAISE EXCEPTION '运行的身份、项目、目标与方向版本不能改写，请建立新运行。' USING ERRCODE = '42501';
        END IF;
        IF NEW.max_data_level < OLD.max_data_level THEN
            RAISE EXCEPTION '运行已接触的最高资料级别不能降低。' USING ERRCODE = '42501';
        END IF;
    END IF;
    SELECT project_id,goal_id,max_data_level INTO context_project,context_goal,context_level
    FROM public.conversation WHERE id=NEW.conversation_id AND user_id=NEW.user_id FOR SHARE;
    IF NOT FOUND OR NEW.project_id IS DISTINCT FROM context_project OR NEW.goal_id IS DISTINCT FROM context_goal THEN
        RAISE EXCEPTION '运行必须使用所属对话的用户、项目与目标，不能绕过对话上下文。' USING ERRCODE = '23503';
    END IF;
    IF TG_OP='INSERT' AND NEW.max_data_level < context_level THEN
        RAISE EXCEPTION '新运行的资料级别不能低于所属对话。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$run_context$;
--> statement-breakpoint
CREATE TRIGGER run_context_guard BEFORE INSERT OR UPDATE ON public.run
FOR EACH ROW EXECUTE FUNCTION public.guard_run_context();
--> statement-breakpoint
ALTER TABLE public.run ENABLE ALWAYS TRIGGER run_context_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_conversation_run_context()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $conversation_run_context$
BEGIN
    IF ROW(NEW.user_id,NEW.project_id,NEW.goal_id) IS DISTINCT FROM ROW(OLD.user_id,OLD.project_id,OLD.goal_id)
       AND EXISTS(SELECT 1 FROM public.run WHERE conversation_id=OLD.id) THEN
        RAISE EXCEPTION '已有运行的对话不能改换用户、项目或目标，请建立新对话。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$conversation_run_context$;
--> statement-breakpoint
CREATE TRIGGER conversation_run_context_guard BEFORE UPDATE ON public.conversation
FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_run_context();
--> statement-breakpoint
ALTER TABLE public.conversation ENABLE ALWAYS TRIGGER conversation_run_context_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_tool_invocation_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $invocation_identity$
BEGIN
    IF ROW(NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.call_id,NEW.tool_name,NEW.tool_version,NEW.arguments_hash,NEW.effect,NEW.operation,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.call_id,OLD.tool_name,OLD.tool_version,OLD.arguments_hash,OLD.effect,OLD.operation,OLD.created_at) THEN
        RAISE EXCEPTION '工具调用身份、参数摘要及操作类型不能改写，请使用新调用编号。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$invocation_identity$;
--> statement-breakpoint
CREATE TRIGGER tool_invocation_identity_guard BEFORE UPDATE ON public.tool_invocation
FOR EACH ROW EXECUTE FUNCTION public.guard_tool_invocation_identity();
--> statement-breakpoint
ALTER TABLE public.tool_invocation ENABLE ALWAYS TRIGGER tool_invocation_identity_guard;
--> statement-breakpoint

CREATE FUNCTION public.guard_undo_record_original()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $undo_original$
BEGIN
    IF ROW(NEW.invocation_id,NEW.run_id,NEW.conversation_id,NEW.user_id,NEW.tool_name,NEW.tool_version,NEW.target_type,NEW.target_id,NEW.before_state,NEW.before_version,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.invocation_id,OLD.run_id,OLD.conversation_id,OLD.user_id,OLD.tool_name,OLD.tool_version,OLD.target_type,OLD.target_id,OLD.before_state,OLD.before_version,OLD.created_at) THEN
        RAISE EXCEPTION '撤销凭据的原值、原版本与所属调用不能改写。' USING ERRCODE = '42501';
    END IF;
    IF OLD.status <> 'pending' AND NEW.after_version IS DISTINCT FROM OLD.after_version THEN
        RAISE EXCEPTION '已经保存的写入后版本不能改写。' USING ERRCODE = '42501';
    END IF;
    IF (OLD.status='pending' AND NEW.status NOT IN ('pending','available'))
       OR (OLD.status='available' AND NEW.status NOT IN ('available','undone'))
       OR OLD.status='undone' THEN
        RAISE EXCEPTION '撤销状态不能回退或重复完成，请读取原撤销结果。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$undo_original$;
--> statement-breakpoint
CREATE TRIGGER undo_record_original_guard BEFORE UPDATE ON public.undo_record
FOR EACH ROW EXECUTE FUNCTION public.guard_undo_record_original();
--> statement-breakpoint
ALTER TABLE public.undo_record ENABLE ALWAYS TRIGGER undo_record_original_guard;
--> statement-breakpoint

-- 幂等键与撤销凭据必须保留，不能靠删除记录重新执行同一个调用。
CREATE FUNCTION public.reject_tool_record_deletion()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $tool_record_deletion$
BEGIN
    RAISE EXCEPTION '工具幂等记录和撤销凭据不能删除或清空。' USING ERRCODE = '42501';
END;
$tool_record_deletion$;
--> statement-breakpoint
CREATE TRIGGER tool_invocation_no_deletion BEFORE DELETE OR TRUNCATE ON public.tool_invocation
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_tool_record_deletion();
--> statement-breakpoint
ALTER TABLE public.tool_invocation ENABLE ALWAYS TRIGGER tool_invocation_no_deletion;
--> statement-breakpoint
CREATE TRIGGER undo_record_no_deletion BEFORE DELETE OR TRUNCATE ON public.undo_record
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_tool_record_deletion();
--> statement-breakpoint
ALTER TABLE public.undo_record ENABLE ALWAYS TRIGGER undo_record_no_deletion;
--> statement-breakpoint

-- 运行、调用、会话正文和撤销原值均属私有执行上下文，不授权 cert_board_reader。

CREATE FUNCTION public.reject_tool_result_rewrite()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $tool_result_rewrite$
BEGIN
    RAISE EXCEPTION '已保存的工具返回正文不能改写，请通过新调用产生新结果。' USING ERRCODE = '42501';
END;
$tool_result_rewrite$;
--> statement-breakpoint
CREATE TRIGGER conversation_tool_result_no_rewrite BEFORE UPDATE ON public.conversation_tool_result
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_tool_result_rewrite();
--> statement-breakpoint
ALTER TABLE public.conversation_tool_result ENABLE ALWAYS TRIGGER conversation_tool_result_no_rewrite;
--> statement-breakpoint

-- pending 是同一事务内的准备状态；提交时必须已取得真实写入后的版本。
CREATE FUNCTION public.ensure_undo_record_ready()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $undo_ready$
BEGIN
    IF EXISTS(SELECT 1 FROM public.undo_record WHERE id=NEW.id AND status='pending') THEN
        RAISE EXCEPTION '撤销原值尚未与写入后版本配对，整个操作必须回滚。' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$undo_ready$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER undo_record_ready_at_commit
AFTER INSERT OR UPDATE ON public.undo_record
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.ensure_undo_record_ready();
--> statement-breakpoint
ALTER TABLE public.undo_record ENABLE ALWAYS TRIGGER undo_record_ready_at_commit;
