CREATE TABLE "m02_schedule" (
	"goal_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"enabled_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "m02_schedule_version_ok" CHECK ("m02_schedule"."version">0)
);
--> statement-breakpoint
ALTER TABLE "m02_schedule" ADD CONSTRAINT "m02_schedule_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "m02_schedule" ADD CONSTRAINT "m02_schedule_enabled_by_app_user_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;