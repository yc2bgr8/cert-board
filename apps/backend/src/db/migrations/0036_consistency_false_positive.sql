CREATE TABLE "rule_false_positive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"rule_id" varchar(8) NOT NULL,
	"rule_version" varchar(24) NOT NULL,
	"finding_key" varchar(64) NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"handling" varchar(1000),
	"reported_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_false_positive_finding_unique" UNIQUE("document_version_id","rule_id","rule_version","finding_key"),
	CONSTRAINT "rule_false_positive_id_valid" CHECK ("rule_false_positive"."rule_id" ~ '^R[0-7]$'),
	CONSTRAINT "rule_false_positive_version_set" CHECK (length(btrim("rule_false_positive"."rule_version")) > 0),
	CONSTRAINT "rule_false_positive_key_format" CHECK ("rule_false_positive"."finding_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "rule_false_positive_reason_set" CHECK (length(btrim("rule_false_positive"."reason")) > 0),
	CONSTRAINT "rule_false_positive_handling_set" CHECK ("rule_false_positive"."handling" IS NULL OR length(btrim("rule_false_positive"."handling")) > 0)
);
--> statement-breakpoint
ALTER TABLE "rule_false_positive" ADD CONSTRAINT "rule_false_positive_document_version_id_document_version_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_version"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rule_false_positive" ADD CONSTRAINT "rule_false_positive_reported_by_app_user_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;
