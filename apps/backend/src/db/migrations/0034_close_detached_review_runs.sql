-- Custom SQL migration file, put your code below! --
-- 旧版本处理修改意见时只切换了当前轮次，已交付的原轮次仍显示等待审核。
UPDATE public.run AS previous
SET status = 'completed',
    lease_owner = NULL,
    lease_expires_at = NULL,
    finished_at = COALESCE(previous.finished_at, CURRENT_TIMESTAMP),
    version = previous.version + 1,
    updated_at = CURRENT_TIMESTAMP
FROM public.conversation AS conversation
JOIN public.run AS current_run ON current_run.id = conversation.current_run_id
    AND current_run.conversation_id = conversation.id
WHERE previous.conversation_id = conversation.id
    AND current_run.trigger_type = 'conversation'
    AND current_run.created_at > previous.created_at
    AND previous.status = 'waiting'
    AND (previous.lease_owner IS NULL OR previous.lease_expires_at <= clock_timestamp())
    AND EXISTS (
        SELECT 1 FROM public.review_card AS card
        WHERE card.run_id = previous.id AND card.status = 'pending'
    )
    AND NOT EXISTS (
        SELECT 1 FROM public.goal_wait AS wait
        WHERE wait.run_id = previous.id AND wait.responded_at IS NULL AND wait.cancelled_at IS NULL
    )
    AND NOT EXISTS (
        SELECT 1 FROM public.verification_wait AS wait
        WHERE wait.run_id = previous.id AND wait.state IN ('waiting', 'queued', 'running')
    )
    AND NOT EXISTS (
        SELECT 1 FROM public.tool_approval AS approval
        WHERE approval.run_id = previous.id AND approval.status = 'pending'
    );
