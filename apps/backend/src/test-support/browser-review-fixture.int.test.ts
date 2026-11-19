import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  checkReportSchema,
  documentPageReadSchema,
  reviewDiffSchema,
  structuredSubmissionSchema,
} from '@cert-board/shared';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { createIntegrationContext } from './context.js';
import { browserModels, browserScenario, type BrowserScenario } from './browser-fixture.js';
import { browserReviewPath, browserRevisionText } from './browser-review-fixture.js';
import { ingestParsedDocument } from '../documents/service.js';
import { readT1Fixture } from '../documents/t1-seed.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { appendConversationMessage } from '../conversations/storage.js';
import { ModelGateway } from '../modelgw/service.js';
import { executeAgentRun } from '../agent/runtime.js';
import { buildAgentTools } from '../agent/default-tools.js';

class MemoryStore implements DocumentBlobStore {
  private values = new Map<string, Buffer>();
  async put(content: Buffer) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    this.values.set(sha256, Buffer.from(content));
    return { sha256, byteSize: content.length };
  }
  async get(sha256: string) {
    const content = this.values.get(sha256);
    if (!content) throw new Error('BROWSER_BLOB_MISSING');
    return Buffer.from(content);
  }
}
test('审核浏览器剧本经真实T1和工具形成两版卡片，文字批准无效，修改只含此次差异', async () => {
  const context = await createIntegrationContext();
  try {
    const store = new MemoryStore();
    const fixture = await readT1Fixture();
    const source = fixture.documents.find((document) => document.id === 'D035')!;
    await ingestParsedDocument(context.pool, store, {
      projectId: context.projectId,
      sourceKey: source.id,
      name: source.name,
      sourcePath: source.path,
      sourceSnapshot: fixture.snapshot,
      originalSha256: source.sha256,
      dataLevel: 'internal',
      authorType: 'external',
      sourceMetadata: {},
      pages: fixture.pages
        .filter((page) => page.doc === source.id)
        .map((page) => ({
          pageNumber: page.page,
          text: page.text,
          method: page.method,
          locatorKind: page.method === 'docx' ? 'extraction_unit' : 'physical_page',
          ocrScore: page.ocr_score ?? null,
          isPlaceholder: false,
        })),
    });
    await seedDevelopmentWorkspace(context.pool, store, { NODE_ENV: 'test' });
    await seedDevelopmentBudgetPolicy(context.pool, 'test');
    const userId = context.userId('MEMBER_A');
    const conversationId = (
      await context.pool.query<{ id: string }>(
        "INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES($1,$2,$3,'浏览器审核剧本','ask') RETURNING id",
        [context.projectId, userId, context.goalId],
      )
    ).rows[0]!.id;
    async function run(kind: BrowserScenario, text: string) {
      const runId = (
        await context.pool.query<{ id: string }>(
          "INSERT INTO run(conversation_id,user_id,project_id,goal_id,status,trigger_type) VALUES($1,$2,$3,$4,'queued','evaluation') RETURNING id",
          [conversationId, userId, context.projectId, context.goalId],
        )
      ).rows[0]!.id;
      await appendConversationMessage(context.pool, {
        runId,
        userId,
        requestKey: randomUUID(),
        message: { role: 'user', content: text },
      });
      const scenario = browserScenario(kind, randomUUID());
      const gateway = new ModelGateway(context.pool, browserModels, scenario.transport, {
        environment: 'test',
      });
      const outcome = await executeAgentRun(
        {
          pool: context.pool,
          store,
          gateway,
          models: browserModels,
          definitions: (code) => buildAgentTools(store, code),
        },
        runId,
      );
      expect(scenario.observed.failed).toBe(false);
      return { runId, outcome };
    }
    const first = await run('review', '检查L08申报资料中对比器械K号的写法');
    expect(first.outcome.status).toBe('waiting');
    expect(first.outcome.reviewId).toBeTruthy();
    const card = (
      await context.pool.query('SELECT * FROM review_card WHERE id=$1', [first.outcome.reviewId])
    ).rows[0]!;
    const submission = structuredSubmissionSchema.parse(card.structured_result);
    expect(submission.evidence.map((ref) => ref.page)).toEqual([1, 5]);
    expect(submission.claims.map((claim) => claim.value)).toEqual(['K170825', 'K170285']);
    expect(submission.decisions).toHaveLength(1);
    expect(checkReportSchema.parse(card.check_report).passed).toBe(true);
    const receipts = (
      await context.pool.query(
        `SELECT i.id,p.content_json FROM tool_invocation i
      JOIN conversation_tool_result p ON p.invocation_id=i.id WHERE i.run_id=$1 AND i.tool_name='doc_read'`,
        [first.runId],
      )
    ).rows;
    expect(receipts).toHaveLength(2);
    for (const ref of card.evidence_refs as Array<{ readInvocationId: string; quote: string }>) {
      const receipt = receipts.find((row) => row.id === ref.readInvocationId)!;
      expect(documentPageReadSchema.parse(receipt.content_json.result.data).text).toContain(
        ref.quote,
      );
    }
    await run('approval_text', '我已批准');
    expect((await context.pool.query('SELECT id FROM review_decision')).rowCount).toBe(0);
    expect((await context.pool.query('SELECT id FROM submission_snapshot')).rowCount).toBe(0);
    const auth = await context.login();
    const decided = await context.app.inject({
      method: 'POST',
      url: `/api/reviews/${card.id}/decision`,
      headers: auth.headers,
      payload: {
        expectedVersion: card.version,
        workspaceVersion: card.workspace_version_id,
        requestKey: randomUUID(),
        action: 'approved',
      },
    });
    expect(decided.statusCode).toBe(200);
    const snapshot = (
      await context.pool.query('SELECT workspace_version_id FROM submission_snapshot WHERE id=$1', [
        decided.json().snapshotId,
      ])
    ).rows[0]!;
    expect(snapshot.workspace_version_id).toBe(card.workspace_version_id);
    const revised = await run('revision', '请补充本次阅读范围后重新提交审核。');
    expect(revised.outcome.status).toBe('waiting');
    const next = (
      await context.pool.query('SELECT * FROM review_card WHERE id=$1', [revised.outcome.reviewId])
    ).rows[0]!;
    const diff = reviewDiffSchema.parse(next.diff);
    expect(diff.baseVersionId).toBe(card.workspace_version_id);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ path: browserReviewPath, change: 'modified' });
    const before = (await store.get(diff.changes[0]!.beforeSha256!)).toString('utf8');
    const after = (await store.get(diff.changes[0]!.afterSha256!)).toString('utf8');
    expect(before).not.toContain(browserRevisionText);
    expect(after).toContain(browserRevisionText);
    expect((await context.pool.query('SELECT id FROM review_decision')).rowCount).toBe(1);
  } finally {
    await context.close();
  }
}, 60000);
