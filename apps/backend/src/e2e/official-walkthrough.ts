import assert from 'node:assert/strict';
import path from 'node:path';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import {
  documentPageReadSchema,
  identifierCheckResultSchema,
  officialLookupResultSchema,
  reviewEvidenceRefSchema,
} from '@cert-board/shared';
import { nanoToUsd } from '../budget/meter.js';

export function officialReviewConclusionMatches(value: string) {
  const [lead] = value.trim().split(/[。.!！?？]/u, 1);
  return /^编号核对[：:]\s*材料\s*K170285\s*[，,]\s*官方\s*K170825\s*[，,]\s*差异\s*疑似笔误\s*[，,]\s*状态\s*待确认$/u.test(
    lead?.trim() ?? '',
  );
}

export async function checkOfficialBrowserRun(
  page: Page,
  pool: pg.Pool,
  runId: string,
  cardId: string,
  evidenceFolder: string,
) {
  const submitted = (
    await pool.query<{ evidence_refs: unknown }>(
      "SELECT evidence_refs FROM review_card WHERE id=$1 AND run_id=$2 AND status='pending'",
      [cardId, runId],
    )
  ).rows[0];
  assert.ok(submitted, '官方编号核对未形成同一次运行的待审核卡');
  const { rows } = await pool.query<{ tool_name: string; data: unknown }>(
    `SELECT i.tool_name,r.content_json->'result'->'data' AS data
     FROM tool_invocation i JOIN conversation_tool_result r ON r.invocation_id=i.id
     WHERE i.run_id=$1 AND i.status='completed' ORDER BY i.created_at,i.id`,
    [runId],
  );
  const readings = rows
    .filter(({ tool_name }) => tool_name === 'doc_read')
    .map(({ data }) => documentPageReadSchema.parse(data))
    .filter(({ sourceKey, text }) => sourceKey === 'D035' && text.includes('K170285'));
  assert.ok(readings.length, '对话未实际读取 D035 待核编号');
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
        readings.some(
          ({ documentId, version, page, contentSha256 }) =>
            data.observed.documentId === documentId &&
            data.observed.version === version &&
            data.observed.page === page &&
            data.observed.contentSha256 === contentSha256,
        ) &&
        data.references.some(({ documentId }) => documentId === officialDocument) &&
        data.candidates.some(({ identifier, edits }) => identifier === 'K170825' && edits === 1),
    );
  assert.ok(verified?.status === 'possible_typo', '未使用实际官方存档发现编号对调');
  const citations = reviewEvidenceRefSchema.array().parse(submitted.evidence_refs);
  const mustCite = [
    { documentId: verified.observed.documentId, identifier: 'K170285' },
    { documentId: officialDocument, identifier: 'K170825' },
  ];
  assert.ok(
    mustCite.every(({ documentId, identifier }) =>
      citations.some((cite) => cite.documentId === documentId && cite.quote.includes(identifier)),
    ),
  );
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
  await page.getByRole('button', { name: '查看审核', exact: true }).last().click();
  const card = page.getByRole('article', { name: '审核结果', exact: true });
  await card.getByRole('heading', { name: '审核卡', exact: true }).waitFor();
  const conclusion = await card
    .locator('section')
    .filter({
      has: page.getByRole('heading', { name: '结论', exact: true }),
    })
    .locator('.markdown-content')
    .innerText();
  assert.ok(
    officialReviewConclusionMatches(conclusion),
    '审核结论未按本次走查的格式标明两个编号、疑似笔误及待确认状态',
  );
  await card.getByRole('button', { name: '通过', exact: true }).click();
  await card.getByText('已通过，工作区版本已冻结。', { exact: true }).waitFor();
  assert.equal(
    (await pool.query('SELECT status FROM review_card WHERE id=$1', [cardId])).rows[0]?.status,
    'approved',
  );
  await page.screenshot({ path: path.join(evidenceFolder, 'official-approved.png') });
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
    steps: ['doc_read', 'official_lookup', 'identifier_check', 'submit_for_review'],
    approvedInBrowser: true,
    verified: 'K170825',
    possibleTypo: 'K170285',
    cost: cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) })),
  };
}
