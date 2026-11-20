import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  checkReportSchema,
  documentPageReadSchema,
  documentSearchResultSchema,
  skillLoadResultSchema,
  structuredSubmissionSchema,
  workspaceToolReadSchema,
  workspaceToolSaveSchema,
  workspaceToolWriteSchema,
  chatRequestSchema,
  selectGatewayModel,
  type DocumentPageRead,
  type DocumentSearchItem,
  type ChatRequest,
  type StructuredSubmission,
} from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { startLocalModelFixture } from '../test-support/local-model-fixture.js';
import { seedDevelopmentWorkspace } from '../workspace/seed.js';
import { seedDevelopmentBudgetPolicy } from '../budget/service.js';
import { readT1Fixture } from '../documents/t1-seed.js';
import { ingestParsedDocument } from '../documents/service.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import { appendConversationMessage } from '../conversations/storage.js';
import { ModelGateway, type GatewayTransport } from '../modelgw/service.js';
import { loadModelGatewayConfig } from '../modelgw/config.js';
import { RealGatewayTransport } from '../modelgw/transport.js';
import { buildAgentTools } from './default-tools.js';
import { executeAgentRun } from './runtime.js';

class MemoryStore implements DocumentBlobStore {
  private values = new Map<string, Buffer>();
  async put(content: Buffer) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    this.values.set(sha256, Buffer.from(content));
    return { sha256, byteSize: content.length };
  }
  async get(sha256: string) {
    const content = this.values.get(sha256);
    if (!content) throw new Error('fixture_blob_missing');
    return Buffer.from(content);
  }
}
const call = (name: string, args: unknown) => ({
  id: randomUUID(),
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: randomUUID(),
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
});

