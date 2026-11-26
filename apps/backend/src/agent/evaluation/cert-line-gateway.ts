import { randomUUID } from 'node:crypto';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { certEvalCases } from '../../../../../evals/cert-line/cases.js';
import { AppError } from '../../api/errors.js';
import type { ModelGateway } from '../../modelgw/service.js';
import { developmentGoalId, developmentProjectId } from '../../projects/seed.js';
import { compareCertLineReports } from './cert-line-comparison.js';
import {
  certLineOutputTokens,
  certLinePromptHashes,
  certLinePromptVersions,
  evaluateCertLineCase,
  prepareCertLineRequests,
  type CertLineResult,
} from './cert-line-run.js';
import type { validateCertLineScope } from './cert-line-scope.js';

type Context = { conversationId: string; userId: string };
type Scope = ReturnType<typeof validateCertLineScope>;
type Report = {
  date: string;
  model: string;
  mock: boolean;
  status: 'running' | 'completed' | 'interrupted';
  prompts: string[];
  promptHashes: Record<string, string>;
  acceptance: Scope | null;
  pending: { id: string; runId: string; requestKey: string } | null;
  results: (CertLineResult & { runId: string })[];
};

function stateError() {
  return new AppError(409, 'CERT_LINE_WORKSPACE', '请先完成验收数据库的开发项目与账号初始化。');
}

async function openEvaluation(pool: Pool): Promise<Context> {
  const {
    rows: [actor],
  } = await pool.query<{ id: string }>(
    "SELECT id FROM app_user WHERE username='zhangsan' AND is_development=true AND status='active'",
  );
  if (!actor) throw stateError();
  const {
    rows: [created],
  } = await pool.query<{ id: string }>(
    `INSERT INTO conversation(project_id,user_id,goal_id,title,permission_mode)
      SELECT project_id,$3,id,'认证线参考评测（示例）','read_only' FROM goal
      WHERE id=$1 AND project_id=$2 AND status='active' RETURNING id`,
    [developmentGoalId, developmentProjectId, actor.id],
  );
  if (!created) throw stateError();
  return { conversationId: created.id, userId: actor.id };
}

async function startCase(pool: Pool, { conversationId, userId }: Context) {
  const {
    rows: [run],
  } = await pool.query<{ id: string }>(
    `INSERT INTO run(conversation_id,user_id,project_id,goal_id,direction_version,trigger_type,status)
      SELECT c.id,c.user_id,c.project_id,c.goal_id,g.direction_version,'evaluation','running'
      FROM conversation c JOIN goal g ON g.id=c.goal_id AND g.project_id=c.project_id
      WHERE c.id=$1 AND c.user_id=$2 AND c.status='active' AND g.status='active' RETURNING id`,
    [conversationId, userId],
  );
  if (!run) throw stateError();
  return run.id;
}

async function closeEvaluation(pool: Pool, conversationId: string, action: string) {
  await pool.query(
    `WITH closed AS (
      UPDATE conversation SET status='archived',version=version+1
        WHERE id=$1 AND status='active' RETURNING id
    )
    INSERT INTO audit_log(actor_kind,action,target_type,target_id)
      SELECT 'system',$2,'conversation',id FROM closed`,
    [conversationId, action],
  );
}

export async function runCertLineGateway({
  pool,
  gateway,
  model,
  directory,
  scope,
  assertActive,
}: {
  pool: Pool;
  gateway: Pick<ModelGateway, 'complete'>;
  model: { id: string; upstreamModel: string; maxOutputTokens: number };
  directory: string;
} & ({ scope: Scope; assertActive: () => Promise<void> } | { scope: null; assertActive?: never })) {
  if (model.maxOutputTokens < certLineOutputTokens)
    throw new AppError(403, 'CERT_LINE_MODEL_LIMIT', '当前配置无法满足参考评测的输出上限。');
  const cases = certEvalCases();
  const requests = await prepareCertLineRequests(cases, model.id);
  const receipt = path.join(directory, 'cert-line-result.json');
  const report: Report = {
    date: new Date().toISOString().slice(0, 10),
    model: model.upstreamModel,
    mock: scope === null,
    status: 'running',
    prompts: certLinePromptVersions,
    promptHashes: certLinePromptHashes,
    acceptance: scope,
    pending: null,
    results: [],
  };
  const text = () => JSON.stringify(report, null, 2) + '\n';
  const checkpoint = async () => {
    const temporary = path.join(directory, `cert-line-result-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text());
      await handle.close();
      await rename(temporary, receipt);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
  await writeFile(receipt, text(), { flag: 'wx', mode: 0o600 });
  let context: Context | undefined;
  try {
    context = await openEvaluation(pool);
    const actor = context;
    for (const [index, item] of cases.entries()) {
      const runId = await startCase(pool, actor);
      let scored: CertLineResult | undefined;
      let closed: boolean;
      try {
        scored = await evaluateCertLineCase(
          item,
          requests[index]!,
          async (request, requestKey) => {
            const response = await gateway.complete(
              request,
              {
                ...actor,
                runId,
                requestKey,
                purpose: 'evaluation',
              },
              undefined,
              assertActive,
            );
            if (response.upstreamModel !== model.upstreamModel)
              throw new AppError(
                409,
                'CERT_LINE_MODEL_CHANGED',
                '实际返回模型与本轮评测配置不符。',
              );
            return response;
          },
          async (requestKey) => {
            report.pending = { id: item.id, runId, requestKey };
            await checkpoint();
          },
        );
      } finally {
        const result = await pool.query(
          "UPDATE run SET status=$2,finished_at=COALESCE(finished_at,now()),version=version+1 WHERE id=$1 AND status='running'",
          [runId, scored ? 'completed' : 'failed'],
        );
        closed = result.rowCount === 1;
      }
      if (!closed) throw stateError();
      report.results.push({ ...scored!, runId });
      report.pending = null;
      await checkpoint();
    }
    report.status = 'completed';
    const comparison = report.mock ? null : compareCertLineReports(report);
    await checkpoint();
    await closeEvaluation(pool, actor.conversationId, 'evaluation.cert_line_completed');
    return { comparison, report };
  } catch (error) {
    report.status = 'interrupted';
    await checkpoint().catch(() => undefined);
    if (context)
      await closeEvaluation(pool, context.conversationId, 'evaluation.cert_line_interrupted').catch(
        () => undefined,
      );
    throw error;
  }
}
