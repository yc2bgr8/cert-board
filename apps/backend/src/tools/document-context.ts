import type { DataLevel } from '@cert-board/shared';
import { getDocument } from '../documents/service.js';
import { AppError } from '../api/errors.js';
import type { ToolExecutionContext } from './registry.js';

export function documentProject(ctx: ToolExecutionContext): string {
  if (!ctx.projectId)
    throw new AppError(
      400,
      'DOCUMENT_PROJECT_REQUIRED',
      '请先进入项目，再使用doc_search查找资料；不能跨项目猜测资料编号。',
    );
  if (ctx.signal?.aborted)
    throw new AppError(
      409,
      'DOCUMENT_TOOL_STOPPED',
      '运行已停止，本次资料读取未完成，请核对运行状态。',
    );
  return ctx.projectId;
}
export async function documentInProject(ctx: ToolExecutionContext, id: string) {
  const projectId = documentProject(ctx);
  const row = await ctx.tx.query(
    'SELECT id FROM document WHERE id=$1 AND project_id=$2 AND NOT voided FOR SHARE',
    [id, projectId],
  );
  if (row.rowCount !== 1)
    throw new AppError(
      404,
      'DOCUMENT_SOURCE_UNAVAILABLE',
      '该资料不在当前项目或已作废，请用doc_search重新取得当前项目的资料UUID。',
    );
  return getDocument(ctx.tx, ctx.actor, id);
}
export async function refreshDocumentReference(
  ctx: ToolExecutionContext,
  reference: { documentId: string; version: number; page: number },
  contentSha256?: string,
): Promise<DataLevel> {
  const document = await documentInProject(ctx, reference.documentId);
  const row = (
    await ctx.tx.query<{ content_sha256: string; is_placeholder: boolean }>(
      `SELECT v.content_sha256,p.is_placeholder FROM document_version v JOIN document_page p ON p.version_id=v.id
     WHERE v.document_id=$1 AND v.version_no=$2 AND p.page_number=$3`,
      [reference.documentId, reference.version, reference.page],
    )
  ).rows[0];
  if (
    !row ||
    row.is_placeholder ||
    (contentSha256 !== undefined && row.content_sha256 !== contentSha256)
  )
    throw new AppError(
      409,
      'DOCUMENT_RESULT_STALE',
      '旧读取回执的资料版本或有效页已不可用，请重新检索并读取原文。',
    );
  return document.dataLevel;
}
export function highestDocumentLevel(values: readonly DataLevel[]): DataLevel {
  return values.includes('confidential') ? 'confidential' : 'internal';
}
