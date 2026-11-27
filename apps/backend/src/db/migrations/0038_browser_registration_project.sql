CREATE TABLE "browser_project_creation" (
	"user_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"project_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_project_creation_user_id_request_key_pk" PRIMARY KEY("user_id","request_key"),
	CONSTRAINT "browser_project_creation_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "browser_project_creation" ADD CONSTRAINT "browser_project_creation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_project_creation" ADD CONSTRAINT "browser_project_creation_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_project_creation" ADD CONSTRAINT "browser_project_creation_goal_project_fk" FOREIGN KEY ("goal_id","project_id") REFERENCES "public"."goal"("id","project_id") ON DELETE restrict ON UPDATE no action;