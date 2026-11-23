import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import { identifierCheckResultSchema, officialLookupResultSchema } from '@cert-board/shared';
import { nanoToUsd } from '../budget/meter.js';

export async function checkOfficialBrowserRun(
  page: Page,
  pool: pg.Pool,
  runId: string,
  evidenceFolder: string,
) {
  const deadline = Date.now() + 300_000;
  let finished = false;
  while (Date.now() < deadline) {
    const run = (
      await pool.query<{ status: string }>('SELECT status FROM run WHERE id=$1', [runId])
    ).rows[0];
    assert.ok(run);
    if (run.status === 'completed') {
      finished = true;
      break;
    }
    assert.ok(['queued', 'running'].includes(run.status), '官方回查没有完成对话');
    await wait(1000);
  }
  assert.ok(finished, '官方回查对话超时');
  const { rows } = await pool.query<{ tool_name: string; data: unknown }>(
    `SELECT i.tool_name,r.content_json->'result'->'data' AS data
     FROM tool_invocation i JOIN conversation_tool_result r ON r.invocation_id=i.id
     WHERE i.run_id=$1 AND i.status='completed' ORDER BY i.created_at,i.id`,
    [runId],
  );
  assert.ok(
    rows.some(({ tool_name }) => tool_name === 'doc_read'),
    '对话缺少实际原文读取',
  );
  const result = rows
    .filter(({ tool_name }) => tool_name === 'official_lookup')
    .map(({ data }) => officialLookupResultSchema.parse(data))
    .find(
      ({ status, ...data }) =>
        status === 'ok' &&
        'records' in data &&
        data.records.some(
          (record) =>
            record.identifier === 'K170825' &&
            record.productCode === 'LRK' &&
            record.regulationNumber === '872.5570' &&
            record.deviceClass === '2',
        ),
    );
  assert.ok(result?.status === 'ok' && result.evidence && !result.cached);
  const officialDocument = result.evidence.documentId;
  const verified = rows
    .filter(({ tool_name }) => tool_name === 'identifier_check')
    .map(({ data }) => identifierCheckResultSchema.parse(data))
    .find(
      (data) =>
        data.status === 'possible_typo' &&
        data.observed.identifier === 'K170285' &&
        data.references.some(({ documentId }) => documentId === officialDocument) &&
        data.candidates.some(({ identifier, edits }) => identifier === 'K170825' && edits === 1),
    );
  assert.ok(verified, '未使用实际官方存档发现编号对调');
  await page
    .getByText(/K170285.*(?:疑似|对调|笔误)|(?:疑似|对调|笔误).*K170285/u)
    .last()
    .waitFor({ timeout: 15_000 });
  await page
    .getByText(/^工具过程/u)
    .first()
    .click();
  await page
    .getByText(/回查官方器械编号/u)
    .last()
    .waitFor();
  await page
    .getByText(/核对标识符及疑似笔误/u)
    .last()
    .waitFor();
  await page.screenshot({ path: path.join(evidenceFolder, 'official-verification.png') });
  const cost = (
    await pool.query<{ model: string; paid: string; unknown: number; calls: number }>(
      `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,count(*)::int AS calls
       FROM usage_ledger WHERE run_id=$1 GROUP BY model_id ORDER BY model_id`,
      [runId],
    )
  ).rows;
  assert.ok(cost.some(({ model }) => model === 'openai/gpt-6.2-astra-pro'));
  return {
    steps: ['doc_read', 'official_lookup', 'identifier_check'],
    verified: 'K170825',
    possibleTypo: 'K170285',
    cost: cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
