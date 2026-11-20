CREATE TYPE "public"."goal_event_source" AS ENUM('verification', 'review_decision', 'timer', 'document', 'manual');--> statement-breakpoint
CREATE TYPE "public"."goal_event_state" AS ENUM('pending', 'queued', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."verification_wait_state" AS ENUM('waiting', 'queued', 'running', 'finished', 'cancelled');--> statement-breakpoint
CREATE TABLE "goal_direction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"note" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_direction_version_unique" UNIQUE("goal_id","version"),
	CONSTRAINT "goal_direction_note_length" CHECK (length(btrim("goal_direction"."note")) BETWEEN 1 AND 4000),
	CONSTRAINT "goal_direction_version" CHECK ("goal_direction"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "goal_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"source" "goal_event_source" NOT NULL,
	"source_key" varchar(128) NOT NULL,
	"state" "goal_event_state" DEFAULT 'pending' NOT NULL,
	"wake_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "goal_event_source_identity" UNIQUE("source","source_key"),
	CONSTRAINT "goal_event_source_key" CHECK (length(btrim("goal_event"."source_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "goal_wait" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source" "goal_event_source" NOT NULL,
	"source_key" varchar(128) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"due_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_wait" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"call_id" varchar(128),
	"state" "verification_wait_state" DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_link" ADD COLUMN "auto_resume" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goal_direction" ADD CONSTRAINT "goal_direction_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_direction" ADD CONSTRAINT "goal_direction_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_event" ADD CONSTRAINT "goal_event_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_event" ADD CONSTRAINT "goal_event_wake_run_id_run_id_fk" FOREIGN KEY ("wake_run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_wait" ADD CONSTRAINT "goal_wait_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_wait" ADD CONSTRAINT "goal_wait_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD CONSTRAINT "verification_wait_room_id_verification_link_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."verification_link"("room_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD CONSTRAINT "verification_wait_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD CONSTRAINT "verification_wait_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_wait" ADD CONSTRAINT "verification_wait_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_event_pending_idx" ON "goal_event" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "goal_event_goal_idx" ON "goal_event" USING btree ("goal_id","state");--> statement-breakpoint
CREATE INDEX "goal_wait_goal_idx" ON "goal_wait" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_wait_open_per_goal" ON "goal_wait" USING btree ("goal_id") WHERE "goal_wait"."responded_at" IS NULL AND "goal_wait"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "verification_wait_state_idx" ON "verification_wait" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_wait_open_run" ON "verification_wait" USING btree ("run_id") WHERE "verification_wait"."state" IN ('waiting','queued','running');--> statement-breakpoint
CREATE FUNCTION public.reject_goal_direction_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '目标方向记录只允许追加。' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER goal_direction_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.goal_direction
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_goal_direction_mutation();
--> statement-breakpoint
ALTER TABLE public.goal_direction ENABLE ALWAYS TRIGGER goal_direction_append_only;
