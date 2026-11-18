-- 变更单2026-11-18取消高风险审核前必须提交独立判断；既有判断和决定保持原样。
-- 仅替换此函数中的判断门限，仍校验有效浏览器会话、卡片版本/内容/状态及冻结快照归属。
CREATE OR REPLACE FUNCTION public.guard_review_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog
AS $review_decision$
DECLARE card public.review_card%ROWTYPE;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.web_session s JOIN public.app_user u ON u.id=s.user_id
       WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_user_id AND s.revoked_at IS NULL
       AND s.expires_at>clock_timestamp() AND u.status='active') THEN
        RAISE EXCEPTION '审核决定需要有效的浏览器用户会话。' USING ERRCODE='42501';
    END IF;
    SELECT * INTO card FROM public.review_card WHERE id=NEW.card_id FOR SHARE;
    IF NOT FOUND OR card.content_hash <> NEW.content_hash OR NOT (
      (card.status='pending' AND card.version=NEW.source_version) OR
      (card.status::text=NEW.action::text AND card.version=NEW.source_version+1)) THEN
        RAISE EXCEPTION '审核决定引用的卡片版本、状态或内容不一致。' USING ERRCODE='23514';
    END IF;
    IF NEW.action='approved' AND NOT EXISTS(SELECT 1 FROM public.submission_snapshot s
       WHERE s.id=NEW.snapshot_id AND s.project_id=card.project_id AND s.workspace_version_id=card.workspace_version_id
       AND s.created_by=NEW.actor_user_id AND s.kind='approved_review') THEN
        RAISE EXCEPTION '冻结快照必须对应本卡片的项目、工作区版本和决定人。' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$review_decision$;
