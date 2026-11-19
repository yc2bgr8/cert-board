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
--> statement-breakpoint
CREATE FUNCTION notify_verification_link_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'verification_link' THEN
    source_id := NEW.conversation_id;
  ELSE
    SELECT conversation_id INTO source_id FROM verification_link WHERE room_id = NEW.id;
  END IF;

  PERFORM pg_notify(
    'cert_board_verification_link_change',
    json_build_object('userId', user_id, 'shared', project_id IS NOT NULL)::text
  ) FROM conversation WHERE id = source_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verification_link_created
AFTER INSERT ON verification_link FOR EACH ROW EXECUTE FUNCTION notify_verification_link_change();
--> statement-breakpoint
CREATE TRIGGER verification_link_state_changed
AFTER UPDATE OF state ON external_model_conversation FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION notify_verification_link_change();
