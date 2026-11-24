import {
  checkReportSchema,
  documentPageReadSchema,
  documentSearchResultSchema,
  skillLoadResultSchema,
  structuredSubmissionSchema,
  workspaceToolListSchema,
  workspaceToolSaveSchema,
  workspaceToolWriteSchema,
  type DocumentPageRead,
  type DocumentSearchItem,
  type StructuredSubmission,
} from '@cert-board/shared';

export const browserReviewPath = '交付/L08-K号核查.md';
export const browserRevisionText =
  '补充阅读范围：本次仅核对已导入摘要的两处文字，不代表完成整包资料审阅。';
export const browserVerificationUncertainty = 'Cursor 通道不可用，对比器械编号的外部核实待补。';

export function createBrowserReviewScript(
  revision: boolean,
  extraUncertainty?: string,
  revisionText = browserRevisionText,
) {
  if (process.env.NODE_ENV !== 'test') throw new Error('BROWSER_FIXTURE_TEST_ONLY');
  let step = 0;
  let hits: DocumentSearchItem[] = [];
  const reads: DocumentPageRead[] = [];
  let submission: StructuredSubmission | undefined;
  const readInput = (hit: DocumentSearchItem) => ({
    id: hit.documentId,
    version: hit.version,
    page: hit.page,
    offset: hit.snippetOffset,
  });
  return (previous: unknown): { name: string; input: unknown } => {
    switch (step++) {
      case 0:
        return { name: 'skill_load', input: { id: 'R09' } };
      case 1:
        if (skillLoadResultSchema.parse(previous).skill.id !== 'R09')
          throw new Error('BROWSER_REVIEW_SKILL_MISMATCH');
        return {
          name: 'plan_update',
          input: {
            steps: [
              { title: '定位并阅读两处原文', status: 'running' },
              { title: '保存差异报告并提交审核', status: 'pending' },
            ],
            progress: '先读取两处真实写法，再核验并提交差异报告。',
          },
        };
      case 2:
        return { name: 'doc_search', input: { query: '510(k) number', limit: 3 } };
      case 3:
        hits = documentSearchResultSchema.parse(previous).items;
        if (hits.length < 2) throw new Error('BROWSER_REVIEW_SOURCES_MISSING');
        return { name: 'doc_read', input: readInput(hits[0]!) };
      case 4:
        reads.push(documentPageReadSchema.parse(previous));
        return { name: 'doc_read', input: readInput(hits[1]!) };
      case 5:
        reads.push(documentPageReadSchema.parse(previous));
        if (new Set(reads.map((read) => read.text.match(/K\d{6}/)?.[0])).size !== 2)
          throw new Error('BROWSER_REVIEW_DIFFERENCE_MISSING');
        return { name: 'ws_list', input: {} };
      case 6: {
        const files = workspaceToolListSchema.parse(previous);
        if (files.hasMore) throw new Error('BROWSER_REVIEW_FILE_SCOPE_INCOMPLETE');
        const current = files.items.find((file) => file.path === browserReviewPath);
        if (revision !== Boolean(current)) throw new Error('BROWSER_REVIEW_BASE_MISMATCH');
        const lines = reads.map((read) => {
          const quote = read.text.split(/\r?\n/).find((line) => /K\d{6}/.test(line));
          if (!quote) throw new Error('BROWSER_REVIEW_QUOTE_MISSING');
          return `${read.sourceKey} 第${read.version}版 第${read.page}页：\n${quote}`;
        });
        const content =
          '# L08 K号写法核查\n\n两处写法不同，正确编号待注册人员核对原件确认。\n\n' +
          lines.join('\n\n') +
          (revision ? `\n\n${revisionText}\n` : '\n');
        return {
          name: 'ws_write',
          input: { path: browserReviewPath, content, expectedSha256: current?.sha256 ?? null },
        };
      }
      case 7: {
        const write = workspaceToolWriteSchema.parse(previous);
        return {
          name: 'workspace_save',
          input: {
            summary: revision ? '补充本次核查范围' : '保存两处K号原文及待确认差异',
            expectedDraftVersion: write.draft.version,
          },
        };
      }
      case 8: {
        const saved = workspaceToolSaveSchema.parse(previous);
        const evidence = reads.map((read) => ({
          documentId: read.documentId,
          version: read.version,
          page: read.page,
          quote: read.text.split(/\r?\n/).find((line) => /K\d{6}/.test(line))!,
        }));
        submission = structuredSubmissionSchema.parse({
          skill: { id: 'R09', version: '0.1.0' },
          workspaceVersion: saved.workspaceVersion,
          conclusion: '同一资料两处K号写法不同，正确编号待注册人员确认。',
          claims: evidence.map((source, index) => ({
            id: `C${index + 1}`,
            object: '对比器械',
            field: 'K号原始写法',
            value: source.quote.match(/K\d{6}/)![0],
            unit: null,
            sources: [source],
            status: 'checked',
          })),
          evidence,
          decisions: [
            {
              id: 'D1',
              subject: '差异处理',
              choice: '保留两处原文，暂不选定正确编号。',
              alternatives: ['等待原件核实后修订'],
              reason: '两处写法不同，仅凭出现次数不能认定正确编号。',
              sources: evidence,
              risk: 'low',
            },
          ],
          missing: ['原始文件核对结果'],
          uncertain: ['正确K号待确认。', ...(extraUncertainty ? [extraUncertainty] : [])],
          nextStep: revision ? '请审核补充的阅读范围。' : '请注册人员审核差异报告。',
        });
        return { name: 'check_run', input: submission };
      }
      case 9:
        if (!checkReportSchema.parse(previous).passed)
          throw new Error('BROWSER_REVIEW_CHECK_FAILED');
        return { name: 'submit_for_review', input: submission };
      default:
        throw new Error('BROWSER_REVIEW_UNEXPECTED_TURN');
    }
  };
}
