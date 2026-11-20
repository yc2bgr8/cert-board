CREATE TABLE "outbound_resolution" (
	"queue_id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"action" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_resolution_request_unique" UNIQUE("actor_user_id","request_key"),
	CONSTRAINT "outbound_resolution_action" CHECK ("outbound_resolution"."action" IN ('confirm_sent','repropose')),
	CONSTRAINT "outbound_resolution_version" CHECK ("outbound_resolution"."source_version">0)
);
--> statement-breakpoint
CREATE TABLE "simulated_email_delivery" (
	"queue_id" uuid PRIMARY KEY NOT NULL,
	"reply" varchar(12) NOT NULL,
	"sent_folder" varchar(16) NOT NULL,
	"provider_filed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulated_email_reply" CHECK ("simulated_email_delivery"."reply" IN ('success','uncertain','failure')),
	CONSTRAINT "simulated_email_sent_folder" CHECK ("simulated_email_delivery"."sent_folder" IN ('auto_store','no_store','unavailable'))
);
--> statement-breakpoint
CREATE TABLE "simulated_wechat_copy" (
	"notice_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"result" varchar(12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "simulated_wechat_copy_attempt" UNIQUE("notice_id","attempt"),
	CONSTRAINT "simulated_wechat_copy_limit" CHECK ("simulated_wechat_copy"."attempt" IN (1,2)),
	CONSTRAINT "simulated_wechat_copy_result" CHECK ("simulated_wechat_copy"."result" IN ('success','timeout','failure'))
);
--> statement-breakpoint
ALTER TABLE "outbound_message" ADD COLUMN "dispatch_id" text GENERATED ALWAYS AS ('<' || id::text || '@cert-board.local>') STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_resolution" ADD CONSTRAINT "outbound_resolution_queue_id_outbound_message_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."outbound_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_resolution" ADD CONSTRAINT "outbound_resolution_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_resolution" ADD CONSTRAINT "outbound_resolution_browser_session" FOREIGN KEY ("session_id","actor_user_id") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_email_delivery" ADD CONSTRAINT "simulated_email_delivery_queue_id_outbound_message_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."outbound_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_wechat_copy" ADD CONSTRAINT "simulated_wechat_copy_notice_id_notification_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notification"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_dispatch_unique" UNIQUE("dispatch_id");
--> statement-breakpoint
CREATE FUNCTION public.guard_outbound_resolution()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.outbound_message q
        JOIN public.proposal p ON p.id=q.proposal_id
        JOIN public.web_session s ON s.id=NEW.session_id AND s.user_id=NEW.actor_user_id
        JOIN public.app_user u ON u.id=s.user_id AND u.status='active'
        WHERE q.id=NEW.queue_id AND q.version=NEW.source_version AND q.attempts=1
          AND q.channel='local_test' AND p.proposed_by=NEW.actor_user_id
          AND q.status::text=p.status::text
          AND (q.status='reconcile' OR (q.status='failed' AND NEW.action='repropose'))
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    ) THEN
        RAISE EXCEPTION '对账需要发起人的有效浏览器会话和当前发送版本。' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbound_resolution_guard BEFORE INSERT ON public.outbound_resolution
FOR EACH ROW EXECUTE FUNCTION public.guard_outbound_resolution();
--> statement-breakpoint
ALTER TABLE public.outbound_resolution ENABLE ALWAYS TRIGGER outbound_resolution_guard;
--> statement-breakpoint
CREATE FUNCTION public.reject_outbound_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '外发回执与对账记录只允许追加。' USING ERRCODE='42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outbound_resolution_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.outbound_resolution
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_outbound_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER simulated_email_delivery_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.simulated_email_delivery
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_outbound_receipt_mutation();
--> statement-breakpoint
CREATE TRIGGER simulated_wechat_copy_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.simulated_wechat_copy
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_outbound_receipt_mutation();
--> statement-breakpoint
ALTER TABLE public.outbound_resolution ENABLE ALWAYS TRIGGER outbound_resolution_append_only;
--> statement-breakpoint
ALTER TABLE public.simulated_email_delivery ENABLE ALWAYS TRIGGER simulated_email_delivery_append_only;
--> statement-breakpoint
ALTER TABLE public.simulated_wechat_copy ENABLE ALWAYS TRIGGER simulated_wechat_copy_append_only;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.guard_outbound_message()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $outbound_message$
DECLARE
    approved public.decision%ROWTYPE;
    target public.proposal%ROWTYPE;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.proposal_id,NEW.decision_id,NEW.goal_id,NEW.project_id,NEW.contact_id,NEW.approved_version,NEW.channel,NEW.created_at)
           IS DISTINCT FROM ROW(OLD.id,OLD.proposal_id,OLD.decision_id,OLD.goal_id,OLD.project_id,OLD.contact_id,OLD.approved_version,OLD.channel,OLD.created_at) THEN
            RAISE EXCEPTION '队列的发送编号、审批来源和收件人不能改写。' USING ERRCODE = '42501';
        END IF;
        IF OLD.status <> 'queued' AND ROW(NEW.status,NEW.attempts,NEW.receipt_id,NEW.processed_at)
           IS DISTINCT FROM ROW(OLD.status,OLD.attempts,OLD.receipt_id,OLD.processed_at)
           AND NOT (
               OLD.status='reconcile' AND NEW.attempts=OLD.attempts AND NEW.version=OLD.version+1
               AND EXISTS (
                   SELECT 1 FROM public.outbound_resolution r
                   WHERE r.queue_id=OLD.id AND r.source_version=OLD.version
                     AND ((r.action='confirm_sent' AND NEW.status='done' AND NEW.receipt_id IS NOT NULL)
                       OR (r.action='repropose' AND NEW.status='failed' AND NEW.receipt_id IS NULL))
               )
           ) THEN
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
