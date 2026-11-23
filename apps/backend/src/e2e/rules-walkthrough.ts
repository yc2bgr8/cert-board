import assert from 'node:assert/strict';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import { reviewEvidenceRefSchema, rulesRunResultSchema } from '@cert-board/shared';
import { nanoToUsd } from '../budget/meter.js';

export async function checkRulesBrowserRun(
  page: Page,
  pool: pg.Pool,
  runId: string,
  cardId: string,
) {
  const { rows } = await pool.query<{ data: unknown }>(
    `SELECT r.content_json->'result'->'data' AS data
       FROM tool_invocation i JOIN conversation_tool_result r ON r.invocation_id=i.id
       WHERE i.run_id=$1 AND i.tool_name='rules_run' AND i.status='completed'`,
    [runId],
  );
  const responses = rows.map(({ data }) => rulesRunResultSchema.parse(data));
  const verified = responses.find(
    (output) =>
      output.status === 'ok' &&
      output.findings.some(
        (item) =>
          item.ruleId === 'R1' &&
          item.values.some(({ value }) => value === 'K170285') &&
          item.values.some(({ value }) => value === 'K170825') &&
          item.references.some(({ sourceKey }) => sourceKey === 'D035'),
      ) &&
      output.findings.some(
        (item) =>
          item.ruleId === 'R5' &&
          item.values.some(({ value }) => /MSDS/iu.test(value)) &&
          item.references.some(
            ({ sourceKey, locatorKind }) => sourceKey === 'D014' && locatorKind === 'xfa_datasets',
          ),
      ),
  );
  assert.ok(verified?.status === 'ok', '规则运行未在 L08 实际版本发现编号候选及 eSTAR 附件候选。');
  const doc = verified.scanned.find(({ sourceKey }) => sourceKey === 'D035');
  const card = (
    await pool.query<{ evidence_refs: unknown }>(
      "SELECT evidence_refs FROM review_card WHERE id=$1 AND run_id=$2 AND status='pending'",
      [cardId, runId],
    )
  ).rows[0];
  const citations = reviewEvidenceRefSchema.array().parse(card?.evidence_refs);
  assert.ok(doc);
  assert.ok(
    citations.some(
      (cite) =>
        cite.documentId === doc.documentId &&
        cite.version === doc.version &&
        /K170(?:285|825)/u.test(cite.quote),
    ),
  );
  await page
    .getByText(/^工具过程/u)
    .first()
    .click();
  await page
    .getByText(/运行资料一致性检查规则/u)
    .last()
    .waitFor();
  const { rows: usage } = await pool.query<{
    model: string;
    paid: string;
    unknown: number;
    calls: number;
  }>(
    `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,count(*)::int AS calls
       FROM usage_ledger WHERE run_id=$1 GROUP BY model_id ORDER BY model_id`,
    [runId],
  );
  assert.ok(usage.some(({ model }) => model === 'openai/gpt-6.2-astra-pro'));
  return {
    rules: ['R1', 'R5'],
    sourceVersions: verified.scanned.length,
    cost: usage.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
