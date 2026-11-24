import { posix } from 'node:path';
import {
  coverLetterDraftOutputSchema,
  toolStoredPayloadSchema,
  type DataLevel,
  type DocumentCitation,
  type WorkspaceFileDescriptor,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import {
  coverLetterFileName,
  coverLetterReference,
  coverLetterReferenceKey,
  coverLetterSourcesName,
} from '../knowledge/draft-template.js';
import { refreshDocumentReference } from '../tools/document-context.js';
import type { ToolExecutionContext } from '../tools/registry.js';

export async function verifyCoverLetterDrafts(
  ctx: ToolExecutionContext,
  manifest: readonly WorkspaceFileDescriptor[],
  changes: ReadonlyArray<{ path: string; afterSha256: string | null }>,
  references: readonly DocumentCitation[],
): Promise<DataLevel[]> {
  const files = new Map(manifest.map((file) => [file.path, file]));
  const invalid = () =>
    new AppError(
      422,
      'K05_DRAFT_PROOF_REQUIRED',
      'K05 信函与来源表需要有同一次生成的完整核对记录。请恢复同一版的两份文件，或移除旧文件后在本对话中重新生成并保存。',
    );
  const directories = new Set<string>();
  for (const { path } of changes) {
    if (!path.startsWith('交付/')) continue;
    const filename = posix.basename(path);
    const normalized = filename.toLowerCase();
    if (normalized !== coverLetterFileName && normalized !== coverLetterSourcesName) continue;
    if (filename !== normalized && files.has(path)) throw invalid();
    directories.add(posix.dirname(path));
  }
  const current = changes.filter(({ afterSha256 }) => afterSha256 !== null);
  if (current.length) {
    const moved = await ctx.tx.query(
      `WITH changed_files AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS f(path text, "afterSha256" text)
       ), receipt_files AS (
         SELECT artifact.path, artifact.sha256 FROM tool_invocation i JOIN conversation_tool_result r
         ON r.invocation_id=i.id AND r.conversation_id=i.conversation_id AND r.user_id=i.user_id
         JOIN run source_run ON source_run.id=i.run_id
         CROSS JOIN LATERAL (VALUES
           (r.content_json #>> '{result,data,markdownPath}', r.content_json #>> '{result,data,markdownSha256}'),
           (r.content_json #>> '{result,data,sourceMapPath}', r.content_json #>> '{result,data,sourceMapSha256}')
         ) AS artifact(path, sha256)
         WHERE source_run.project_id=$1 AND i.tool_name='k05_cover_letter_draft'
            AND i.effect='reversible_write' AND i.operation='execute' AND i.status='completed'
            AND artifact.sha256 IN (SELECT "afterSha256" FROM changed_files)
       )
       SELECT 1 FROM changed_files f
       WHERE EXISTS (SELECT 1 FROM receipt_files a WHERE a.sha256=f."afterSha256")
       AND NOT EXISTS (SELECT 1 FROM receipt_files a WHERE a.sha256=f."afterSha256" AND a.path=f.path)
       LIMIT 1`,
      [ctx.projectId, JSON.stringify(current)],
    );
    if (moved.rowCount) throw invalid();
  }
  if (directories.size === 0) return [];
  if (directories.size > 12)
    throw new AppError(422, 'K05_DRAFT_LIMIT', '单次最多审核 12 份 K05 信函草稿，请缩小交付范围。');

  const levels: DataLevel[] = [];
  const evidence = new Set(
    references.map((ref) => coverLetterReferenceKey(coverLetterReference(ref))),
  );
  for (const dir of directories) {
    const markdown = files.get(`${dir}/${coverLetterFileName}`);
    const table = files.get(`${dir}/${coverLetterSourcesName}`);
    if (!markdown && !table) continue;
    if (!markdown || !table) throw invalid();
    const { rows } = await ctx.tx.query<{ content_json: unknown }>(
      `SELECT r.content_json FROM tool_invocation i JOIN conversation_tool_result r
       ON r.invocation_id=i.id AND r.conversation_id=i.conversation_id AND r.user_id=i.user_id
       JOIN run source_run ON source_run.id=i.run_id
       WHERE i.conversation_id=$1 AND i.user_id=$2 AND source_run.project_id=$3
       AND i.tool_name='k05_cover_letter_draft' AND i.effect='reversible_write'
       AND i.operation='execute' AND i.status='completed'
       AND r.content_json #>> '{result,data,markdownPath}'=$4
       AND r.content_json #>> '{result,data,sourceMapPath}'=$5
       AND r.content_json #>> '{result,data,markdownSha256}'=$6
       AND r.content_json #>> '{result,data,sourceMapSha256}'=$7
       ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,
      [
        ctx.conversationId,
        ctx.actor.userId,
        ctx.projectId,
        markdown.path,
        table.path,
        markdown.sha256,
        table.sha256,
      ],
    );
    const payload = toolStoredPayloadSchema.safeParse(rows[0]?.content_json);
    if (!payload.success || payload.data.status !== 'completed') throw invalid();
    const receipt = coverLetterDraftOutputSchema.safeParse(payload.data.result.data);
    if (!receipt.success) throw invalid();
    levels.push(markdown.dataLevel, table.dataLevel);
    for (const ref of receipt.data.sources) {
      if (!evidence.has(coverLetterReferenceKey(ref)))
        throw new AppError(
          422,
          'K05_DRAFT_EVIDENCE_REQUIRED',
          '请把 K05 来源表中实际采用的完整资料引文一并列入当前送审证据。',
        );
      levels.push(await refreshDocumentReference(ctx, ref));
    }
  }
  return levels;
}