async function verifyL08(profile: '开发模拟' | '本地端点') {
  const context = await createIntegrationContext();
  let localFixture: Awaited<ReturnType<typeof startLocalModelFixture>> | undefined;
  let localTransport: RealGatewayTransport | undefined;
  try {
    const store = new MemoryStore();
    const fixture = await readT1Fixture();
    const source = fixture.documents.find((item) => item.id === 'D035')!;
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
        `INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode,agent_code)
       VALUES($1,$2,$3,'L08真实资料剧本全链路','full','registration') RETURNING id`,
        [context.projectId, userId, context.goalId],
      )
    ).rows[0]!.id;
    const runId = (
      await context.pool.query<{ id: string }>(
        `INSERT INTO run(conversation_id,user_id,project_id,goal_id,status,trigger_type)
       VALUES($1,$2,$3,$4,'queued','evaluation') RETURNING id`,
        [conversationId, userId, context.projectId, context.goalId],
      )
    ).rows[0]!.id;
    await appendConversationMessage(context.pool, {
      runId,
      userId,
      requestKey: randomUUID(),
      message: {
        role: 'user',
        content: '检查L08申报资料中对比器械K号的写法，将差异列为待确认，保存报告并提交审核。',
      },
    });
    let turn = 0;
    let hits: DocumentSearchItem[] = [];
    const reads: DocumentPageRead[] = [];
    let written: ReturnType<typeof workspaceToolWriteSchema.parse> | undefined;
    let saved: ReturnType<typeof workspaceToolSaveSchema.parse> | undefined;
    let submission: StructuredSubmission | undefined;
    let scriptFailure: unknown;
    const path = '交付/L08-K号全链路核查.md';
    let report = '';
    async function scriptedCompletion(request: Pick<ChatRequest, 'messages'>) {
      try {
        const last = request.messages.at(-1);
        const previous: unknown = last?.role === 'tool' ? JSON.parse(last.content) : null;
        switch (turn++) {
          case 0:
            expect(
              request.messages.some(
                (message) => message.role === 'system' && message.content.includes('R09'),
              ),
            ).toBe(true);
            return call('skill_load', { id: 'R09' });
          case 1:
            expect(skillLoadResultSchema.parse(previous).skill.id).toBe('R09');
            return call('plan_update', {
              steps: [
                { title: '核对两处原文', status: 'running' },
                { title: '保存报告并提交审核', status: 'pending' },
              ],
              progress: '已读取项目说明和R09技能，开始定位原文。',
            });
          case 2:
            return call('doc_search', { query: '510(k) number', limit: 3 });
          case 3: {
            hits = documentSearchResultSchema.parse(previous).items;
            expect(hits.map((hit) => hit.page)).toEqual([1, 5]);
            const hit = hits[0]!;
            return call('doc_read', {
              id: hit.documentId,
              version: hit.version,
              page: hit.page,
              offset: hit.snippetOffset,
            });
          }
          case 4: {
            reads.push(documentPageReadSchema.parse(previous));
            const hit = hits[1]!;
            return call('doc_read', {
              id: hit.documentId,
              version: hit.version,
              page: hit.page,
              offset: hit.snippetOffset,
            });
          }
          case 5:
            reads.push(documentPageReadSchema.parse(previous));
            expect(reads.map((read) => read.text.match(/K\d{6}/)?.[0])).toEqual([
              'K170825',
              'K170285',
            ]);
            expect(reads.every((read) => read.text.length <= 1800)).toBe(true);
            report =
              '# L08 K号写法核查\n\n两处写法不同，正确编号待注册人员核对原件确认。\n\n' +
              reads
                .map(
                  (read) =>
                    `${read.sourceKey} 第${read.version}版 第${read.page}页：\n${read.text.split(/\r?\n/).find((line) => /K\d{6}/.test(line))!}`,
                )
                .join('\n\n');
            return call('ws_write', { path, content: report, expectedSha256: null });
          case 6:
            written = workspaceToolWriteSchema.parse(previous);
            return call('ws_read', { path });
          case 7: {
            const file = workspaceToolReadSchema.parse(previous);
            expect(file.sha256).toBe(written!.file.sha256);
            expect(file.text).toBe(report);
            return call('workspace_save', {
              summary: '保存两处K号原文及待确认差异',
              expectedDraftVersion: file.draftVersion,
            });
          }
          case 8: {
            saved = workspaceToolSaveSchema.parse(previous);
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
              claims: evidence.map((ref, index) => ({
                id: `C${index + 1}`,
                object: '对比器械',
                field: 'K号原始写法',
                value: ref.quote.match(/K\d{6}/)![0],
                unit: null,
                sources: [ref],
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
              uncertain: ['正确K号待确认。'],
              nextStep: '请注册人员审核差异报告。',
            });
            return call('check_run', submission);
          }
          case 9:
            expect(checkReportSchema.parse(previous).passed).toBe(true);
            return call('submit_for_review', submission);
          default:
            throw new Error('提交审核后不应再调用模型');
        }
      } catch (error) {
        scriptFailure = error;
        throw error;
      }
    }
    const scripted: GatewayTransport = {
      kind: 'fixture',
      send: (_model, request) => scriptedCompletion(request),
    };
    if (profile === '本地端点') {
      localFixture = await startLocalModelFixture(({ pathname, authorization, body }) => {
        expect(pathname).toBe('/v1/chat/completions');
        expect(authorization).toBeUndefined();
        const input = chatRequestSchema.parse(body);
        expect(input.model).toBe('deepseek-flash');
        return scriptedCompletion(input);
      });
      localTransport = new RealGatewayTransport({ allowedHosts: ['openrouter.ai'] });
    }
    const config = await loadModelGatewayConfig({
      environment: 'development',
      sourceEnv: localFixture ? { CERT_LOCAL_MODEL_BASE_URL: localFixture.baseUrl } : {},
    });
    const model = selectGatewayModel(config, 'agent');
    if (!model) throw new Error('L08_FIXTURE_MODEL');
    expect(model.id).toBe(localFixture ? 'deepseek-local' : 'gpt-6.2-astra-pro');
    const gateway = new ModelGateway(context.pool, config, localTransport ?? scripted, {
      environment: 'test',
    });
    const startedAt = performance.now();
    const done = await executeAgentRun(
      {
        pool: context.pool,
        store,
        gateway,
        models: config,
        definitions: (agentCode) => buildAgentTools(store, agentCode),
      },
      runId,
    );
    if (scriptFailure) throw scriptFailure;
    expect(done.status).toBe('waiting');
    expect(done.reviewId).toBeTruthy();
    expect(turn).toBe(10);
    expect(done.usage).toMatchObject({ steps: 10, costNano: '0' });
    const card = (
      await context.pool.query(
        'SELECT structured_result,check_report,evidence_refs,workspace_version_id,status,version FROM review_card WHERE id=$1 AND run_id=$2',
        [done.reviewId, runId],
      )
    ).rows[0]!;
    expect(card.status).toBe('pending');
    expect(structuredSubmissionSchema.parse(card.structured_result)).toEqual(submission);
    const checks = checkReportSchema.parse(card.check_report);
    expect(checks.passed).toBe(true);
    expect(checks.checks.map((check) => [check.code, check.status])).toEqual([
      ['V1', 'passed'],
      ['V3', 'passed'],
    ]);
    expect(checks.notRun).toEqual(['V2', 'V4', 'V5', 'V6', 'V7', 'V8']);
    expect(card.workspace_version_id).toBe(saved!.workspaceVersion);
    expect(saved!.version.number).toBe(2);
    const proofs = await context.pool.query(
      `SELECT i.id,p.content_json FROM tool_invocation i JOIN conversation_tool_result p ON p.invocation_id=i.id
       WHERE i.run_id=$1 AND i.tool_name='doc_read' AND i.status='completed'`,
      [runId],
    );
    expect(proofs.rows).toHaveLength(2);
    for (const ref of card.evidence_refs as Array<{ readInvocationId: string; quote: string }>) {
      const receipt = proofs.rows.find((row) => row.id === ref.readInvocationId)!;
      expect(documentPageReadSchema.parse(receipt.content_json.result.data).text).toContain(
        ref.quote,
      );
    }
    const file = (
      await context.pool.query<{ sha256: string }>(
        'SELECT sha256 FROM workspace_file WHERE version_id=$1 AND path=$2',
        [saved!.workspaceVersion, path],
      )
    ).rows[0]!;
    expect(file.sha256).toBe(written!.file.sha256);
    expect((await store.get(file.sha256)).toString('utf8')).toBe(report);
    const events = await context.pool.query<{ type: string }>(
      'SELECT type FROM conversation_event WHERE run_id=$1 ORDER BY seq',
      [runId],
    );
    expect(events.rows.map((event) => event.type)).toEqual(
      expect.arrayContaining(['plan_updated', 'tool_completed', 'review_submitted']),
    );
    const toolErrors = events.rows.filter(({ type }) => type === 'tool_failed').length;
    expect(toolErrors).toBe(0);
    expect(
      (await context.pool.query('SELECT id FROM decision UNION ALL SELECT id FROM review_decision'))
        .rowCount,
    ).toBe(0);
    const auth = await context.login('MEMBER_B');
    const approval = await context.app.inject({
      method: 'POST',
      url: `/api/reviews/${done.reviewId}/decision`,
      headers: auth.headers,
      payload: {
        expectedVersion: card.version,
        workspaceVersion: saved!.workspaceVersion,
        requestKey: randomUUID(),
        action: 'approved',
      },
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().status).toBe('approved');
    const snapshot = (
      await context.pool.query(
        'SELECT kind,workspace_version_id FROM submission_snapshot WHERE id=$1',
        [approval.json().snapshotId],
      )
    ).rows[0]!;
    expect(snapshot).toMatchObject({
      kind: 'approved_review',
      workspace_version_id: saved!.workspaceVersion,
    });
    const ledger = (
      await context.pool.query<{ status: string; actual_nano: string }>(
        'SELECT status,actual_nano FROM usage_ledger WHERE run_id=$1',
        [runId],
      )
    ).rows;
    expect(ledger).toHaveLength(turn);
    expect(ledger.every((row) => row.status === 'settled' && row.actual_nano === '0')).toBe(true);
    if (process.env.CERT_L08_METRICS === '1')
      console.log(
        JSON.stringify({
          profile,
          passed: true,
          model: model.id,
          steps: turn,
          elapsedMs: Math.round(performance.now() - startedAt),
          toolErrors,
          costNano: '0',
        }),
      );
  } finally {
    await Promise.all([localFixture?.close(), localTransport?.close()]).finally(() =>
      context.close(),
    );
  }
}

test.each(['开发模拟', '本地端点'] as const)(
  '%s用真实 T1 经同一 Pi 内核完成核查、保存、送审和批准',
  verifyL08,
  60000,
);
