CREATE TABLE "model_gateway_failure" (
	"request_key" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_failure_kind_ok" CHECK ("model_gateway_failure"."kind" IN ('error','timeout','credits'))
);
--> statement-breakpoint
CREATE TABLE "ops_alert" (
	"key" varchar(40) PRIMARY KEY NOT NULL,
	"level" varchar(12) NOT NULL,
	"detail" varchar(400) NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ops_alert_key_ok" CHECK ("ops_alert"."key" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "ops_alert_level_ok" CHECK ("ops_alert"."level" IN ('warning','critical')),
	CONSTRAINT "ops_alert_detail_present" CHECK (length(btrim("ops_alert"."detail"))>0),
	CONSTRAINT "ops_alert_times_ok" CHECK ("ops_alert"."opened_at" <= "ops_alert"."last_seen_at"
      AND ("ops_alert"."resolved_at" IS NULL OR "ops_alert"."last_seen_at" <= "ops_alert"."resolved_at"))
);
--> statement-breakpoint
ALTER TABLE "model_gateway_failure" ADD CONSTRAINT "model_gateway_failure_request_key_usage_ledger_request_key_fk" FOREIGN KEY ("request_key") REFERENCES "public"."usage_ledger"("request_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_gateway_failure_recent_idx" ON "model_gateway_failure" USING btree ("observed_at");