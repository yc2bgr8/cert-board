import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import type pg from 'pg';
import type { Page } from 'playwright-core';
import {
  checkReportSchema,
  documentPageReadSchema,
  reviewDiffSchema,
  rulesRunResultSchema,
} from '@cert-board/shared';
import { nanoToUsd } from '../budget/meter.js';
import { normalizeWhitespace } from '../checks/quotes.js';
import type { BlobStore } from '../documents/blob-store.js';

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
  reportPath: string,
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
    .changes.find(({ path }) => path === reportPath);
  const { changes: current, approvalBase } = reviewDiffSchema.parse(revised.diff);
  assert.equal(current.length, 1, '重提审核只应显示这一份报告的修改。');
  const change = current[0]!;
  assert.ok(original?.afterSha256 && change.afterSha256 && change.beforeSha256);
  assert.equal(change.change, 'modified');
  assert.equal(change.path, reportPath);
  assert.equal(change.beforeSha256, original.afterSha256);
  assert.ok(
    approvalBase?.changes.some(
      (item) =>
        item.path === reportPath &&
        item.change === 'added' &&
        item.afterSha256 === change.afterSha256,
    ),
    '重提审核的完整待批范围应包含本轮报告。',
  );
  const [before, after] = await Promise.all([
    blobs.get(original.afterSha256),
    blobs.get(change.afterSha256),
  ]);
  assert.ok(
    normalize(after.toString('utf8')) === expectedR09Revision(before.toString('utf8')),
    '重提报告应只改变指定的两行。',
  );
  return {
    twoEdits: true,
    exactCitationChecks: true,
    cumulativeReviewDiff: true,
    cost: await conversationCosts(pool, conversationId),
  };
}

async function conversationCosts(pool: pg.Pool, conversationId: string) {
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
  return cost.map(({ paid, ...row }) => ({ ...row, usd: nanoToUsd(BigInt(paid)) }));
}

export async function readOnlyWorkspaceSnapshot(
  pool: pg.Pool,
  projectId: string,
  conversationId: string,
) {
  const { rows } = await pool.query<{ workspace: unknown }>(
    `SELECT jsonb_build_object(
       'current', w.current_version_id,
       'versions', (SELECT count(*) FROM workspace_version WHERE workspace_id=w.id),
       'draft', (SELECT jsonb_build_object('version',d.version,'base',d.base_version_id,'files',
         (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.path) FROM workspace_draft_file f WHERE f.draft_id=d.id))
         FROM workspace_draft d WHERE d.workspace_id=w.id AND d.conversation_id=$2)
     ) AS workspace FROM workspace w WHERE project_id=$1`,
    [projectId, conversationId],
  );
  assert.equal(rows.length, 1);
  return rows[0]!.workspace;
}

const packageSummary = /核对摘要[：:]\s*水温\s*不同用途\s*[,，]\s*MSDS\s*待核证据[。.]?/u;
const packageSources = [
  {
    key: 'D021',
    page: 29,
    use: '冲洗',
    originalUse: /rins/iu,
    temperature: /20-25\s*(?:°\s*C|℃)/u,
  },
  {
    key: 'D023',
    page: 17,
    use: '冷却',
    originalUse: /cool/iu,
    temperature: /20-30\s*(?:°\s*C|℃)/u,
  },
] as const;

export function r09ReadOnlyAnswerMatches(
  answer: string,
  pages: readonly { sourceKey: string; page: number; text: string }[],
  msds: { sourceKey: string; page: number },
) {
  const lines = answer
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const summary = lines.at(-1);
  if (!summary || summary.match(packageSummary)?.[0] !== summary) return false;
  for (const source of packageSources) {
    const reads = pages.filter(
      ({ sourceKey, page }) => sourceKey === source.key && page === source.page,
    );
    const locator = new RegExp(
      `^(?:[-*]\\s+)?${source.use}\\s+${source.key}\\s*第\\s*${source.page}\\s*页`,
      'u',
    );
    const quoteMatches = lines.some((line) => {
      if (!locator.test(line)) return false;
      const quote = line.match(/「([^」]+)」/u)?.[1];
      return Boolean(
        quote &&
        source.originalUse.test(quote) &&
        source.temperature.test(quote) &&
        reads.some(({ text }) => normalizeWhitespace(text).includes(normalizeWhitespace(quote))),
      );
    });
    if (!quoteMatches) return false;
  }
  return lines.slice(0, -1).some((line) => {
    const note = /^(?:[-*]\s+)?MSDS[：:]\s*已定位\s*([^;；。]+)[;；](.+)$/iu.exec(line);
    if (!note) return false;
    const location = note[1]!.replace(/\s+/gu, '');
    const missing = note[2]!.trim();
    const detail = missing.replace(/^缺失\s*[：:]\s*/u, '');
    const saysComplete = detail.split(/[，,。；;]/u).some((clause) => {
      const statement = clause.trim();
      return (
        !/(?:无法|不能|未能|尚未|是否)/u.test(statement) &&
        /(?:无缺|不缺|无需|已齐全|已完备|已经全部|已找到|已取得|(?:需|待)归档|^无$)/u.test(
          statement,
        )
      );
    });
    return (
      !saysComplete &&
      location.startsWith(`${msds.sourceKey}第${msds.page}页`) &&
      /(?:缺|待补|未见|未找到|没有|(?:仍|还)需补)/u.test(missing) &&
      /(?:第二处|另一处|独立|对照|附件|原件|文件|安全数据|报告)/u.test(detail)
    );
  });
}

