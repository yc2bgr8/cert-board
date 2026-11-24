CREATE TABLE "human_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"new_version_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"browser_session_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"path" text NOT NULL,
	"skill_id" varchar(64) NOT NULL,
	"skill_version" varchar(128) NOT NULL,
	"difference" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "human_revision_new_version_id_unique" UNIQUE("new_version_id"),
	CONSTRAINT "human_revision_request_unique" UNIQUE("author_id","request_key"),
	CONSTRAINT "human_revision_source_distinct" CHECK ("human_revision"."source_version_id"<>"human_revision"."new_version_id"),
	CONSTRAINT "human_revision_hash_ok" CHECK ("human_revision"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "human_revision_diff_bounded" CHECK (jsonb_typeof("human_revision"."difference")='object' AND octet_length("human_revision"."difference"::text)<=524288)
);
--> statement-breakpoint
ALTER TABLE "human_revision" ADD CONSTRAINT "human_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_revision" ADD CONSTRAINT "human_revision_review_id_review_card_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."review_card"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_revision" ADD CONSTRAINT "human_revision_source_version_id_workspace_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."workspace_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_revision" ADD CONSTRAINT "human_revision_new_version_id_workspace_version_id_fk" FOREIGN KEY ("new_version_id") REFERENCES "public"."workspace_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_revision" ADD CONSTRAINT "human_revision_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_revision_review_idx" ON "human_revision" USING btree ("workspace_id","review_id","created_at");
--> statement-breakpoint
CREATE FUNCTION public.guard_human_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '人工改稿历史只允许追加。' USING ERRCODE = '55000';
  END IF;
  PERFORM s.id FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
    WHERE s.id=NEW.browser_session_id AND u.id=NEW.author_id AND u.status='active'
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    FOR SHARE OF s,u;
  IF NOT FOUND THEN
    RAISE EXCEPTION '人工改稿需要有效的浏览器会话。' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspace w
    JOIN public.review_card r ON r.id=NEW.review_id AND r.project_id=w.project_id
      AND r.workspace_version_id=NEW.source_version_id
    JOIN public.workspace_version a ON a.id=NEW.source_version_id AND a.workspace_id=w.id
      AND a.author_type='ai'
    JOIN public.workspace_version b ON b.id=NEW.new_version_id AND b.workspace_id=w.id
      AND b.author_type='human' AND b.author_user_id=NEW.author_id
    JOIN public.workspace_file previous ON previous.version_id=a.id AND previous.path=NEW.path
    JOIN public.workspace_file base ON base.version_id=b.parent_version_id AND base.path=NEW.path
      AND base.sha256=previous.sha256 AND base.byte_size=previous.byte_size
      AND base.media_type=previous.media_type
    JOIN public.workspace_file revised ON revised.version_id=b.id AND revised.path=NEW.path
    WHERE w.id=NEW.workspace_id AND w.current_version_id=b.id AND previous.sha256<>revised.sha256
      AND NEW.skill_id=r.skill_id AND NEW.skill_version=r.skill_version
      AND (r.data_level<>'confidential' OR b.data_level='confidential')
  ) THEN
    RAISE EXCEPTION '人工改稿须追溯到同一审核卡的 Agent 原稿。' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER human_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.human_revision
FOR EACH ROW EXECUTE FUNCTION public.guard_human_revision();
