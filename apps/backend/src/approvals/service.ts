import { createHash } from 'node:crypto';
import {
  toolApprovalDisplaySchema,
  toolApprovalPendingResultSchema,
  toolApprovalPreviewSchema,
  type DataLevel,
  type ToolMetadata,
  type ToolApprovalPreview,
} from '@cert-board/shared';
import type { ToolExecutionContext } from '../tools/registry.js';
import { AppError } from '../api/errors.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const approvalContentHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const levels: DataLevel[] = ['public', 'internal', 'confidential'];
function highest(...values: DataLevel[]) {
  return values.reduce<DataLevel>(
    (result, value) => (levels.indexOf(value) > levels.indexOf(result) ? value : result),
    'internal',
  );
}

export async function hasConversationToolGrant(ctx: ToolExecutionContext, metadata: ToolMetadata) {
  if (
    ctx.permissionMode !== 'ask' ||
    metadata.effect !== 'reversible_write' ||
    !metadata.approvalInAsk
  )
    return false;
  const found = await ctx.tx.query(
    `SELECT id FROM conversation_tool_grant
     WHERE conversation_id=$1 AND user_id=$2 AND tool_name=$3 AND tool_version=$4 AND revoked_at IS NULL FOR SHARE`,
    [ctx.conversationId, ctx.actor.userId, metadata.name, metadata.version],
  );
  return found.rowCount === 1;
}

export async function createToolApproval(
  ctx: ToolExecutionContext,
  metadata: ToolMetadata,
  invocationId: string,
  argumentsHash: string,
  argumentsJson: unknown,
  previewInput: ToolApprovalPreview,
) {
  if (!ctx.projectId || !ctx.goalId || ctx.goalStatus !== 'active' || ctx.permissionMode !== 'ask')
    throw new AppError(
      409,
      'APPROVAL_CONTEXT_INVALID',
      '当前对话或目标不能建立批准请求，请刷新后重试。',
    );
  if (new TextEncoder().encode(JSON.stringify(argumentsJson)).length > 65536)
    throw new AppError(413, 'APPROVAL_INPUT_TOO_LARGE', '待批准参数过长，请缩小本次操作。');
  const preview = toolApprovalPreviewSchema.parse(previewInput);
  const { dataLevel: previewLevel, targetVersions, ...display } = preview;
  const content = toolApprovalDisplaySchema.parse(display);
  const level = highest(
    ctx.maxDataLevel,
    previewLevel,
    metadata.outputDataLevel === 'dynamic' ? 'internal' : metadata.outputDataLevel,
  );
  const contentHash = approvalContentHash({
    invocationId,
    runId: ctx.runId,
    conversationId: ctx.conversationId,
    userId: ctx.actor.userId,
    projectId: ctx.projectId,
    goalId: ctx.goalId,
    toolName: metadata.name,
    toolVersion: metadata.version,
    argumentsHash,
    preview: content,
    targetVersions,
    directionVersion: ctx.directionVersion,
    dataLevel: level,
  });
  const result = await ctx.tx.query<{ id: string }>(
    `INSERT INTO tool_approval(invocation_id,run_id,conversation_id,user_id,project_id,goal_id,
     tool_name,tool_version,arguments_hash,content_hash,direction_version,data_level,
     arguments_json,preview_json,target_versions_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      invocationId,
      ctx.runId,
      ctx.conversationId,
      ctx.actor.userId,
      ctx.projectId,
      ctx.goalId,
      metadata.name,
      metadata.version,
      argumentsHash,
      contentHash,
      ctx.directionVersion,
      level,
      JSON.stringify(argumentsJson),
      JSON.stringify(content),
      JSON.stringify(targetVersions),
    ],
  );
  const id = result.rows[0]!.id;
  await ctx.tx.query(
    `UPDATE tool_invocation SET status='pending_approval',data_level=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2`,
    [level, invocationId],
  );
  await ctx.tx.query(
    `INSERT INTO audit_log(actor_user_id,actor_kind,action,target_type,target_id,after_hash)
     VALUES($1,'agent','tool.approval_requested','tool_approval',$2,$3)`,
    [ctx.actor.userId, id, contentHash],
  );
  return { data: pendingData(id, 'pending'), dataLevel: level };
}

function pendingData(id: string, status: 'pending' | 'approved' | 'rejected' | 'cancelled') {
  return toolApprovalPendingResultSchema.parse({
    approvalId: id,
    status,
    message:
      status === 'pending'
        ? '操作尚未执行，请发起对话的人在浏览器处理批准请求。'
        : '该批准请求已有决定；当前版本仅记录决定，不执行或恢复调用，请等待后续继续入口。',
  });
}

export async function replayToolApproval(ctx: ToolExecutionContext, invocationId: string) {
  const found = await ctx.tx.query<{
    id: string;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    data_level: DataLevel;
  }>(
    `SELECT id,status,data_level FROM tool_approval
     WHERE invocation_id=$1 AND run_id=$2 AND conversation_id=$3 AND user_id=$4 FOR SHARE`,
    [invocationId, ctx.runId, ctx.conversationId, ctx.actor.userId],
  );
  const row = found.rows[0];
  if (!row)
    throw new AppError(
      409,
      'APPROVAL_RECORD_MISSING',
      '原批准请求无法核对，不能重做调用，请联系维护人员。',
    );
  return {
    data: pendingData(row.id, row.status),
    dataLevel: highest(ctx.maxDataLevel, row.data_level),
  };
}