export async function checkR09PackageReadOnly(
  page: Page,
  pool: pg.Pool,
  runId: string,
  conversationId: string,
) {
  const end = Date.now() + 360_000;
  let complete = false;
  while (Date.now() < end) {
    const status = (
      await pool.query<{ status: string }>('SELECT status FROM run WHERE id=$1', [runId])
    ).rows[0]?.status;
    if (status === 'completed') {
      complete = true;
      break;
    }
    assert.ok(status === 'queued' || status === 'running', 'R09 只读整包核查未完成。');
    await wait(1000);
  }
  assert.ok(complete, 'R09 只读整包核查超时。');
  const { rows } = await pool.query<{ tool: string; effect: string; data: unknown }>(
    `SELECT i.tool_name AS tool,i.effect,o.content_json->'result'->'data' AS data
       FROM tool_invocation i LEFT JOIN conversation_tool_result o ON o.invocation_id=i.id
       WHERE i.run_id=$1 AND i.status='completed'`,
    [runId],
  );
  assert.ok(
    rows.every(({ effect }) => effect === 'read'),
    '只读运行执行了非读取动作。',
  );
  const rules = rows
    .filter(({ tool }) => tool === 'rules_run')
    .map(({ data }) => rulesRunResultSchema.parse(data))
    .flatMap((data) => (data.status === 'ok' ? data.findings : []));
  assert.ok(
    rules.some(
      (item) =>
        item.ruleId === 'R3' &&
        item.values.some(({ value }) => value === '20-25℃') &&
        item.values.some(({ value }) => value === '20-30℃'),
    ),
  );
  const msds = rules.find(
    (item) =>
      item.ruleId === 'R5' &&
      item.values.some(({ value }) => /MSDS/iu.test(value)) &&
      item.references.length === 1,
  )?.references[0];
  assert.ok(msds, 'R5 回执应提供一处 MSDS 定位。');
  const read = rows
    .filter(({ tool }) => tool === 'doc_read')
    .map(({ data }) => documentPageReadSchema.parse(data));
  assert.ok(
    read.some(
      ({ sourceKey, page, text }) => sourceKey === 'D021' && page === 29 && /20-25/u.test(text),
    ),
  );
  assert.ok(
    read.some(
      ({ sourceKey, page, text }) =>
        sourceKey === 'D023' && page === 17 && /20-30/u.test(text) && /cool/iu.test(text),
    ),
  );
  const { rows: messages } = await pool.query<{ text: string }>(
    `SELECT message_json->>'content' AS text FROM conversation_message
       WHERE run_id=$1 AND message_json->>'role'='assistant'
         AND jsonb_typeof(message_json->'content')='string' AND btrim(message_json->>'content')<>''
       ORDER BY seq DESC LIMIT 1`,
    [runId],
  );
  assert.ok(
    r09ReadOnlyAnswerMatches(messages[0]?.text ?? '', read, msds),
    '只读核查的最终回复需包含逐字引语、页码、各自用途、MSDS 证据缺口和复判摘要。',
  );
  await page
    .locator('article.live-agent-message')
    .last()
    .getByText(packageSummary)
    .waitFor({ timeout: 15_000 });
  const review = await pool.query('SELECT 1 FROM review_card WHERE conversation_id=$1', [
    conversationId,
  ]);
  assert.equal(review.rowCount, 0, '只读整包核查不应生成审核卡。');
  return {
    differentUses: true,
    singleSourcePending: true,
    exactReadOnlyEvidence: true,
    cost: await conversationCosts(pool, conversationId),
  };
}
