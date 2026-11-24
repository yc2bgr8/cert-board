CREATE TABLE "human_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"message_id" uuid,
	"review_id" uuid,
	"user_id" uuid NOT NULL,
	"browser_session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"rating" varchar(10) NOT NULL,
	"reason" varchar(600),
	"skills" jsonb NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_feedback_request_unique" UNIQUE("user_id","request_key"),
	CONSTRAINT "human_feedback_target_required" CHECK (num_nonnulls("human_feedback"."message_id","human_feedback"."review_id")=1),
	CONSTRAINT "human_feedback_rating_ok" CHECK (("human_feedback"."rating"='helpful' AND "human_feedback"."reason" IS NULL) OR
        ("human_feedback"."rating"='unhelpful' AND ("human_feedback"."reason" IS NULL OR btrim("human_feedback"."reason") <> ''))),
	CONSTRAINT "human_feedback_hash_ok" CHECK ("human_feedback"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "human_feedback_skills_ok" CHECK (jsonb_typeof("human_feedback"."skills")='array' AND jsonb_array_length("human_feedback"."skills")<=16)
);
--> statement-breakpoint
ALTER TABLE "human_feedback" ADD CONSTRAINT "human_feedback_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_feedback" ADD CONSTRAINT "human_feedback_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_feedback" ADD CONSTRAINT "human_feedback_message_id_conversation_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_feedback" ADD CONSTRAINT "human_feedback_review_id_review_card_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."review_card"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_feedback" ADD CONSTRAINT "human_feedback_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_feedback_conversation_user_idx" ON "human_feedback" USING btree ("conversation_id","user_id","created_at");
--> statement-breakpoint
CREATE FUNCTION public.guard_human_feedback()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '人工反馈历史只允许追加。' USING ERRCODE = '55000';
  END IF;
  PERFORM s.id FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
    WHERE s.id=NEW.browser_session_id AND u.id=NEW.user_id AND u.status='active'
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    FOR SHARE OF s,u;
  IF NOT FOUND THEN
    RAISE EXCEPTION '人工反馈需要有效的浏览器会话。' USING ERRCODE = '23514';
  END IF;
  IF NEW.data_level NOT IN ('internal','confidential') OR
      (NEW.reason IS NOT NULL AND NEW.data_level <> 'confidential') THEN
    RAISE EXCEPTION '人工反馈的密级无效。' USING ERRCODE = '23514';
  END IF;
  IF NEW.message_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.conversation_message m WHERE m.id=NEW.message_id
      AND m.run_id=NEW.run_id AND m.conversation_id=NEW.conversation_id
      AND m.message_json->>'role'='assistant' AND jsonb_typeof(m.message_json->'content')='string'
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.review_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.review_card r WHERE r.id=NEW.review_id
      AND r.run_id=NEW.run_id AND r.conversation_id=NEW.conversation_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '人工反馈的目标不属于该对话运行。' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER human_feedback_guard BEFORE INSERT OR UPDATE OR DELETE ON public.human_feedback
FOR EACH ROW EXECUTE FUNCTION public.guard_human_feedback();
