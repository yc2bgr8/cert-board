import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  humanFeedbackInputSchema,
  humanFeedbackSelectionSchema,
  humanFeedbackResultSchema,
  type BrowserIdentity,
  type HumanFeedbackTarget,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { readConversation } from './read.js';

const skill = z.strictObject({
  id: z.string().min(1).max(64),
  version: z.string().min(1).max(128),
});
type Skills = z.infer<typeof skill>[];
type FeedbackRow = {
  id: string;
  message_id: string | null;
  review_id: string | null;
  rating: 'helpful' | 'unhelpful';
  reason: string | null;
  fingerprint: string;
  created_at: Date;
};
type Target = {
  run_id: string;
  data_level: 'internal' | 'confidential';
  skill_id: string | null;
  skill_version: string | null;
};

const fields = 'id,message_id,review_id,rating,reason,fingerprint,created_at';
const targetMissing = () =>
  new AppError(
    404,
    'FEEDBACK_TARGET_NOT_FOUND',
    '没有找到本对话的 Agent 消息或审核卡，请刷新后重试。',
  );

function result(row: FeedbackRow) {
  return humanFeedbackResultSchema.parse({
    id: row.id,
    kind: row.review_id ? 'review' : 'message',
    targetId: row.review_id ?? row.message_id,
    rating: row.rating,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  });
}

export async function getHumanFeedback(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  target: HumanFeedbackTarget,
) {
  await readConversation(tx, actor, conversationId);
  const column = target.kind === 'review' ? 'review_id' : 'message_id';
  const {
    rows: [row],
  } = await tx.query<FeedbackRow>(
    `SELECT ${fields} FROM human_feedback WHERE conversation_id=$1 AND user_id=$2
      AND ${column}=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [conversationId, actor.userId, target.targetId],
  );
  return humanFeedbackSelectionSchema.parse({ item: row ? result(row) : null });
}

export async function saveHumanFeedback(
  tx: PoolClient,
  actor: BrowserIdentity,
  conversationId: string,
  input: unknown,
) {
  const command = humanFeedbackInputSchema.safeParse(input);
  if (!command.success)
    throw new AppError(400, 'FEEDBACK_INVALID', '反馈选项、原因或目标无效，请核对后重新提交。');
  const { kind, rating, reason, requestKey } = command.data;
  const targetId = command.data.targetId.toLowerCase();
  const conversation = await readConversation(tx, actor, conversationId);
  const source =
    kind === 'review'
      ? 'SELECT run_id,data_level,skill_id,skill_version FROM review_card WHERE id=$1 AND conversation_id=$2'
      : `SELECT run_id,data_level,NULL AS skill_id,NULL AS skill_version
        FROM conversation_message WHERE id=$1 AND conversation_id=$2
          AND message_json->>'role'='assistant' AND jsonb_typeof(message_json->'content')='string'`;
  const {
    rows: [target],
  } = await tx.query<Target>(source, [targetId, conversation.id]);
  if (!target) throw targetMissing();
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ conversationId: conversation.id, kind, targetId, rating, reason }))
    .digest('hex');
  let skills: Skills;
  if (kind === 'review') {
    skills = [skill.parse({ id: target.skill_id, version: target.skill_version })];
  } else {
    const { rows } = await tx.query(
      `SELECT DISTINCT p.content_json#>>'{result,data,skill,id}' AS id,
          p.content_json#>>'{result,data,skill,version}' AS version
        FROM tool_invocation i JOIN conversation_tool_result p ON p.invocation_id=i.id
        WHERE i.run_id=$1 AND i.conversation_id=$2 AND i.tool_name='skill_load'
          AND i.status='completed' AND p.created_at <= (
            SELECT m.created_at FROM conversation_message m
            WHERE m.id=$3 AND m.run_id=i.run_id AND m.conversation_id=i.conversation_id
          )
        ORDER BY id,version LIMIT 16`,
      [target.run_id, conversation.id, targetId],
    );
    skills = rows.flatMap((row) => {
      const parsed = skill.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }
  const level =
    reason !== null ||
    target.data_level === 'confidential' ||
    conversation.maxDataLevel === 'confidential'
      ? 'confidential'
      : 'internal';
  const {
    rows: [inserted],
  } = await tx.query<FeedbackRow>(
    `INSERT INTO human_feedback(conversation_id,run_id,message_id,review_id,user_id,browser_session_id,
          request_key,fingerprint,rating,reason,skills,data_level,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,clock_timestamp())
      ON CONFLICT(user_id,request_key) DO NOTHING RETURNING ${fields}`,
    [
      conversation.id,
      target.run_id,
      kind === 'message' ? targetId : null,
      kind === 'review' ? targetId : null,
      actor.userId,
      actor.sessionId,
      requestKey,
      fingerprint,
      rating,
      reason,
      JSON.stringify(skills),
      level,
    ],
  );
  if (inserted) {
    await tx.query(
      `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash)
        VALUES($1,'browser','feedback.recorded','human_feedback',$2,$3)`,
      [actor.userId, inserted.id, fingerprint],
    );
    return result(inserted);
  }
  const {
    rows: [prior],
  } = await tx.query<FeedbackRow>(
    `SELECT ${fields} FROM human_feedback WHERE user_id=$1 AND request_key=$2`,
    [actor.userId, requestKey],
  );
  if (!prior || prior.fingerprint !== fingerprint)
    throw new AppError(
      409,
      'FEEDBACK_REQUEST_CONFLICT',
      '反馈请求编号已有其他内容，请刷新后重试。',
    );
  return result(prior);
}
