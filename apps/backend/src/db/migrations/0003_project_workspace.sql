-- PR-07：版本、私有工作副本及归属约束。PR-08 的最小对话表为工作副本归属前置。
CREATE TYPE "public"."conversation_mode" AS ENUM('read_only', 'execute');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."workspace_author_type" AS ENUM('human', 'ai', 'system');--> statement-breakpoint
-- 组合外键的被引用约束必须先建立；不改写已合并的 0001。
ALTER TABLE "goal" ADD CONSTRAINT "goal_id_project_unique" UNIQUE("id","project_id");--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"user_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"mode" "conversation_mode" DEFAULT 'execute' NOT NULL,
	"max_data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"goal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "conversation_owner_project_unique" UNIQUE("id","user_id","project_id"),
	CONSTRAINT "conversation_goal_requires_project" CHECK ("conversation"."goal_id" IS NULL OR "conversation"."project_id" IS NOT NULL),
	CONSTRAINT "conversation_title_not_blank" CHECK (length(btrim("conversation"."title")) > 0),
	CONSTRAINT "conversation_data_level_internal" CHECK ("conversation"."max_data_level" IN ('internal', 'confidential')),
	CONSTRAINT "conversation_version_positive" CHECK ("conversation"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"current_version_id" uuid,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "workspace_id_project_unique" UNIQUE("id","project_id"),
	CONSTRAINT "workspace_data_level_internal" CHECK ("workspace"."data_level" IN ('internal', 'confidential')),
	CONSTRAINT "workspace_version_positive" CHECK ("workspace"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"data_level" "document_data_level" DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_draft_conversation_id_unique" UNIQUE("conversation_id"),
	CONSTRAINT "workspace_draft_data_level_internal" CHECK ("workspace_draft"."data_level" IN ('internal', 'confidential')),
	CONSTRAINT "workspace_draft_version_positive" CHECK ("workspace_draft"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_draft_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"path" varchar(512) NOT NULL,
	"sha256" varchar(64),
	"byte_size" bigint,
	"data_level" "document_data_level" NOT NULL,
	"media_type" varchar(255) NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_draft_file_path_unique" UNIQUE("draft_id","path"),
	CONSTRAINT "workspace_draft_file_path_nfc" CHECK (length(btrim("workspace_draft_file"."path")) > 0 AND "workspace_draft_file"."path" = normalize("workspace_draft_file"."path", NFC)),
	CONSTRAINT "workspace_draft_file_tombstone" CHECK (("workspace_draft_file"."is_deleted" AND "workspace_draft_file"."sha256" IS NULL AND "workspace_draft_file"."byte_size" IS NULL) OR (NOT "workspace_draft_file"."is_deleted" AND "workspace_draft_file"."sha256" IS NOT NULL AND "workspace_draft_file"."byte_size" IS NOT NULL)),
	CONSTRAINT "workspace_draft_file_hash_format" CHECK ("workspace_draft_file"."sha256" IS NULL OR "workspace_draft_file"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_draft_file_size_safe" CHECK ("workspace_draft_file"."byte_size" IS NULL OR ("workspace_draft_file"."byte_size" >= 0 AND "workspace_draft_file"."byte_size" <= 9007199254740991)),
	CONSTRAINT "workspace_draft_file_media_type_not_blank" CHECK (length(btrim("workspace_draft_file"."media_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"path" varchar(512) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"media_type" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_file_path_unique" UNIQUE("version_id","path"),
	CONSTRAINT "workspace_file_path_nfc" CHECK (length(btrim("workspace_file"."path")) > 0 AND "workspace_file"."path" = normalize("workspace_file"."path", NFC)),
	CONSTRAINT "workspace_file_hash_format" CHECK ("workspace_file"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_file_size_safe" CHECK ("workspace_file"."byte_size" >= 0 AND "workspace_file"."byte_size" <= 9007199254740991),
	CONSTRAINT "workspace_file_media_type_not_blank" CHECK (length(btrim("workspace_file"."media_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"parent_version_id" uuid,
	"author_user_id" uuid,
	"author_type" "workspace_author_type" NOT NULL,
	"summary" text NOT NULL,
	"data_level" "document_data_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_version_identity_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_version_project_unique" UNIQUE("project_id","id"),
	CONSTRAINT "workspace_version_number_unique" UNIQUE("workspace_id","number"),
	CONSTRAINT "workspace_version_number_positive" CHECK ("workspace_version"."number" > 0),
	CONSTRAINT "workspace_version_parent_not_self" CHECK ("workspace_version"."parent_version_id" IS NULL OR "workspace_version"."parent_version_id" <> "workspace_version"."id"),
	CONSTRAINT "workspace_version_summary_not_blank" CHECK (length(btrim("workspace_version"."summary")) > 0),
	CONSTRAINT "workspace_version_author_present" CHECK ("workspace_version"."author_type" = 'system' OR "workspace_version"."author_user_id" IS NOT NULL),
	CONSTRAINT "workspace_version_data_level_internal" CHECK ("workspace_version"."data_level" IN ('internal', 'confidential'))
);
--> statement-breakpoint
ALTER TABLE "submission_snapshot" ADD COLUMN "workspace_version_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_goal_project_fk" FOREIGN KEY ("goal_id","project_id") REFERENCES "public"."goal"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_project_id_cert_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cert_project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_current_version_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."workspace_version"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_draft" ADD CONSTRAINT "workspace_draft_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."workspace"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_draft" ADD CONSTRAINT "workspace_draft_conversation_owner_project_fk" FOREIGN KEY ("conversation_id","owner_user_id","project_id") REFERENCES "public"."conversation"("id","user_id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_draft" ADD CONSTRAINT "workspace_draft_base_version_fk" FOREIGN KEY ("workspace_id","base_version_id") REFERENCES "public"."workspace_version"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_draft_file" ADD CONSTRAINT "workspace_draft_file_draft_id_workspace_draft_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."workspace_draft"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_version_id_workspace_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workspace_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_version" ADD CONSTRAINT "workspace_version_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_version" ADD CONSTRAINT "workspace_version_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."workspace"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_version" ADD CONSTRAINT "workspace_version_parent_workspace_fk" FOREIGN KEY ("workspace_id","parent_version_id") REFERENCES "public"."workspace_version"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_user_project_idx" ON "conversation" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "workspace_draft_owner_idx" ON "workspace_draft" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "workspace_draft_file_draft_idx" ON "workspace_draft_file" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "workspace_file_version_idx" ON "workspace_file" USING btree ("version_id");--> statement-breakpoint
ALTER TABLE "submission_snapshot" ADD CONSTRAINT "submission_snapshot_workspace_project_fk" FOREIGN KEY ("project_id","workspace_version_id") REFERENCES "public"."workspace_version"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- 版本和已提交文件不可改写或删除，恢复只能建立一个新版本。
CREATE FUNCTION public.reject_workspace_version_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $immutable_workspace$
BEGIN
    RAISE EXCEPTION '工作区历史版本不能修改、删除或清空，请建立新版本。' USING ERRCODE = '42501';
END;
$immutable_workspace$;
--> statement-breakpoint
CREATE TRIGGER workspace_version_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.workspace_version
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_workspace_version_mutation();
--> statement-breakpoint
ALTER TABLE public.workspace_version ENABLE ALWAYS TRIGGER workspace_version_immutable;
--> statement-breakpoint
CREATE TRIGGER workspace_file_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.workspace_file
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_workspace_version_mutation();
--> statement-breakpoint
ALTER TABLE public.workspace_file ENABLE ALWAYS TRIGGER workspace_file_immutable;
--> statement-breakpoint

CREATE FUNCTION public.guard_conversation_data_level()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $conversation_level$
BEGIN
    IF NEW.max_data_level < OLD.max_data_level THEN
        RAISE EXCEPTION '对话已接触的资料级别不能降低，请保持当前级别。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$conversation_level$;
--> statement-breakpoint
CREATE TRIGGER conversation_data_level_monotonic BEFORE UPDATE ON public.conversation
FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_data_level();
--> statement-breakpoint
ALTER TABLE public.conversation ENABLE ALWAYS TRIGGER conversation_data_level_monotonic;
--> statement-breakpoint

CREATE FUNCTION public.guard_workspace_state()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $workspace_state$
DECLARE
    previous_number integer;
    next_number integer;
    next_level public.document_data_level;
BEGIN
    IF NEW.data_level < OLD.data_level THEN
        RAISE EXCEPTION '工作区已接触的资料级别不能降低。' USING ERRCODE = '42501';
    END IF;
    IF OLD.current_version_id IS NOT NULL AND NEW.current_version_id IS NULL THEN
        RAISE EXCEPTION '已初始化的工作区不能清除当前版本，请建立新版本。' USING ERRCODE = '42501';
    END IF;
    IF NEW.current_version_id IS NOT NULL THEN
        SELECT number, data_level INTO next_number, next_level
        FROM public.workspace_version WHERE id = NEW.current_version_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION '当前工作区版本不存在，请先建立该版本。' USING ERRCODE = '23503';
        END IF;
        IF NEW.data_level < next_level THEN
            RAISE EXCEPTION '工作区级别不能低于当前版本，请保留最高资料级别。' USING ERRCODE = '42501';
        END IF;
        IF OLD.current_version_id IS NOT NULL AND NEW.current_version_id <> OLD.current_version_id THEN
            SELECT number INTO previous_number FROM public.workspace_version WHERE id = OLD.current_version_id;
            IF next_number <= previous_number THEN
                RAISE EXCEPTION '当前版本不能回退；恢复旧内容必须产生新版本。' USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$workspace_state$;
--> statement-breakpoint
CREATE TRIGGER workspace_state_monotonic BEFORE UPDATE ON public.workspace
FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_state();
--> statement-breakpoint
ALTER TABLE public.workspace ENABLE ALWAYS TRIGGER workspace_state_monotonic;
--> statement-breakpoint

CREATE FUNCTION public.guard_workspace_draft_data_level()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $draft_level$
BEGIN
    IF NEW.data_level < OLD.data_level THEN
        RAISE EXCEPTION '工作副本已接触的资料级别不能降低。' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$draft_level$;
--> statement-breakpoint
CREATE TRIGGER workspace_draft_data_level_monotonic BEFORE UPDATE ON public.workspace_draft
FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_draft_data_level();
--> statement-breakpoint
ALTER TABLE public.workspace_draft ENABLE ALWAYS TRIGGER workspace_draft_data_level_monotonic;
--> statement-breakpoint

-- 锁定工作区再构造新版本，防止构造期间另一个事务推进当前版本。
CREATE FUNCTION public.guard_workspace_version_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $version_insert$
DECLARE
    workspace_level public.document_data_level;
    current_id uuid;
    current_number integer;
BEGIN
    SELECT data_level, current_version_id INTO workspace_level, current_id
    FROM public.workspace WHERE id = NEW.workspace_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '所属工作区不存在。' USING ERRCODE = '23503';
    END IF;
    IF NEW.data_level < workspace_level THEN
        RAISE EXCEPTION '新版本不能降低工作区的最高资料级别。' USING ERRCODE = '42501';
    END IF;
    IF current_id IS NOT NULL THEN
        SELECT number INTO current_number FROM public.workspace_version WHERE id = current_id;
        IF NEW.number <= current_number THEN
            RAISE EXCEPTION '新版本编号必须大于当前版本，请刷新后重新保存。' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$version_insert$;
--> statement-breakpoint
CREATE TRIGGER workspace_version_insert_guard BEFORE INSERT ON public.workspace_version
FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_version_insert();
--> statement-breakpoint
ALTER TABLE public.workspace_version ENABLE ALWAYS TRIGGER workspace_version_insert_guard;
--> statement-breakpoint

-- 文件先写入新版本，再推进工作区指针；推进后连追加文件也禁止。
CREATE FUNCTION public.guard_workspace_file_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $file_insert$
DECLARE
    target_number integer;
    target_level public.document_data_level;
    current_id uuid;
    current_number integer;
BEGIN
    SELECT v.number, v.data_level, w.current_version_id
    INTO target_number, target_level, current_id
    FROM public.workspace_version v JOIN public.workspace w ON w.id = v.workspace_id
    WHERE v.id = NEW.version_id FOR UPDATE OF w;
    IF NOT FOUND THEN
        RAISE EXCEPTION '工作区版本不存在，请先建立新版本。' USING ERRCODE = '23503';
    END IF;
    IF NEW.data_level > target_level THEN
        RAISE EXCEPTION '文件级别高于版本声明，请按最高资料级别建立新版本。' USING ERRCODE = '42501';
    END IF;
    IF current_id IS NOT NULL THEN
        SELECT number INTO current_number FROM public.workspace_version WHERE id = current_id;
        IF target_number <= current_number THEN
            RAISE EXCEPTION '已保存版本不能追加文件，请在工作副本中修改并保存新版本。' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$file_insert$;
--> statement-breakpoint
CREATE TRIGGER workspace_file_insert_guard BEFORE INSERT ON public.workspace_file
FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_file_insert();
--> statement-breakpoint
ALTER TABLE public.workspace_file ENABLE ALWAYS TRIGGER workspace_file_insert_guard;
--> statement-breakpoint

-- 对话与草稿含私有上下文，不能授予通用语义只读角色。
GRANT SELECT ON public.workspace, public.workspace_version, public.workspace_file TO cert_board_reader;
