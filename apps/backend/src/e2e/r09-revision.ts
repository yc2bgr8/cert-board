import assert from 'node:assert/strict';
import type pg from 'pg';
import { checkReportSchema, reviewDiffSchema } from '@cert-board/shared';
import { nanoToUsd } from '../budget/meter.js';
import type { BlobStore } from '../documents/blob-store.js';

export const r09RevisionPath = '交付/R09-双修改走查.md';
export const r09Replacements = [
  ['范围说明：本轮核对 D035。', '范围说明：本轮核对 D035 的两个原文位置。'],
  ['下次核对：请核实对比器械编号。', '下次核对：请按原件和附件清单核实对比器械编号。'],
] as const;
const normalize = (text: string) => text.replace(/\r\n/gu, '\n');

export function expectedR09Revision(original: string) {
  const normalized = normalize(original);
  const lines = normalized.split('\n');
  for (const [before] of r09Replacements)
    assert.equal(lines.filter((line) => line === before).length, 1, '初稿应有唯一的待修改行。');
  const edits = new Map<string, string>(r09Replacements);
  return lines.map((line) => edits.get(line) ?? line).join('\n');
}

export async function checkR09Revision(
  pool: pg.Pool,
  blobs: BlobStore,
  initialCardId: string,
  revisedCardId: string,
  conversationId: string,
) {
  const { rows } = await pool.query<{ id: string; diff: unknown; checks: unknown }>(
    'SELECT id,diff,check_report AS checks FROM review_card WHERE id=ANY($1::uuid[]) AND conversation_id=$2',
    [[initialCardId, revisedCardId], conversationId],
  );
  const initial = rows.find(({ id }) => id === initialCardId);
  const revised = rows.find(({ id }) => id === revisedCardId);
  assert.ok(initial && revised);
  for (const card of [initial, revised]) {
    const check = checkReportSchema.parse(card.checks);
    assert.ok(
      check.passed && check.checks.some(({ code, status }) => code === 'V1' && status === 'passed'),
    );
  }
  const original = reviewDiffSchema
    .parse(initial.diff)
    .changes.find(({ path }) => path === r09RevisionPath);
  const current = reviewDiffSchema.parse(revised.diff).changes;
  assert.equal(current.length, 1, '重提审核只应显示这一份报告的修改。');
  const change = current[0]!;
  assert.ok(original?.afterSha256 && change.afterSha256 && change.beforeSha256);
  assert.equal(change.change, 'modified');
  assert.equal(change.path, r09RevisionPath);
  assert.equal(change.beforeSha256, original.afterSha256);
  const [before, after] = await Promise.all([
    blobs.get(original.afterSha256),
    blobs.get(change.afterSha256),
  ]);
  assert.ok(
    normalize(after.toString('utf8')) === expectedR09Revision(before.toString('utf8')),
    '重提报告应只改变指定的两行。',
  );
  const { rows: cost } = await pool.query<{
    model: string;
    paid: string;
    unknown: number;
    calls: number;
  }>(
    `SELECT model_id AS model,COALESCE(sum(actual_nano) FILTER(WHERE status='settled'),0)::text AS paid,
       count(*) FILTER(WHERE status IN ('unknown','reserved'))::int AS unknown,count(*)::int AS calls
       FROM usage_ledger WHERE conversation_id=$1 GROUP BY model_id ORDER BY model_id`,
    [conversationId],
  );
  assert.ok(cost.some(({ model }) => model === 'openai/gpt-6.2-astra-pro'));
  return {
    twoEdits: true,
    exactCitationChecks: true,
    cost: cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
