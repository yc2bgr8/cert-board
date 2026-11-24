import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { knowledgeGetResultSchema } from '@cert-board/shared';
import { nanoToUsd } from '../budget/meter.js';
import { parseWalkthroughJson } from './walkthrough-json.js';

const answerSchema = z.strictObject({
  版本: z.string(),
  状态: z.enum(['待注册人员确认', '已确认', '待核']),
  开始: z.string(),
  结束: z.string(),
  财年: z.number().int(),
  金额: z.number().finite(),
  币种: z.string(),
  代理人数: z.number().int(),
  来源: z.string().array().length(3),
});

export async function checkKnowledgeWalkthrough(
  page: Page,
  pool: pg.Pool,
  runId: string,
  conversationId: string,
) {
  const end = Date.now() + 240_000;
  let complete = false;
  while (Date.now() < end) {
    const status = (
      await pool.query<{ status: string }>('SELECT status FROM run WHERE id=$1', [runId])
    ).rows[0]?.status;
    if (status === 'completed') {
      complete = true;
      break;
    }
    assert.ok(status === 'queued' || status === 'running', '规则包只读走查未完成。');
    await wait(1000);
  }
  assert.ok(complete, '规则包只读走查超时。');
  const { rows: calls } = await pool.query<{ tool: string; effect: string; data: unknown }>(
    `SELECT i.tool_name AS tool,i.effect,o.content_json->'result'->'data' AS data
       FROM tool_invocation i LEFT JOIN conversation_tool_result o ON o.invocation_id=i.id
       WHERE i.run_id=$1 AND i.status='completed'`,
    [runId],
  );
  assert.ok(calls.every(({ effect }) => effect === 'read'));
  const returned = calls
    .filter(({ tool }) => tool === 'knowledge_get')
    .map(({ data }) => knowledgeGetResultSchema.parse(data))
    .find((value) => value.kind === 'rule_pack' && value.pack?.code === 'us_fda_m02');
  assert.ok(returned?.kind === 'rule_pack' && returned.pack);
  const { pack } = returned;
  assert.equal(pack.publication, 'development');
  assert.equal(pack.rules.length, 5);
  assert.ok(
    pack.rules.every(
      (record) =>
        record.status === 'pending_confirmation' && record.source.archiveUrl.startsWith('https://'),
    ),
  );
  const pin = await pool.query<{ version_id: string }>(
    'SELECT version_id FROM run_rule_pack WHERE run_id=$1',
    [runId],
  );
  assert.deepEqual(
    pin.rows.map(({ version_id }) => version_id),
    [pack.versionId],
  );
  const writes = await pool.query('SELECT 1 FROM fact_candidate WHERE proposal_run_id=$1', [runId]);
  assert.equal(writes.rowCount, 0);
  const {
    rows: [message],
  } = await pool.query<{ text: string }>(
    `SELECT message_json->>'content' AS text FROM conversation_message WHERE run_id=$1
       AND message_json->>'role'='assistant' AND jsonb_typeof(message_json->'content')='string'
       AND btrim(message_json->>'content')<>'' ORDER BY seq DESC LIMIT 1`,
    [runId],
  );
  const answer = parseWalkthroughJson(message?.text ?? '', answerSchema);
  const annual = pack.rules.find(({ id }) => id === 'annual_registration_window');
  const fee = pack.rules.find(({ id }) => id === 'fiscal_2027_registration_fee');
  const agent = pack.rules.find(({ id }) => id === 'foreign_establishment_us_agent');
  assert.ok(annual?.parameters && fee?.parameters && agent);
  assert.ok(
    answer &&
      answer.版本 === pack.version &&
      answer.状态 === '待注册人员确认' &&
      answer.开始 === annual.parameters.window_start &&
      answer.结束 === annual.parameters.window_end &&
      answer.财年 === fee.parameters.fiscal_year &&
      answer.金额 === fee.parameters.amount &&
      answer.币种 === fee.parameters.currency &&
      answer.代理人数 === 1,
    '维护 Agent 的最终答复须对照实际规则包核对版本、数值和待确认状态。',
  );
  assert.deepEqual(
    [...answer.来源].sort(),
    [annual, fee, agent].map(({ source }) => source.url).sort(),
    '答复须逐条提供实际核对的出处。',
  );
  await page
    .locator('article.live-agent-message')
    .last()
    .getByText(/来源/u)
    .waitFor({ timeout: 15000 });
  const { rows: costs } = await pool.query<{
    model: string;
    paid: string;
    calls: number;
    unknown: number;
  }>(
    `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
              count(*)::int AS calls,count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown
       FROM usage_ledger WHERE conversation_id=$1 GROUP BY model_id ORDER BY model_id`,
    [conversationId],
  );
  assert.ok(costs.some(({ model, calls }) => model === 'openai/gpt-6.2-astra-pro' && calls > 0));
  return {
    version: pack.version,
    ruleCount: pack.rules.length,
    pinnedToRun: true,
    draftMarked: true,
    exactAnswer: true,
    readOnly: true,
    cost: costs.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
