import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  checkReportSchema,
  parseBackendConfig,
  reviewEvidenceRefSchema,
  structuredSubmissionSchema,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { createDependencies } from '../dependencies.js';
import { BlobStore } from '../documents/blob-store.js';
import { developmentProjectId, developmentGoalId } from '../projects/seed.js';
import { appendConversationMessage } from '../conversations/storage.js';
import { getBudgetSummary } from '../budget/service.js';
import { nanoToUsd, usdToNano } from '../budget/meter.js';
import { loadModelGatewayConfig, parseAllowedModelHosts } from '../modelgw/config.js';
import { RealGatewayTransport } from '../modelgw/transport.js';
import { ModelGateway } from '../modelgw/service.js';
import type { ToolDefinition } from '../tools/registry.js';
import { executeAgentRun } from './runtime.js';
import { buildAgentTools } from './default-tools.js';

const l08 = process.argv.includes('--l08');

async function main() {
  const config = parseBackendConfig(process.env);
  if (config.NODE_ENV !== 'development') throw new Error('REAL_TEST_ENVIRONMENT');
  const configured = await loadModelGatewayConfig({ environment: 'development' });
  const model = configured.models.find(
    (entry) => entry.id === 'qwen-flash' && entry.enabled && entry.purposes.includes('agent'),
  );
  if (!model || model.transport === 'local' || model.transport === 'cursor-acp' || !process.env[model.apiKeyEnv])
    throw new Error('REAL_TEST_MODEL_MISSING');
  const models = { version: 1 as const, models: [model] };
  const hosts = parseAllowedModelHosts(
    await readFile(new URL('../../../../deploy/egress/allowlist', import.meta.url), 'utf8'),
  );
  const transport = new RealGatewayTransport({
    proxyUrl: process.env.HTTPS_PROXY ?? '',
    containerRuntime: config.CONTAINER_RUNTIME,
    allowedHosts: hosts,
  });
  const dependencies = createDependencies(config);
  const pool = dependencies.database;
  let conversationId: string | undefined;
  let runId: string | undefined;
  let passed = false;
  try {
    const budget = await getBudgetSummary(pool);
    if (budget.blockedReason || budget.counts.unknown > 0)
      throw new AppError(409, 'REAL_TEST_BUDGET_BLOCKED', '账本有待核对用量，请先由负责人核账。');
    const catalog = z
      .object({
        data: z.array(
          z.object({
            id: z.string(),
            pricing: z.object({ prompt: z.string(), completion: z.string() }),
          }),
        ),
      })
      .parse(await transport.catalog(model));
    const price = catalog.data.find((entry) => entry.id === model.upstreamModel)?.pricing;
    if (
      !price ||
      usdToNano(price.prompt) * 1_000_000n !== usdToNano(model.prices.inputUsdPerMillion) ||
      usdToNano(price.completion) * 1_000_000n !== usdToNano(model.prices.outputUsdPerMillion)
    )
      throw new AppError(409, 'REAL_TEST_PRICE_CHANGED', '请核对模型价格后重试。');
    const userId = (
      await pool.query<{ id: string }>(
        "SELECT id FROM app_user WHERE username='zhangsan' AND is_development=true AND status='active'",
      )
    ).rows[0]?.id;
    if (!userId) throw new Error('REAL_TEST_ACCOUNT_MISSING');
    const starting = (
      await pool.query<{ id: string }>(
        'SELECT current_version_id AS id FROM workspace WHERE project_id=$1',
        [developmentProjectId],
      )
    ).rows[0]?.id;
    if (!starting) throw new Error('REAL_TEST_WORKSPACE_MISSING');
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const goal = (
        await tx.query<{ direction_version: number }>(
          "SELECT direction_version FROM goal WHERE id=$1 AND project_id=$2 AND status='active' FOR SHARE",
          [developmentGoalId, developmentProjectId],
        )
      ).rows[0];
      if (!goal) throw new Error('REAL_TEST_GOAL_INACTIVE');
      conversationId = (
        await tx.query<{ id: string }>(
          'INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [
            developmentProjectId,
            userId,
            developmentGoalId,
            l08 ? 'L08 K号写法真实模型验收' : 'Pi内核真实多轮验证（合成文本）',
            l08 ? 'ask' : 'read_only',
          ],
        )
      ).rows[0]!.id;
      runId = (
        await tx.query<{ id: string }>(
          "INSERT INTO run(conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status) VALUES($1,$2,$3,$4,$5,'evaluation','queued') RETURNING id",
          [conversationId, userId, developmentProjectId, developmentGoalId, goal.direction_version],
        )
      ).rows[0]!.id;
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
    const nextLabel = randomUUID();
    const reads: string[] = [];
    const probe: ToolDefinition = {
      metadata: {
        name: 'probe_read',
        version: 'smoke-v1',
        publication: 'published',
        effect: 'read',
        approvalInAsk: false,
        modes: ['read_only', 'ask'],
        outputDataLevel: 'internal',
        authorizationAction: 'project.read',
        description: {
          purpose: '读取本地合成验收值，不接触业务资料，不修改业务数据。',
          whenToUse: '仅用于当前真实内核验收，先用start，再读取返回的nextLabel。',
          avoid: '不用于资料检索、业务写入、批准或发送；真实资料请用doc_read。',
          parameters: 'label：start或上一次回执中的nextLabel。',
          example: { label: 'start' },
        },
      },
      inputSchema: z.object({ label: z.string().min(1).max(64) }).strict(),
      outputSchema: z.object({ value: z.string(), nextLabel: z.string().nullable() }).strict(),
      async execute(_ctx, input) {
        const { label } = z.object({ label: z.string() }).parse(input);
        if (label !== 'start' && (label !== nextLabel || !reads.includes('start')))
          throw new AppError(422, 'PROBE_LABEL_INVALID', '先读取start，再使用回执中的nextLabel。');
        reads.push(label);
        return {
          data: {
            value: label === 'start' ? '第一步读取完成' : 'LOCAL-ONLY',
            nextLabel: label === 'start' ? nextLabel : null,
          },
          dataLevel: 'internal',
        };
      },
    };
    await appendConversationMessage(pool, {
      runId,
      userId,
      requestKey: randomUUID(),
      message: {
        role: 'user',
        content: l08
          ? `检查L08申报资料中对比器械K号的写法。请优先在已导入的 510(k) 摘要中查找 510(k) number，读取足以支持两处写法的相关片段。把差异列为待确认。在工作副本中新建“交付/L08-K号核查-${randomUUID().slice(0, 8)}.md”，简要记录原文、位置和待确认事项。保存为工作区版本，以同一份结构化结果通过原文检查后送审。项目说明已随对话提供，本次无需查看旧核查稿。`
          : '请做合成内核连通性验收：先调用probe_read，label=start；看到回执后，再调用同一工具，label为回执中的nextLabel。然后简短汇报第二次的value。本次只读，不生成审核或业务改动，不需要技能。必须两轮依次调用，不能猜测nextLabel。',
      },
    });
    const gateway = new ModelGateway(pool, models, transport, { environment: 'development' });
    const store = new BlobStore(dependencies.storage, config.MINIO_BUCKET);
    const definitions = l08
      ? (await buildAgentTools(store, 'registration')).filter(
          (tool) => !['queue_internal_message', 'propose_external'].includes(tool.metadata.name),
        )
      : [probe];
    const runtime = { pool, store, gateway, models, definitions };
    const done = await executeAgentRun(runtime, runId);
    if (l08) {
      const tools = (
        await pool.query<{ tool_name: string }>(
          "SELECT tool_name FROM tool_invocation WHERE run_id=$1 AND status='completed'",
          [runId],
        )
      ).rows;
      const names = new Set(tools.map((tool) => tool.tool_name));
      if (
        done.status !== 'waiting' ||
        !done.reviewId ||
        !done.usage ||
        done.usage.costNano === null
      ) {
        console.error(
          `L08 运行结果为 ${done.status}（${done.reasonCode ?? 'RUN_STATUS_UNAVAILABLE'}），成功登记工具 ${[...names].join('、')}。`,
        );
        throw new AppError(422, 'REAL_L08_REVIEW_NOT_REACHED', '请核对 L08 工具与审核记录。');
      }
      const card = (
        await pool.query<{
          structured_result: unknown;
          check_report: unknown;
          evidence_refs: unknown;
          workspace_version_id: string;
        }>(
          "SELECT structured_result,check_report,evidence_refs,workspace_version_id FROM review_card WHERE id=$1 AND run_id=$2 AND status='pending'",
          [done.reviewId, runId],
        )
      ).rows[0];
      const proof = z.array(reviewEvidenceRefSchema).min(2).safeParse(card?.evidence_refs);
      const checked = checkReportSchema.safeParse(card?.check_report);
      const submission = structuredSubmissionSchema.safeParse(card?.structured_result);
      const file = await pool.query(
        `SELECT b.path FROM workspace_file b LEFT JOIN workspace_file a ON a.version_id=$2 AND a.path=b.path
         WHERE b.version_id=$1 AND (b.path LIKE '交付/%' OR b.path LIKE '草稿/%') AND b.path LIKE '%.md'
         AND b.sha256 IS DISTINCT FROM a.sha256`,
        [card?.workspace_version_id ?? starting, starting],
      );
      if (
        !card ||
        !checked.success ||
        !checked.data.passed ||
        !submission.success ||
        !proof.success ||
        card.workspace_version_id === starting ||
        !file.rowCount ||
        !names.has('doc_search') ||
        !names.has('doc_read') ||
        !names.has('workspace_save') ||
        !names.has('check_run') ||
        !['K170825', 'K170285'].every((number) =>
          proof.data.some((ref) => ref.quote.toUpperCase().includes(number)),
        )
      )
        throw new AppError(
          422,
          'REAL_L08_EVIDENCE_INCOMPLETE',
          'L08 验收缺少两处实际引语、保存版本或通过核验的审核卡。',
        );
      passed = true;
      console.log(
        `L08 资料检索、读取、写入、保存与审核卡验收通过，${done.usage.steps} 次调用。本次 ${nanoToUsd(BigInt(done.usage.costNano))} 美元。人工决定留浏览器验收。`,
      );
      return;
    }
    const events = (
      await pool.query<{ seq: string }>(
        'SELECT seq FROM conversation_event WHERE conversation_id=$1 ORDER BY seq',
        [conversationId],
      )
    ).rows;
    const messages = (
      await pool.query<{ message_json: { role: string; content: string | null } }>(
        'SELECT message_json FROM conversation_message WHERE conversation_id=$1 ORDER BY seq',
        [conversationId],
      )
    ).rows;
    if (
      done.status !== 'completed' ||
      !done.usage ||
      done.usage.costNano === null ||
      reads[0] !== 'start' ||
      !reads.includes(nextLabel) ||
      !events.length ||
      !events.every((event, index) => Number(event.seq) === index + 1) ||
      !messages.some(
        ({ message_json: msg }) => msg.role === 'assistant' && msg.content?.includes('LOCAL-ONLY'),
      )
    )
      throw new AppError(
        422,
        'REAL_AGENT_ASSERTION_FAILED',
        '真实内核行为未满足验收，费用已入账。',
      );
    const again = await executeAgentRun(runtime, runId);
    if (!again.skipped) throw new Error('REAL_AGENT_REPLAYED');
    passed = true;
    console.log(
      `真实Pi验收通过：${model.upstreamModel}，多轮登记只读工具、连续事件、结束不重放；${done.usage.steps}次调用，本次${nanoToUsd(BigInt(done.usage.costNano))}美元。`,
    );
  } finally {
    try {
      if (conversationId && runId) {
        // 不删除测试账本。只归档本测试对话，保留失败与未知计费记录供核对。
        await pool.query(
          "UPDATE conversation SET status='archived',version=version+1 WHERE id=$1",
          [conversationId],
        );
        await pool.query(
          "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'run',$2)",
          [passed ? 'agent.real_smoke_passed' : 'agent.real_smoke_failed', runId],
        );
      }
      const summary = await getBudgetSummary(pool);
      console.log(
        `累计已计费用${nanoToUsd(BigInt(summary.nightCostNano))}美元，未结算预占${nanoToUsd(BigInt(summary.nightReservedNano))}美元。`,
      );
    } finally {
      await Promise.all([transport.close(), dependencies.close()]);
    }
  }
}
main().catch((error: unknown) => {
  console.error(
    `真实内核验收未通过（${error instanceof AppError ? error.code : 'REAL_AGENT_SMOKE_FAILED'}）；请核对持久账本，未输出正文或凭据。`,
  );
  process.exitCode = 1;
});
