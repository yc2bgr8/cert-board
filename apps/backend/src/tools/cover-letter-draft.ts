import { coverLetterDraftInputSchema, coverLetterDraftOutputSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import {
  coverLetterFileName,
  coverLetterReference,
  coverLetterReferenceKey,
  coverLetterSourcesName,
  loadCoverLetterManifest,
  parseK05Draft,
  renderK05Draft,
} from '../knowledge/draft-template.js';
import { verifyReadReceipts } from '../reviews/submission.js';
import {
  resolveWorkspaceToolContext,
  workspaceVersionToken,
  writeDraftArtifact,
} from '../workspace/service.js';
import { highestDocumentLevel, refreshDocumentReference } from './document-context.js';
import type { ToolDefinition } from './registry.js';
import { workspaceDraftUndo } from './workspace-tools.js';

export function coverLetterDraftTool(store: DocumentBlobStore): ToolDefinition {
  return {
    metadata: {
      name: 'k05_cover_letter_draft',
      version: 'builtin-k05-cover-letter-v1',
      publication: 'published',
      effect: 'reversible_write',
      modes: ['ask', 'full'],
      approvalInAsk: false,
      outputDataLevel: 'dynamic',
      authorizationAction: 'workspace.write',
      description: {
        purpose: '用 K05 通用模板在当前工作副本中生成 510(k) Cover Letter 草稿及逐段来源表。',
        whenToUse: '需要起草供注册人员审核的 Cover Letter，且已 doc_read 取得资料原文时。',
        avoid: '缺少明确字段原文时省略该字段。最终文件由人审阅签署，不能用来提交或发出。',
        parameters:
          'outputDirectory 取交付目录的直接子目录，使用新目录。expectedDraftVersion 取 ws_list 的 draftVersion。fields 按需填 submission_type、device_name、draft_date、applicant_name、applicant_address、contact_name、contact_email、device_model、product_code、submission_purpose、comparator_reference；每项传 value 和 doc_read 的 source（documentId、version、page、quote），quote 需含完整字段行。回执列出待核字段和两个文件路径。',
        example: {
          outputDirectory: '交付/510k信函草稿',
          expectedDraftVersion: 1,
          fields: {
            device_name: {
              value: 'Synthetic device',
              source: {
                documentId: '11111111-1111-4111-8111-111111111111',
                version: 1,
                page: 1,
                quote: 'Device name: Synthetic device',
              },
            },
          },
        },
      },
    },
    inputSchema: coverLetterDraftInputSchema,
    outputSchema: coverLetterDraftOutputSchema,
    undo: workspaceDraftUndo(store),
    async execute(ctx, input) {
      const request = coverLetterDraftInputSchema.parse(input);
      if (!ctx.projectId || process.env.NODE_ENV === 'production')
        throw new AppError(
          403,
          'K05_DRAFT_UNAVAILABLE',
          '仅可在开发环境的当前项目中使用草稿模板。',
        );
      const scope = await resolveWorkspaceToolContext(
        ctx.tx,
        ctx.actor,
        ctx.projectId,
        ctx.conversationId,
        'draft',
        true,
      );
      if (scope.draft?.version !== request.expectedDraftVersion)
        throw new AppError(
          409,
          'WORKSPACE_DRAFT_CONFLICT',
          '工作副本已变化，请重新 ws_list 后重试。',
        );
      const template = await loadCoverLetterManifest();
      const labels = parseK05Draft(template).fields;
      if (Object.keys(request.fields).some((key) => !Object.hasOwn(labels, key)))
        throw new AppError(422, 'K05_FIELD_UNKNOWN', '请按 K05 工具说明使用模板字段。');
      const references = Object.values(request.fields).map(({ source }) => source);
      const levels = [ctx.maxDataLevel, scope.dataLevel];
      for (const reference of references)
        levels.push(await refreshDocumentReference(ctx, reference));
      await verifyReadReceipts(ctx, references);
      const draft = await renderK05Draft(template, request.fields, async (ref) => {
        const page = await ctx.tx.query<{ text: string }>(
          `SELECT p.text FROM document_page p JOIN document_version v ON v.id=p.version_id
           JOIN document d ON d.id=v.document_id
           WHERE d.id=$1 AND d.project_id=$2 AND NOT d.voided AND v.version_no=$3
             AND p.page_number=$4 AND NOT p.is_placeholder`,
          [ref.documentId, ctx.projectId, ref.version, ref.page],
        );
        return page.rows[0]?.text ?? null;
      });
      const id = scope.draft.id;
      const dataLevel = highestDocumentLevel(levels);
      const markdownPath = `${request.outputDirectory}/${coverLetterFileName}`;
      const sourceMapPath = `${request.outputDirectory}/${coverLetterSourcesName}`;
      const files = [];
      for (const file of [
        { path: markdownPath, text: draft.markdown, mediaType: 'text/markdown; charset=utf-8' },
        {
          path: sourceMapPath,
          text: JSON.stringify(draft.sourceMap, null, 2) + '\n',
          mediaType: 'application/json',
        },
      ]) {
        files.push(
          await writeDraftArtifact(ctx.tx, store, ctx.actor, id, {
            path: file.path,
            mediaType: file.mediaType,
            bytes: Buffer.from(file.text, 'utf8'),
            dataLevel,
          }),
        );
      }
      const sources = new Map(
        draft.sourceMap.paragraphs.flatMap(({ evidence }) =>
          evidence.map(({ source }) => {
            const reference = coverLetterReference(source);
            return [coverLetterReferenceKey(reference), reference] as const;
          }),
        ),
      );
      return {
        data: {
          markdownPath,
          sourceMapPath,
          markdownSha256: files[0]!.file.sha256,
          sourceMapSha256: files[1]!.file.sha256,
          missing: draft.sourceMap.missing,
          unverified: draft.sourceMap.unverified,
          sources: [...sources.values()],
        },
        dataLevel,
        afterVersion: await workspaceVersionToken(ctx.tx, ctx.actor, id),
      };
    },
    async refreshDataLevel(ctx, output) {
      const receipt = coverLetterDraftOutputSchema.parse(output);
      const levels = [ctx.maxDataLevel];
      for (const reference of receipt.sources)
        levels.push(await refreshDocumentReference(ctx, reference));
      return highestDocumentLevel(levels);
    },
  };
}
