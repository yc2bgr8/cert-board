CREATE TABLE "heartbeat" (
	"service" varchar(80) PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timer_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"notice" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_status_ok" CHECK ("notification"."status" IN ('pending','acknowledged','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "timer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"profile" varchar(20) NOT NULL,
	"calculation" jsonb NOT NULL,
	"due_on" date NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"jurisdiction_tz" varchar(100) NOT NULL,
	"state" varchar(20) DEFAULT 'active' NOT NULL,
	"last_stage" varchar(12),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timer_goal_id_unique" UNIQUE("goal_id"),
	CONSTRAINT "timer_profile_ok" CHECK ("timer"."profile" IN ('certificate','milestone')),
	CONSTRAINT "timer_state_ok" CHECK ("timer"."state" IN ('active','cancelled')),
	CONSTRAINT "timer_last_stage_ok" CHECK ("timer"."last_stage" IN ('D-90','D-60','D-30','D-7','D-1','D-0','OVERDUE')),
	CONSTRAINT "timer_title_not_blank" CHECK (length(btrim("timer"."title"))>0),
	CONSTRAINT "timer_positive_version" CHECK ("timer"."version">0)
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_timer_id_timer_id_fk" FOREIGN KEY ("timer_id") REFERENCES "public"."timer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_id_app_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer" ADD CONSTRAINT "timer_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer" ADD CONSTRAINT "timer_goal_project_fk" FOREIGN KEY ("goal_id","project_id") REFERENCES "public"."goal"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_pending_timer_recipient" ON "notification" USING btree ("timer_id","recipient_id") WHERE "notification"."status"='pending';--> statement-breakpoint
CREATE INDEX "notification_recipient_pending_idx" ON "notification" USING btree ("recipient_id","updated_at","id") WHERE "notification"."status"='pending';--> statement-breakpoint
CREATE INDEX "timer_active_due_idx" ON "timer" USING btree ("due_at","id") WHERE "timer"."state"='active';