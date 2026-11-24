CREATE TABLE "knowledge_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(16) NOT NULL,
	"code" varchar(80) NOT NULL,
	"version" varchar(14) NOT NULL,
	"content" jsonb NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"author_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"reviewer_id" uuid,
	"review_session_id" uuid,
	"decision_request_key" uuid,
	"reason" varchar(600),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "knowledge_review_version_unique" UNIQUE("kind","code","version"),
	CONSTRAINT "knowledge_review_request_unique" UNIQUE("author_id","request_key"),
	CONSTRAINT "knowledge_review_decision_unique" UNIQUE("reviewer_id","decision_request_key"),
	CONSTRAINT "knowledge_review_kind_ok" CHECK ("knowledge_review"."kind" IN ('rule_pack','template')),
	CONSTRAINT "knowledge_review_content_ok" CHECK (jsonb_typeof("knowledge_review"."content")='object'
      AND ("knowledge_review"."content"->>'code') IS NOT DISTINCT FROM "knowledge_review"."code"
      AND ("knowledge_review"."content"->>'version') IS NOT DISTINCT FROM "knowledge_review"."version"
      AND "knowledge_review"."code" ~ '^[a-z][a-z0-9_]{0,79}$'
      AND "knowledge_review"."version" ~ '^([0-9]{1,4}[.]){2}[0-9]{1,4}$'
      AND "knowledge_review"."content_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "knowledge_review_status_ok" CHECK ((
      "knowledge_review"."status"='pending' AND "knowledge_review"."reviewed_at" IS NULL AND "knowledge_review"."reviewer_id" IS NULL
      AND "knowledge_review"."review_session_id" IS NULL AND "knowledge_review"."decision_request_key" IS NULL AND "knowledge_review"."reason" IS NULL
    ) OR (
      "knowledge_review"."status" IN ('published','rejected') AND "knowledge_review"."reviewed_at" IS NOT NULL AND "knowledge_review"."reviewer_id" IS NOT NULL
      AND "knowledge_review"."review_session_id" IS NOT NULL AND "knowledge_review"."decision_request_key" IS NOT NULL
      AND "knowledge_review"."reviewed_at" >= "knowledge_review"."created_at"
      AND (("knowledge_review"."status"='published' AND "knowledge_review"."reason" IS NULL) OR
        ("knowledge_review"."status"='rejected' AND "knowledge_review"."reason" IS NOT NULL AND length(btrim("knowledge_review"."reason"))>0))
    ))
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_code_unique" UNIQUE("code"),
	CONSTRAINT "template_code_ok" CHECK ("template"."code" ~ '^[a-z][a-z0-9_]{0,79}$')
);
--> statement-breakpoint
CREATE TABLE "template_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" varchar(14) NOT NULL,
	"content" jsonb NOT NULL,
	"review_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_version_review_id_unique" UNIQUE("review_id"),
	CONSTRAINT "template_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "template_version_content_ok" CHECK (jsonb_typeof("template_version"."content")='object'
      AND ("template_version"."content"->>'version') IS NOT DISTINCT FROM "template_version"."version"
      AND "template_version"."version" ~ '^([0-9]{1,4}[.]){2}[0-9]{1,4}$')
);
--> statement-breakpoint
ALTER TABLE "rule_pack_version" ADD COLUMN "review_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_review" ADD CONSTRAINT "knowledge_review_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_review" ADD CONSTRAINT "knowledge_review_reviewer_id_app_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_version" ADD CONSTRAINT "template_version_review_id_knowledge_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."knowledge_review"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_review_status_created_idx" ON "knowledge_review" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "rule_pack_version" ADD CONSTRAINT "rule_pack_version_review_id_knowledge_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."knowledge_review"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_pack_version" ADD CONSTRAINT "rule_pack_version_review_id_unique" UNIQUE("review_id");
--> statement-breakpoint
CREATE FUNCTION public.guard_knowledge_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  decision_fields constant text[] := ARRAY[
    'status', 'reviewer_id', 'review_session_id', 'decision_request_key', 'reason', 'reviewed_at'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NOT EXISTS (
      SELECT 1 FROM public.app_user u WHERE u.id = NEW.author_id
        AND u.status = 'active' AND u.is_management
    ) THEN
      RAISE EXCEPTION '只有系统维护人员可以登记知识草稿。' USING ERRCODE = '23514';
    END IF;
    IF COALESCE(NEW.content->>'dataLevel', '') NOT IN ('internal','confidential')
      OR NEW.version !~ '^(0|[1-9][0-9]{0,3})([.](0|[1-9][0-9]{0,3})){2}$' THEN
      RAISE EXCEPTION '知识草稿须明确密级和规范的版本号。' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' OR OLD.status <> 'pending' OR NEW.status NOT IN ('published','rejected')
      OR (to_jsonb(NEW) - decision_fields) IS DISTINCT FROM (to_jsonb(OLD) - decision_fields) THEN
    RAISE EXCEPTION '知识审核记录只能作出一次决定。' USING ERRCODE = '55000';
  END IF;

  PERFORM s.id FROM public.web_session s JOIN public.app_user u ON u.id = s.user_id
    WHERE s.id = NEW.review_session_id AND u.id = NEW.reviewer_id
      AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.status = 'active'
    FOR SHARE OF s, u;
  IF NOT FOUND THEN
    RAISE EXCEPTION '知识审核需要有效的浏览器会话。' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER knowledge_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.knowledge_review
FOR EACH ROW EXECUTE FUNCTION public.guard_knowledge_review();
--> statement-breakpoint
CREATE FUNCTION public.guard_reviewed_knowledge_release()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rule_pack_version' THEN
    IF NEW.publication = 'development' AND NEW.review_id IS NULL THEN
      RETURN NEW;
    END IF;
    IF NEW.publication = 'published' AND EXISTS (
      SELECT 1 FROM public.knowledge_review r
      JOIN public.rule_pack p ON p.id = NEW.pack_id AND p.code = r.code
        AND p.jurisdiction = r.content->>'jurisdiction'
      WHERE r.id = NEW.review_id AND r.status = 'published' AND r.kind = 'rule_pack'
        AND r.version = NEW.version AND r.content = NEW.content AND r.reviewer_id = NEW.published_by
        AND r.reviewed_at <= NEW.published_at
    ) THEN
      RETURN NEW;
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.knowledge_review r
    JOIN public.template t ON t.id = NEW.template_id AND t.code = r.code
    WHERE r.id = NEW.review_id AND r.status = 'published' AND r.kind = 'template'
      AND r.version = NEW.version AND r.content = NEW.content AND r.reviewed_at <= NEW.published_at
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '发布内容须与已通过的知识审核卡一致。' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rule_pack_review_required BEFORE INSERT ON public.rule_pack_version
FOR EACH ROW EXECUTE FUNCTION public.guard_reviewed_knowledge_release();
--> statement-breakpoint
CREATE TRIGGER template_review_required BEFORE INSERT ON public.template_version
FOR EACH ROW EXECUTE FUNCTION public.guard_reviewed_knowledge_release();
--> statement-breakpoint
CREATE TRIGGER template_version_immutable BEFORE UPDATE OR DELETE ON public.template_version
FOR EACH ROW EXECUTE FUNCTION public.reject_knowledge_history_change();
--> statement-breakpoint
CREATE TRIGGER template_code_immutable BEFORE UPDATE OR DELETE ON public.template
FOR EACH ROW EXECUTE FUNCTION public.reject_knowledge_history_change();
--> statement-breakpoint
CREATE FUNCTION public.require_knowledge_release_for_published_review()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'rule_pack' AND EXISTS (
    SELECT 1 FROM public.rule_pack_version WHERE review_id = NEW.id
  ) THEN
    RETURN NULL;
  END IF;
  IF NEW.kind = 'template' AND EXISTS (
    SELECT 1 FROM public.template_version WHERE review_id = NEW.id
  ) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '审核通过和知识版本发布须在同一事务内完成。' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER knowledge_review_release_required AFTER UPDATE ON public.knowledge_review
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'published')
EXECUTE FUNCTION public.require_knowledge_release_for_published_review();
