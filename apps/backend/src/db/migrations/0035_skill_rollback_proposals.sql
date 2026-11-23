CREATE TABLE "skill_rollback_policy" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"minimum_cards" integer NOT NULL,
	"rejection_percent" integer NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "skill_rollback_policy_id" CHECK ("skill_rollback_policy"."id"='default'),
	CONSTRAINT "skill_rollback_policy_count" CHECK ("skill_rollback_policy"."minimum_cards" BETWEEN 1 AND 100),
	CONSTRAINT "skill_rollback_policy_percent" CHECK ("skill_rollback_policy"."rejection_percent" BETWEEN 1 AND 100),
	CONSTRAINT "skill_rollback_policy_revision" CHECK ("skill_rollback_policy"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "skill_rollback_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" varchar(3) NOT NULL,
	"active_version_id" uuid NOT NULL,
	"target_version_id" uuid,
	"release_revision" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" varchar(12) NOT NULL,
	"decided_by" uuid,
	"session_id" uuid,
	"request_key" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "skill_rollback_request_key" UNIQUE("request_key"),
	CONSTRAINT "skill_rollback_status" CHECK ("skill_rollback_proposal"."status" IN ('pending','notice','approved','dismissed','expired')),
	CONSTRAINT "skill_rollback_revision" CHECK ("skill_rollback_proposal"."release_revision">0),
	CONSTRAINT "skill_rollback_target" CHECK (("skill_rollback_proposal"."status" NOT IN ('pending','approved') OR "skill_rollback_proposal"."target_version_id" IS NOT NULL)
    AND ("skill_rollback_proposal"."status"<>'notice' OR "skill_rollback_proposal"."target_version_id" IS NULL)),
	CONSTRAINT "skill_rollback_audit_fields" CHECK ((("skill_rollback_proposal"."status" IN ('approved','dismissed'))
    AND "skill_rollback_proposal"."decided_at" IS NOT NULL AND "skill_rollback_proposal"."session_id" IS NOT NULL AND "skill_rollback_proposal"."decided_by" IS NOT NULL AND "skill_rollback_proposal"."request_key" IS NOT NULL)
    OR (("skill_rollback_proposal"."status" NOT IN ('approved','dismissed'))
    AND "skill_rollback_proposal"."decided_at" IS NULL AND "skill_rollback_proposal"."session_id" IS NULL AND "skill_rollback_proposal"."decided_by" IS NULL AND "skill_rollback_proposal"."request_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "skill_rollback_proposal" ADD CONSTRAINT "skill_rollback_proposal_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_rollback_proposal" ADD CONSTRAINT "skill_rollback_active_version" FOREIGN KEY ("skill_id","active_version_id") REFERENCES "public"."skill_version"("skill_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_rollback_proposal" ADD CONSTRAINT "skill_rollback_target_version" FOREIGN KEY ("skill_id","target_version_id") REFERENCES "public"."skill_version"("skill_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_rollback_proposal" ADD CONSTRAINT "skill_rollback_browser_session" FOREIGN KEY ("session_id","decided_by") REFERENCES "public"."web_session"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_rollback_open_per_skill" ON "skill_rollback_proposal" USING btree ("skill_id") WHERE "skill_rollback_proposal"."status" IN ('pending','notice');--> statement-breakpoint
CREATE INDEX "skill_rollback_version_history" ON "skill_rollback_proposal" USING btree ("skill_id","active_version_id","decided_at");--> statement-breakpoint
CREATE INDEX "review_card_skill_statistics_idx" ON "review_card" USING btree ("skill_id","skill_version","decided_at") WHERE "review_card"."status" IN ('approved','rejected');
