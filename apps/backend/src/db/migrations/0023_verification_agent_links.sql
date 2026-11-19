CREATE TABLE "verification_link" (
	"room_id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(12) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"review_id" uuid,
	"requester" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_link_kind" CHECK (("verification_link"."kind"='agent' AND "verification_link"."review_id" IS NULL) OR ("verification_link"."kind"='review' AND "verification_link"."review_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "verification_link" ADD CONSTRAINT "verification_link_room_id_external_model_conversation_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."external_model_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_link" ADD CONSTRAINT "verification_link_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_link" ADD CONSTRAINT "verification_link_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_link" ADD CONSTRAINT "verification_link_review_id_review_card_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."review_card"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_link" ADD CONSTRAINT "verification_link_requester_app_user_id_fk" FOREIGN KEY ("requester") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_link_conversation_idx" ON "verification_link" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_link_review_idx" ON "verification_link" USING btree ("review_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_link_run_idx" ON "verification_link" USING btree ("run_id");