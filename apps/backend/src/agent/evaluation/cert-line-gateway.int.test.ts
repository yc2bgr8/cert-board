import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { selectGatewayModel } from '@cert-board/shared';
import { certEvalCases } from '../../../../../evals/cert-line/cases.js';
import { mockOutput } from '../../../../../evals/cert-line/score.js';
import { seedDevelopmentBudgetPolicy } from '../../budget/service.js';
import { loadModelGatewayConfig } from '../../modelgw/config.js';
import { ModelGateway } from '../../modelgw/service.js';
import { createIntegrationContext } from '../../test-support/context.js';
import { runCertLineGateway } from './cert-line-gateway.js';
import { compareCertLineReports } from './cert-line-comparison.js';

const cases = certEvalCases();

test.each(['completed', 'interrupted'] as const)(
  '认证线网关模拟运行保存实际账本及逐例报告（%s）',
  async (outcome) => {
    const context = await createIntegrationContext();
    try {
      const pool = context.pool;
      await seedDevelopmentBudgetPolicy(pool, 'test');
      const models = await loadModelGatewayConfig({ environment: 'development', sourceEnv: {} });
      const model = selectGatewayModel(models, 'evaluation');
      expect(model).toBeDefined();
      const directory = await mkdtemp(path.join(tmpdir(), 'cert-line-fixture-'));
      const file = path.join(directory, 'cert-line-result.json');
      let calls = 0;
      const gateway = new ModelGateway(
        pool,
        models,
        {
          kind: 'fixture',
          async send(_profile, body) {
            const item = cases[calls++]!;
            expect(body).toMatchObject({ tool_choice: 'none', temperature: 0.2, max_tokens: 4000 });
            expect(body.tools).toBeUndefined();
            const before = JSON.parse(await readFile(file, 'utf8'));
            expect(before.pending).toMatchObject({ id: item.id, requestKey: expect.any(String) });
            if (outcome === 'interrupted' && calls === 2)
              throw new Error('SYNTHETIC_UPSTREAM_FAILURE');
            return {
              id: randomUUID(),
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: JSON.stringify(mockOutput(item)),
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, cost: 0.000001 },
            };
          },
        },
        { environment: 'test' },
      );
      const args = { pool, gateway, model: model!, directory, scope: null };
      const run = runCertLineGateway(args);
      if (outcome === 'completed') {
        const result = await run;
        expect(result.comparison).toBeNull();
        expect(result.report.results).toHaveLength(120);
        expect(
          result.report.results.every(
            ({ pass, valid, costUsd }) => pass && valid && costUsd === 0.000001,
          ),
        ).toBe(true);
      } else {
        await expect(run).rejects.toMatchObject({ code: 'MODEL_UPSTREAM_FAILED' });
      }
      expect(calls).toBe(outcome === 'completed' ? 120 : 2);
      const report = JSON.parse(await readFile(file, 'utf8'));
      expect(report).toMatchObject({ status: outcome, mock: true, acceptance: null });
      const first = await pool.query('SELECT status FROM usage_ledger WHERE run_id=$1', [
        report.results[0].runId,
      ]);
      expect(first.rows).toEqual([{ status: 'settled' }]);
      expect(() => compareCertLineReports(report)).toThrow();
      if (outcome === 'interrupted') {
        expect(report.results.map(({ id }: { id: string }) => id)).toEqual([cases[0]!.id]);
        expect(report.pending).toMatchObject({ id: cases[1]!.id });
        const pending = await pool.query('SELECT status FROM usage_ledger WHERE request_key=$1', [
          report.pending.requestKey,
        ]);
        expect(pending.rows).toEqual([{ status: 'unknown' }]);
      } else {
        expect(report.pending).toBeNull();
      }
      const stored = await pool.query(
        `SELECT count(*)::int AS calls,count(DISTINCT u.run_id)::int AS runs,
          count(*) FILTER(WHERE c.status='archived')::int AS archived,
          sum(u.actual_nano)::text AS settled
          FROM usage_ledger u JOIN conversation c ON c.id=u.conversation_id
          WHERE c.title='认证线参考评测（示例）'`,
      );
      expect(stored.rows).toEqual([
        {
          calls,
          runs: calls,
          archived: calls,
          settled: String((outcome === 'completed' ? calls : 1) * 1000),
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT action FROM audit_log WHERE action LIKE 'evaluation.cert_line_%'",
          )
        ).rows,
      ).toEqual([{ action: `evaluation.cert_line_${outcome}` }]);
      await expect(runCertLineGateway(args)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(calls).toBe(outcome === 'completed' ? 120 : 2);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(report);
    } finally {
      await context.close();
    }
  },
  90000,
);
