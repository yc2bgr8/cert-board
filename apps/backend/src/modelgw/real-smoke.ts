import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';
import { parseBackendConfig, upstreamAssistantResponseSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { developmentProjectId, developmentGoalId } from '../projects/seed.js';
import { getBudgetSummary } from '../budget/service.js';
import { nanoToUsd, usdToNano } from '../budget/meter.js';
import { loadModelGatewayConfig, parseAllowedModelHosts, ModelConfigError } from './config.js';
import { ModelGateway, type GatewayTransport } from './service.js';
import { RealGatewayTransport, GatewayTransportError } from './transport.js';

async function main() {
  const runtime = parseBackendConfig(process.env);
  if (runtime.NODE_ENV !== 'development')
    throw new AppError(
      403,
      'REAL_TEST_ENVIRONMENT',
      '真实连通性测试仅使用本地开发环境及持久账本。',
    );
  const config = await loadModelGatewayConfig({ environment: 'development' });
  const model = config.models.find((item) => item.enabled && item.purposes.includes('evaluation'));
  if (!model || !process.env[model.apiKeyEnv])
    throw new AppError(403, 'REAL_TEST_CONFIG', '未配置可用测试模型或模型凭据。');
  const hosts = parseAllowedModelHosts(
    await readFile(new URL('../../../../deploy/egress/allowlist', import.meta.url), 'utf8'),
  );
  const transport = new RealGatewayTransport({
    proxyUrl: process.env.HTTPS_PROXY ?? '',
    containerRuntime: runtime.CONTAINER_RUNTIME,
    allowedHosts: hosts,
  });
  const pool = new pg.Pool({ connectionString: runtime.DATABASE_URL, max: 5 });
  let runId: string | undefined, conversationId: string | undefined;
  let passed = false;
  try {
    // 公开目录同样经代理核对；失败时不会创建调用或使用模型额度。
    const catalog = z
      .object({
        data: z.array(
          z
            .object({
              id: z.string(),
              pricing: z.object({ prompt: z.string(), completion: z.string() }).passthrough(),
            })
            .passthrough(),
        ),
      })
      .parse(await transport.catalog(model));
    const entry = catalog.data.find((item) => item.id === model.upstreamModel);
    if (
      !entry ||
      usdToNano(entry.pricing.prompt) * 1_000_000n !== usdToNano(model.prices.inputUsdPerMillion) ||
      usdToNano(entry.pricing.completion) * 1_000_000n !==
        usdToNano(model.prices.outputUsdPerMillion)
    )
      throw new AppError(
        409,
        'REAL_TEST_PRICE_CHANGED',
        '模型目录价格与当前配置不一致，请核对配置后再运行真实测试。',
      );
    const accounts = await pool.query<{ id: string }>(
      "SELECT id FROM app_user WHERE username='zhangsan' AND is_development=true AND status='active'",
    );
    const userId = accounts.rows[0]?.id;
    if (!userId)
      throw new AppError(403, 'REAL_TEST_ACCOUNT_MISSING', '请先建立开发账号与L08项目。');
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const target = await tx.query<{ direction_version: number }>(
        "SELECT direction_version FROM goal WHERE id=$1 AND project_id=$2 AND status='active' FOR SHARE",
        [developmentGoalId, developmentProjectId],
      );
      if (!target.rows[0])
        throw new AppError(409, 'REAL_TEST_GOAL_INACTIVE', '开发目标尚未处于可测试状态。');
      const conversation = await tx.query<{ id: string }>(
        "INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode) VALUES($1,$2,$3,'模型网关连通性验证（合成文本）','read_only') RETURNING id",
        [developmentProjectId, userId, developmentGoalId],
      );
      conversationId = conversation.rows[0]!.id;
      const run = await tx.query<{ id: string }>(
        "INSERT INTO run(conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status) VALUES($1,$2,$3,$4,$5,'evaluation','running') RETURNING id",
        [
          conversationId,
          userId,
          developmentProjectId,
          developmentGoalId,
          target.rows[0].direction_version,
        ],
      );
      runId = run.rows[0]!.id;
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
    const checkedTransport: GatewayTransport = {
      kind: 'real',
      async send(profile, body, signal) {
        const raw = await transport.send(profile, body, signal);
        const checked = upstreamAssistantResponseSchema.safeParse(raw);
        if (!checked.success) {
          const fields = new Set([
            'id',
            'object',
            'created',
            'model',
            'choices',
            'index',
            'message',
            'role',
            'content',
            'tool_calls',
            'type',
            'function',
            'name',
            'arguments',
            'finish_reason',
          ]);
          console.warn(
            '上游格式校验项（不含正文）：' +
              JSON.stringify(
                checked.error.issues.map((issue) => ({
                  code: issue.code,
                  path: issue.path
                    .map((part) =>
                      typeof part === 'number' ? part : fields.has(String(part)) ? part : 'field',
                    )
                    .join('.'),
                  ...('keys' in issue
                    ? { extraKeys: issue.keys.map((key) => (fields.has(key) ? key : 'extra')) }
                    : {}),
                })),
              ),
          );
        }
        return raw;
      },
    };
    const gateway = new ModelGateway(pool, config, checkedTransport, {
      environment: 'development',
    });
    const result = await gateway.complete(
      {
        model: model.id,
        max_tokens: 256,
        tool_choice: 'auto',
        messages: [
          {
            role: 'system',
            content:
              '这是合成连通性测试。需要读取值时必须调用提供的只读工具。没有任何实际业务操作。',
          },
          {
            role: 'user',
            content: '请调用probe_read，参数label为connected，以取得合成测试值。现在只调用工具。',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'probe_read',
              description:
                '读取合成连通性测试值，无任何写入和外部发送。只在本测试需要读取值时使用。label必须为connected。示例：{"label":"connected"}。',
              parameters: {
                type: 'object',
                properties: { label: { type: 'string', enum: ['connected'] } },
                required: ['label'],
                additionalProperties: false,
              },
            },
          },
        ],
      },
      { requestKey: randomUUID(), runId, conversationId, userId, purpose: 'evaluation' },
    );
    const call = result.message.tool_calls?.find((item) => item.function.name === 'probe_read');
    let valid = false;
    try {
      valid = Boolean(
        call &&
        z
          .object({ label: z.literal('connected') })
          .strict()
          .safeParse(JSON.parse(call.function.arguments)).success,
      );
    } catch {
      /* 只记录安全验收结果。 */
    }
    if (!valid)
      throw new AppError(
        422,
        'REAL_TEST_TOOL_CALL_MISSING',
        '模型没有返回预期的只读工具调用，已登记费用，验收不通过。',
      );
    passed = true;
    console.log(
      `真实网关验收通过：${result.upstreamModel}返回指定工具调用；1次调用，本次${nanoToUsd(BigInt(result.usage.costNano))}美元。`,
    );
    const summary = await getBudgetSummary(pool);
    console.log(
      `整晚已计费用${nanoToUsd(BigInt(summary.nightCostNano))}美元，未结算预占${nanoToUsd(BigInt(summary.nightReservedNano))}美元。`,
    );
  } finally {
    if (runId && conversationId) {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('SELECT id FROM conversation WHERE id=$1 FOR UPDATE', [conversationId]);
        await tx.query(
          "UPDATE run SET status=$1,finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP),version=version+1 WHERE id=$2 AND status='running'",
          [passed ? 'completed' : 'failed', runId],
        );
        await tx.query("UPDATE conversation SET status='archived',version=version+1 WHERE id=$1", [
          conversationId,
        ]);
        await tx.query(
          "INSERT INTO audit_log(actor_kind,action,target_type,target_id) VALUES('system',$1,'run',$2)",
          [passed ? 'model_gateway.smoke_passed' : 'model_gateway.smoke_failed', runId],
        );
        await tx.query('COMMIT');
      } catch {
        await tx.query('ROLLBACK');
      } finally {
        tx.release();
      }
    }
    await transport.close();
    await pool.end();
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof AppError ||
    error instanceof ModelConfigError ||
    error instanceof GatewayTransportError
      ? error.code
      : 'REAL_SMOKE_FAILED';
  console.error(`真实模型验收未通过（${code}）。请查看预算账本；未输出请求、响应或凭据。`);
  process.exitCode = 1;
});
