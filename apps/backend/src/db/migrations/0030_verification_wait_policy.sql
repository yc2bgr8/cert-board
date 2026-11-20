CREATE TABLE "verification_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"kind" varchar(12) NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_notice_once" UNIQUE("room_id","kind","position"),
	CONSTRAINT "verification_notice_kind" CHECK ("verification_notice"."kind" IN ('blocked','late'))
);
--> statement-breakpoint
ALTER TABLE "goal_wait" ADD COLUMN "next_step" varchar(500) NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_link" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_link" ADD COLUMN "timeout_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_preference" ADD COLUMN "wait_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD COLUMN "conclusion" jsonb;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD COLUMN "fallback" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD COLUMN "direction_from" integer;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD COLUMN "delivered_conclusion_position" integer;--> statement-breakpoint
ALTER TABLE "verification_notice" ADD CONSTRAINT "verification_notice_room_id_verification_link_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."verification_link"("room_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_notice" ADD CONSTRAINT "verification_notice_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_notice_recipient_idx" ON "verification_notice" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
ALTER TABLE "verification_preference" ADD CONSTRAINT "verification_wait_minutes_range" CHECK ("verification_preference"."wait_minutes" BETWEEN 1 AND 240);
CREATE OR REPLACE FUNCTION public.guard_run_context()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $run_context$
DECLARE
    context_project uuid;
    context_goal uuid;
    context_level public.document_data_level;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.conversation_id,NEW.user_id,NEW.project_id,NEW.goal_id,NEW.trigger_type,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.conversation_id,OLD.user_id,OLD.project_id,OLD.goal_id,OLD.trigger_type,OLD.created_at) THEN
            RAISE EXCEPTION '运行的身份、项目和目标不能改写。' USING ERRCODE = '42501';
        END IF;
        IF NEW.direction_version IS DISTINCT FROM OLD.direction_version AND NOT (
            OLD.status='waiting' AND NEW.status='queued' AND NEW.direction_version>OLD.direction_version
            AND (OLD.lease_owner IS NULL OR OLD.lease_expires_at<=clock_timestamp())
            AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL AND EXISTS (
                SELECT 1 FROM public.verification_wait w
                JOIN public.goal_event e ON e.source='verification' AND e.source_key=w.room_id::text
                JOIN public.goal g ON g.id=e.goal_id AND g.id=NEW.goal_id
                JOIN public.app_user u ON u.id=w.user_id AND u.status='active'
                WHERE w.run_id=OLD.id AND w.user_id=OLD.user_id AND w.conversation_id=OLD.conversation_id
                  AND w.call_id IS NOT NULL AND w.state='queued' AND w.direction_from=OLD.direction_version
                  AND e.wake_run_id=OLD.id AND e.state='queued' AND g.status='active'
                  AND g.direction_version=NEW.direction_version
            )
        ) THEN
            RAISE EXCEPTION '仅已登记的核实续跑可按审核过的目标方向继续。' USING ERRCODE = '42501';
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
CREATE FUNCTION public.notify_verification_inbox() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    PERFORM pg_notify('cert_board_verification_link_change',
        json_build_object('userId',NEW.recipient_user_id,'shared',false)::text);
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verification_inbox_change AFTER INSERT ON public.verification_notice
FOR EACH ROW EXECUTE FUNCTION public.notify_verification_inbox();
