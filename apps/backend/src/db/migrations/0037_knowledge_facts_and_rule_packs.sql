CREATE TABLE "fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"subject" varchar(120) NOT NULL,
	"field" varchar(80) NOT NULL,
	"value" jsonb NOT NULL,
	"unit" varchar(32),
	"candidate_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"revision" integer NOT NULL,
	"replaces_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"locked" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid NOT NULL,
	CONSTRAINT "fact_candidate_id_unique" UNIQUE("candidate_id"),
	CONSTRAINT "fact_key_revision_unique" UNIQUE("project_id","subject","field","revision"),
	CONSTRAINT "fact_scope_unique" UNIQUE("id","project_id","subject","field"),
	CONSTRAINT "fact_revision_ok" CHECK (("fact"."revision" = 1 AND "fact"."replaces_id" IS NULL) OR ("fact"."revision" > 1 AND "fact"."replaces_id" IS NOT NULL AND "fact"."replaces_id" <> "fact"."id")),
	CONSTRAINT "fact_validity_ok" CHECK ("fact"."valid_until" IS NULL OR "fact"."valid_until" > "fact"."valid_from"),
	CONSTRAINT "fact_level_ok" CHECK ("fact"."data_level" IN ('internal','confidential')),
	CONSTRAINT "fact_value_ok" CHECK (jsonb_typeof("fact"."value") IN ('string','number','boolean') AND (jsonb_typeof("fact"."value") <> 'number' OR NULLIF(btrim("fact"."unit"),'') IS NOT NULL)),
	CONSTRAINT "fact_evidence_ok" CHECK (jsonb_typeof("fact"."evidence") = 'object' AND ("fact"."evidence"->>'documentId') IS NOT DISTINCT FROM "fact"."source_document_id"::text)
);
--> statement-breakpoint
CREATE TABLE "fact_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"proposal_run_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"subject" varchar(120) NOT NULL,
	"field" varchar(80) NOT NULL,
	"value" jsonb NOT NULL,
	"unit" varchar(32),
	"source_document_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"base_revision" integer NOT NULL,
	"due_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" varchar(600),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_candidate_scope_unique" UNIQUE("id","project_id","subject","field"),
	CONSTRAINT "fact_candidate_status_ok" CHECK ("fact_candidate"."status" IN ('pending','confirmed','rewritten','rejected','cancelled')),
	CONSTRAINT "fact_candidate_revision_ok" CHECK ("fact_candidate"."base_revision" >= 0 AND "fact_candidate"."version" > 0),
	CONSTRAINT "fact_candidate_level_ok" CHECK ("fact_candidate"."data_level" IN ('internal','confidential')),
	CONSTRAINT "fact_candidate_key_ok" CHECK (length(btrim("fact_candidate"."subject")) > 0 AND "fact_candidate"."field" ~ '^[a-z][a-z0-9_]{0,79}$'),
	CONSTRAINT "fact_candidate_evidence_ok" CHECK (jsonb_typeof("fact_candidate"."evidence") = 'object' AND ("fact_candidate"."evidence"->>'documentId') IS NOT DISTINCT FROM "fact_candidate"."source_document_id"::text),
	CONSTRAINT "fact_candidate_value_ok" CHECK (jsonb_typeof("fact_candidate"."value") IN ('string','number','boolean') AND (jsonb_typeof("fact_candidate"."value") <> 'number' OR NULLIF(btrim("fact_candidate"."unit"),'') IS NOT NULL)),
	CONSTRAINT "fact_candidate_decision_ok" CHECK (("fact_candidate"."status" IN ('pending','cancelled') AND "fact_candidate"."decided_by" IS NULL AND "fact_candidate"."decided_at" IS NULL) OR ("fact_candidate"."status" IN ('confirmed','rewritten','rejected') AND "fact_candidate"."decided_by" IS NOT NULL AND "fact_candidate"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "rule_pack" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(80) NOT NULL,
	"jurisdiction" varchar(2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_pack_code_unique" UNIQUE("code"),
	CONSTRAINT "rule_pack_code_ok" CHECK ("rule_pack"."code" ~ '^[a-z][a-z0-9_]{0,79}$'),
	CONSTRAINT "rule_pack_jurisdiction_ok" CHECK ("rule_pack"."jurisdiction" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "rule_pack_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"version" varchar(14) NOT NULL,
	"content" jsonb NOT NULL,
	"publication" varchar(16) NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_pack_version_unique" UNIQUE("pack_id","version"),
	CONSTRAINT "rule_pack_version_scope_unique" UNIQUE("id","pack_id"),
	CONSTRAINT "rule_pack_version_number_ok" CHECK ("rule_pack_version"."version" ~ '^([0-9]{1,4}[.]){2}[0-9]{1,4}$'),
	CONSTRAINT "rule_pack_version_publication_ok" CHECK (("rule_pack_version"."publication" = 'development' AND "rule_pack_version"."published_by" IS NULL) OR ("rule_pack_version"."publication" = 'published' AND "rule_pack_version"."published_by" IS NOT NULL)),
	CONSTRAINT "rule_pack_version_content_ok" CHECK (jsonb_typeof("rule_pack_version"."content") = 'object' AND "rule_pack_version"."content"->>'version' = "rule_pack_version"."version")
);
--> statement-breakpoint
CREATE TABLE "run_rule_pack" (
	"run_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_rule_pack_run_id_pack_id_pk" PRIMARY KEY("run_id","pack_id")
);
--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_source_document_id_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_confirmed_by_app_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_candidate_scope_fk" FOREIGN KEY ("candidate_id","project_id","subject","field") REFERENCES "public"."fact_candidate"("id","project_id","subject","field") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_replaces_scope_fk" FOREIGN KEY ("replaces_id","project_id","subject","field") REFERENCES "public"."fact"("id","project_id","subject","field") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidate" ADD CONSTRAINT "fact_candidate_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidate" ADD CONSTRAINT "fact_candidate_proposal_run_id_run_id_fk" FOREIGN KEY ("proposal_run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidate" ADD CONSTRAINT "fact_candidate_proposed_by_app_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidate" ADD CONSTRAINT "fact_candidate_source_document_id_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_candidate" ADD CONSTRAINT "fact_candidate_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_pack_version" ADD CONSTRAINT "rule_pack_version_pack_id_rule_pack_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."rule_pack"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_pack_version" ADD CONSTRAINT "rule_pack_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_rule_pack" ADD CONSTRAINT "run_rule_pack_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_rule_pack" ADD CONSTRAINT "run_rule_pack_version_scope_fk" FOREIGN KEY ("version_id","pack_id") REFERENCES "public"."rule_pack_version"("id","pack_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_candidate_pending_idx" ON "fact_candidate" USING btree ("project_id","created_at","id") WHERE "fact_candidate"."status" = 'pending';
--> statement-breakpoint
-- 版本与运行凭据保留原记录。待处理期间可设期限，决定或撤销仅记录一次。
--> statement-breakpoint
CREATE FUNCTION public.reject_knowledge_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '已记录的知识版本不得修改或删除。' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_immutable BEFORE UPDATE OR DELETE ON public.fact
FOR EACH ROW EXECUTE FUNCTION public.reject_knowledge_history_change();
--> statement-breakpoint
CREATE TRIGGER rule_pack_version_immutable BEFORE UPDATE OR DELETE ON public.rule_pack_version
FOR EACH ROW EXECUTE FUNCTION public.reject_knowledge_history_change();
--> statement-breakpoint
CREATE TRIGGER run_rule_pack_immutable BEFORE UPDATE OR DELETE ON public.run_rule_pack
FOR EACH ROW EXECUTE FUNCTION public.reject_knowledge_history_change();
--> statement-breakpoint
CREATE TRIGGER fact_candidate_keep_history BEFORE DELETE ON public.fact_candidate
FOR EACH ROW EXECUTE FUNCTION public.reject_knowledge_history_change();
--> statement-breakpoint
CREATE FUNCTION public.guard_fact_candidate_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.version <> OLD.version + 1
    OR (to_jsonb(NEW) - ARRAY['status','version','decided_by','decided_at','decision_reason','due_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','version','decided_by','decided_at','decision_reason','due_at','updated_at'])
    OR (NEW.status = 'pending' AND (NEW.due_at IS NOT DISTINCT FROM OLD.due_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason))
    OR (NEW.status <> 'pending' AND NEW.due_at IS DISTINCT FROM OLD.due_at)
  THEN
    RAISE EXCEPTION '候选只允许在待处理时设置期限、记录决定或撤销。' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_candidate_transition BEFORE UPDATE ON public.fact_candidate
FOR EACH ROW EXECUTE FUNCTION public.guard_fact_candidate_transition();
--> statement-breakpoint
CREATE FUNCTION public.guard_confirmed_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.document d WHERE d.id=NEW.source_document_id AND d.project_id=NEW.project_id AND NOT d.voided) THEN
    RAISE EXCEPTION '事实的实际证据须来自本项目有效资料。' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.fact_candidate c
    WHERE c.id=NEW.candidate_id AND c.project_id=NEW.project_id
      AND c.subject=NEW.subject AND c.field=NEW.field
      AND c.status IN ('confirmed','rewritten') AND c.decided_by=NEW.confirmed_by
      AND c.base_revision=NEW.revision-1
      AND (c.status='rewritten' OR (c.evidence=NEW.evidence AND c.value=NEW.value AND c.unit IS NOT DISTINCT FROM NEW.unit))
  ) THEN
    RAISE EXCEPTION '事实必须来自人工确认的对应候选。' USING ERRCODE = '23514';
  END IF;
  IF NEW.replaces_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.fact previous JOIN public.cert_project project ON project.id=previous.project_id
    WHERE previous.id=NEW.replaces_id AND previous.project_id=NEW.project_id
      AND previous.subject=NEW.subject AND previous.field=NEW.field AND previous.revision=NEW.revision-1
      AND (NOT previous.locked OR project.owner_user_id=NEW.confirmed_by)
  ) THEN
    RAISE EXCEPTION '事实修订必须关联同一字段的上一版本，锁定事实须由负责人处理。' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fact_requires_confirmed_candidate BEFORE INSERT ON public.fact
FOR EACH ROW EXECUTE FUNCTION public.guard_confirmed_fact();
