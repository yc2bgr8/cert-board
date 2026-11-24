import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import {
  factProposalResultSchema,
  knowledgeReviewSummarySchema,
  type FactDecisionInput,
  type KnowledgeReviewCreateInput,
  type KnowledgeReviewDecisionInput,
} from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { factProposeTool, knowledgeGetTool } from '../tools/knowledge-tools.js';
import { ToolRegistry, type ToolExecutionContext } from '../tools/registry.js';
import { readConfirmedFacts, refreshConfirmedFactsLevel } from './facts.js';
import {
  parseRulePackSeed,
  publishDevelopmentRulePack,
  readRulePack,
  refreshRulePackLevel,
} from './rule-packs.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
afterEach(async () => context?.close());

const pack = parseRulePackSeed(
  readFileSync(new URL('../../../../knowledge/us-fda-m02.yaml', import.meta.url), 'utf8'),
);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fresh = ({ runId, userId }: { runId: string; userId: string }) => ({
  runId,
  userId,
  callId: randomUUID(),
});
const knowledgeReviewsUrl = '/api/knowledge/reviews';
const stageReview = (headers: Record<string, string>, payload: KnowledgeReviewCreateInput) =>
  context.app.inject({ method: 'POST', url: knowledgeReviewsUrl, headers, payload });
const decideReview = (
  headers: Record<string, string>,
  id: string,
  payload: KnowledgeReviewDecisionInput,
) =>
  context.app.inject({
    method: 'POST',
    url: `${knowledgeReviewsUrl}/${id}/decision`,
    headers,
    payload,
  });

async function fixtureSource(text = '合成证据：最初登记号 EX-01，后续更正值 EX-02。') {
  const docId = randomUUID();
  await context.pool.query(
    `INSERT INTO document (id,project_id,source_key,name,source_path,owner_user_id) VALUES($1,$2,$3,'合成事实资料','fact.txt',$4)`,
    [docId, context.projectId, `FACT-${docId}`, context.userId('MEMBER_A')],
  );
  const {
    rows: [entry],
  } = await context.pool.query<{ id: string }>(
    `INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type)
       VALUES($1,1,$2,$2,$3,'text/plain','parsed_text','internal','external') RETURNING id`,
    [docId, digest(text), Buffer.byteLength(text)],
  );
  await context.pool.query(
    `INSERT INTO document_page(version_id,page_number,text,method,locator_kind) VALUES($1,1,$2,'text','physical_page')`,
    [entry!.id, text],
  );
  return { documentId: docId, version: 1, page: 1, quote: text };
}

async function elevateSource(documentId: string) {
  await context.pool.query(
    `INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type)
      VALUES($1,2,$2,$2,1,'text/plain','parsed_text','confidential','external')`,
    [documentId, digest('新的合成密级版本')],
  );
}

test('锁定事实只由负责人通过浏览器修订，Agent 的候选与已确认事实分开', async () => {
  context = await createIntegrationContext();
  const evidence = await fixtureSource();
  const registry = new ToolRegistry(context.pool, [factProposeTool(), knowledgeGetTool()], {
    environment: 'test',
  });
  const writer = await context.run('MEMBER_A', 'full');
  const reader = await context.run('MEMBER_B', 'read_only');
  const subject = '虚构企业';
  const proposal = { subject, field: 'registration_number', evidence };
  const invoke = (value: string) =>
    registry.execute(fresh(writer), 'fact_propose', { ...proposal, value });
  const read = () => registry.execute(fresh(reader), 'knowledge_get', { kind: 'facts', subject });
  const original = factProposalResultSchema.parse((await invoke('EX-01')).data);
  expect(original.status).toBe('pending');
  expect((await read()).data).toMatchObject({ kind: 'facts', facts: [] });
  const owner = await context.login('MEMBER_A');
  const colleague = await context.login('MEMBER_B');
  const approve = (
    candidateId: string,
    command: FactDecisionInput,
    headers: Record<string, string> = owner.headers,
  ) =>
    context.app.inject({
      method: 'POST',
      url: `/api/projects/${context.projectId}/fact-candidates/${candidateId}/decision`,
      headers,
      payload: command,
    });
  const { 'x-csrf-token': _csrf, ...noToken } = owner.headers;
  expect(
    (
      await approve(
        original.id,
        { decision: 'confirm', validUntil: null, expectedVersion: 1, locked: true },
        noToken,
      )
    ).statusCode,
  ).toBe(403);
  const deadline = await approve(original.id, {
    decision: 'set_due',
    expectedVersion: 1,
    dueAt: '2030-01-01T08:00:00+08:00',
  });
  expect(deadline.statusCode).toBe(200);
  expect(deadline.json()).toMatchObject({ status: 'pending', version: 2, factId: null });
  const listed = await context.app.inject({
    method: 'GET',
    url: `/api/projects/${context.projectId}/fact-candidates`,
    headers: owner.headers,
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toMatchObject({
    items: [{ id: original.id, dueAt: '2030-01-01T00:00:00.000Z' }],
  });
  const decision = await approve(original.id, {
    decision: 'confirm',
    validUntil: null,
    expectedVersion: 2,
    locked: true,
  });
  expect(decision.statusCode).toBe(200);
  const firstId = decision.json().factId as string;
  expect((await read()).data).toMatchObject({
    facts: [{ id: firstId, value: 'EX-01', revision: 1, locked: true, replacesId: null }],
  });

  const nextWriter = await context.run('MEMBER_A', 'full');
  const result = await registry.execute(fresh(nextWriter), 'fact_propose', {
    ...proposal,
    value: 'EX-02',
    evidence: await fixtureSource(),
  });
  const replacement = factProposalResultSchema.parse(result.data);
  expect(replacement.baseRevision).toBe(1);
  expect(result.dataLevel).toBe('internal');
  expect((await read()).data).toMatchObject({
    facts: [{ id: firstId, value: 'EX-01', revision: 1 }],
  });
  const command = { decision: 'confirm', expectedVersion: 1, validUntil: null } as const;
  expect((await approve(replacement.id, command, colleague.headers)).statusCode).toBe(403);
  expect(
    (await approve(replacement.id, { ...command, validUntil: '2000-01-01T00:00:00Z' })).statusCode,
  ).toBe(422);
  const lock = await context.pool.connect();
  let waiting: ReturnType<typeof approve> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM cert_project WHERE id=$1 FOR UPDATE', [context.projectId]);
    const expires = Date.now() + 1500;
    waiting = approve(replacement.id, { ...command, validUntil: new Date(expires).toISOString() });
    let blocked = false;
    while (Date.now() < expires) {
      const attempts = await context.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,owner_user_id FROM cert_project%' LIMIT 1",
      );
      if (attempts.rowCount) {
        blocked = true;
        break;
      }
      await wait(20);
    }
    expect(blocked).toBe(true);
    await wait(Math.max(0, expires - Date.now()) + 25);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  expect((await waiting!).statusCode).toBe(422);
  const accepted = await approve(replacement.id, command);
  expect(accepted.statusCode).toBe(200);
  expect((await read()).data).toMatchObject({
    facts: [{ value: 'EX-02', revision: 2, replacesId: firstId, locked: true }],
  });
  const cachedReader = fresh(reader);
  const readInput = { kind: 'facts', subject };
  expect((await registry.execute(cachedReader, 'knowledge_get', readInput)).dataLevel).toBe(
    'internal',
  );
  await elevateSource(evidence.documentId);
  expect((await registry.execute(cachedReader, 'knowledge_get', readInput)).dataLevel).toBe(
    'confidential',
  );
  expect((await read()).dataLevel).toBe('confidential');
  expect((await approve(replacement.id, command)).statusCode).toBe(409);
  const { rows } = await context.pool.query(
    'SELECT value,revision FROM fact WHERE project_id=$1 ORDER BY revision',
    [context.projectId],
  );
  expect(rows).toEqual([
    { value: 'EX-01', revision: 1 },
    { value: 'EX-02', revision: 2 },
  ]);
  await expect(
    context.pool.query('UPDATE fact SET value=$2::jsonb WHERE id=$1', [firstId, '"改写"']),
  ).rejects.toMatchObject({ code: '55000' });
});

test('事实候选校验原文并按权限先问，撤销保持候选记录', async () => {
  context = await createIntegrationContext();
  const source = await fixtureSource();
  const registry = new ToolRegistry(context.pool, [factProposeTool()], { environment: 'test' });
  const caller = await context.run('MEMBER_A', 'full');
  const requestedApproval = await context.run('MEMBER_A', 'ask');
  const readOnly = await context.run('MEMBER_A', 'read_only');
  const input = {
    subject: '虚构企业',
    field: 'registration_number',
    value: 'EX-01',
    evidence: source,
  };
  await expect(registry.execute(fresh(readOnly), 'fact_propose', input)).rejects.toMatchObject({
    code: 'TOOL_READ_ONLY',
  });
  expect((await registry.execute(fresh(requestedApproval), 'fact_propose', input)).status).toBe(
    'pending_approval',
  );
  expect((await context.pool.query('SELECT 1 FROM fact_candidate')).rowCount).toBe(0);
  await expect(
    registry.execute(fresh(caller), 'fact_propose', {
      ...input,
      evidence: { ...source, quote: '资料中没有' },
    }),
  ).rejects.toMatchObject({
    code: 'TOOL_DATA_REJECTED',
    message: expect.stringContaining('doc_read'),
  });
  const proposal = await registry.execute(fresh(caller), 'fact_propose', input);
  expect(proposal.undoId).toBeTruthy();
  const candidate = factProposalResultSchema.parse(proposal.data);
  await registry.undo(fresh(caller), proposal.undoId!);
  expect(
    (
      await context.pool.query('SELECT status,version FROM fact_candidate WHERE id=$1', [
        candidate.id,
      ])
    ).rows[0],
  ).toEqual({ status: 'cancelled', version: 2 });
  expect((await context.pool.query('SELECT 1 FROM fact')).rowCount).toBe(0);
});

test('待处理候选列表与工具重放都复核原始资料的现时密级', async () => {
  context = await createIntegrationContext();
  const original = await fixtureSource('合成原件登记号 EX-01');
  const registry = new ToolRegistry(context.pool, [factProposeTool()], { environment: 'test' });
  const writer = fresh(await context.run('MEMBER_A', 'full'));
  const input = {
    subject: '虚构企业',
    field: 'registration_number',
    value: 'EX-01',
    evidence: original,
  };
  const proposal = await registry.execute(writer, 'fact_propose', input);
  const candidate = factProposalResultSchema.parse(proposal.data);
  expect(proposal.dataLevel).toBe('internal');
  await elevateSource(original.documentId);
  const owner = await context.login('MEMBER_A');
  const list = await context.app.inject({
    method: 'GET',
    url: `/api/projects/${context.projectId}/fact-candidates`,
    headers: owner.headers,
  });
  expect(list.json()).toMatchObject({ items: [{ id: candidate.id, dataLevel: 'confidential' }] });
  const replay = await registry.execute(writer, 'fact_propose', input);
  expect(replay).toMatchObject({ replayed: true, dataLevel: 'confidential' });
  expect(replay.data).not.toHaveProperty('dataLevel');
});

test('人工改写绑定不同证据，新证据升密会更新读取和重放的级别', async () => {
  context = await createIntegrationContext();
  const original = await fixtureSource('合成原件登记号 EX-01');
  const newSource = await fixtureSource('合成更正页登记号 EX-02');
  const updated = { ...newSource, documentId: newSource.documentId.toUpperCase() };
  const registry = new ToolRegistry(context.pool, [factProposeTool(), knowledgeGetTool()], {
    environment: 'test',
  });
  const writer = await context.run('MEMBER_A', 'full');
  const reader = await context.run('MEMBER_B', 'read_only');
  const candidate = factProposalResultSchema.parse(
    (
      await registry.execute(fresh(writer), 'fact_propose', {
        subject: '虚构企业',
        field: 'registration_number',
        value: 'EX-01',
        evidence: original,
      })
    ).data,
  );
  const owner = await context.login('MEMBER_A');
  const decision = await context.app.inject({
    method: 'POST',
    url: `/api/projects/${context.projectId}/fact-candidates/${candidate.id}/decision`,
    headers: owner.headers,
    payload: {
      decision: 'rewrite',
      expectedVersion: 1,
      evidence: updated,
      value: 'EX-02',
      unit: null,
      reason: '根据合成更正页确认',
      validUntil: null,
    },
  });
  expect(decision.statusCode).toBe(200);
  const stored = await context.pool.query('SELECT evidence FROM fact_candidate WHERE id=$1', [
    candidate.id,
  ]);
  expect(stored.rows[0]).toEqual({ evidence: original });
  const query = { kind: 'facts' };
  const cachedReader = fresh(reader);
  const first = await registry.execute(cachedReader, 'knowledge_get', query);
  expect(first).toMatchObject({
    dataLevel: 'internal',
    data: { facts: [{ value: 'EX-02', evidence: updated }] },
  });
  await elevateSource(newSource.documentId);
  expect((await registry.execute(cachedReader, 'knowledge_get', query)).dataLevel).toBe(
    'confidential',
  );
  expect((await registry.execute(fresh(reader), 'knowledge_get', query)).dataLevel).toBe(
    'confidential',
  );
});

test('读取与重放按语句时刻认定到期，已有事务不会保留过期事实', async () => {
  context = await createIntegrationContext();
  const source = await fixtureSource('合成原件登记号 EX-01');
  const registry = new ToolRegistry(context.pool, [factProposeTool()], { environment: 'test' });
  const writer = await context.run('MEMBER_A', 'full');
  const candidate = factProposalResultSchema.parse(
    (
      await registry.execute(fresh(writer), 'fact_propose', {
        subject: '虚构企业',
        field: 'registration_number',
        value: 'EX-01',
        evidence: source,
      })
    ).data,
  );
  await context.pool.query(
    `UPDATE fact_candidate SET status='confirmed',version=version+1,decided_by=$2,decided_at=now() WHERE id=$1`,
    [candidate.id, writer.userId],
  );
  const tx = await context.pool.connect();
  const ctx = { tx, projectId: context.projectId } as ToolExecutionContext;
  const request = { kind: 'facts', limit: 5 } as const;
  try {
    await tx.query('BEGIN');
    const {
      rows: [fixture],
    } = await context.pool.query<{ valid_until: Date }>(
      `INSERT INTO fact(project_id,subject,field,value,unit,candidate_id,source_document_id,evidence,data_level,revision,confirmed_by,valid_from,valid_until)
       SELECT project_id,subject,field,value,unit,id,source_document_id,evidence,data_level,1,decided_by,
              statement_timestamp()-interval '1 hour',clock_timestamp()+interval '2 seconds'
       FROM fact_candidate WHERE id=$1 RETURNING valid_until`,
      [candidate.id],
    );
    const beforeExpiry = await readConfirmedFacts(ctx, request);
    expect(beforeExpiry).toMatchObject({
      dataLevel: 'internal',
      data: { facts: [{ value: 'EX-01', evidence: source }] },
    });
    expect(beforeExpiry.data.facts[0]).not.toHaveProperty('dataLevel');
    await tx.query(
      'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+.03)',
      [fixture!.valid_until],
    );
    expect((await readConfirmedFacts(ctx, request)).data.facts).toEqual([]);
    await expect(refreshConfirmedFactsLevel(ctx, beforeExpiry.data.facts)).rejects.toMatchObject({
      code: 'FACT_RESULT_CHANGED',
    });
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('规则版本发布后不可改，运行记录并沿用首次拿到的版本', async () => {
  context = await createIntegrationContext();
  const initial = await publishDevelopmentRulePack(context.pool, pack, 'test');
  expect(await publishDevelopmentRulePack(context.pool, pack, 'test')).toEqual({
    ...initial,
    created: false,
  });
  await expect(
    publishDevelopmentRulePack(context.pool, { ...pack, title: '变更旧版' }, 'test'),
  ).rejects.toMatchObject({ code: 'RULE_PACK_VERSION_IMMUTABLE' });
  await expect(
    publishDevelopmentRulePack(context.pool, { ...pack, version: '1.0.0' }, 'production'),
  ).rejects.toMatchObject({ code: 'RULE_PACK_SEED_DEVELOPMENT_ONLY' });
  await expect(
    context.pool.query('UPDATE rule_pack_version SET published_at=now() WHERE id=$1', [
      initial.versionId,
    ]),
  ).rejects.toMatchObject({ code: '55000' });
  await expect(
    context.pool.query('DELETE FROM rule_pack_version WHERE id=$1', [initial.versionId]),
  ).rejects.toMatchObject({ code: '55000' });
  const registry = new ToolRegistry(context.pool, [knowledgeGetTool()], { environment: 'test' });
  const olderRun = await context.run('MEMBER_A', 'read_only');
  const input = { kind: 'rule_pack', code: pack.code };
  expect((await registry.execute(fresh(olderRun), 'knowledge_get', input)).data).toMatchObject({
    pack: { versionId: initial.versionId, publication: 'development' },
  });
  const next = await publishDevelopmentRulePack(
    context.pool,
    { ...pack, version: '0.2.0' },
    'test',
  );
  const later = await context.run('MEMBER_A', 'read_only');
  expect((await registry.execute(fresh(olderRun), 'knowledge_get', input)).data).toMatchObject({
    pack: { versionId: initial.versionId },
  });
  expect((await registry.execute(fresh(later), 'knowledge_get', input)).data).toMatchObject({
    pack: { versionId: next.versionId },
  });
  expect((await context.pool.query('SELECT run_id,version_id FROM run_rule_pack')).rows).toEqual(
    expect.arrayContaining([
      { run_id: olderRun.runId, version_id: initial.versionId },
      { run_id: later.runId, version_id: next.versionId },
    ]),
  );
  const tx = await context.pool.connect();
  try {
    const onlyOfficial = await readRulePack(
      { tx, runId: later.runId } as Parameters<typeof readRulePack>[0],
      pack.code,
      'production',
    );
    expect(onlyOfficial.data.pack).toBeNull();
    const content = {
      ...pack,
      version: '1.0.0',
      dataLevel: 'internal',
      rules: pack.rules.map((rule) => ({
        ...rule,
        status: 'confirmed',
        units: Object.fromEntries(
          Object.entries(rule.parameters ?? {})
            .filter(([, v]) => typeof v === 'number')
            .map(([key]) => [key, '合成单位']),
        ),
      })),
    };
    await expect(
      context.pool.query(
        `INSERT INTO rule_pack_version(pack_id,version,content,publication,published_by)
         SELECT id,'1.0.0',$2::jsonb,'published',$3 FROM rule_pack WHERE code=$1 RETURNING id`,
        [pack.code, JSON.stringify(content), context.userId('MEMBER_A')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const admin = await context.login('ADMIN');
    const reviewer = await context.login('MEMBER_B');
    const staged = await stageReview(admin.headers, {
      kind: 'rule_pack',
      yaml: JSON.stringify(content),
      requestKey: randomUUID(),
    });
    expect(staged.statusCode).toBe(200);
    const review = knowledgeReviewSummarySchema.parse(staged.json());
    const pendingRun = await context.run('MEMBER_A', 'read_only');
    expect(
      (
        await readRulePack(
          { tx, runId: pendingRun.runId } as Parameters<typeof readRulePack>[0],
          pack.code,
          'production',
        )
      ).data.pack,
    ).toBeNull();
    const confirmation = await decideReview(reviewer.headers, review.id, {
      action: 'publish',
      contentSha256: review.contentSha256,
      requestKey: randomUUID(),
    });
    expect(confirmation.statusCode).toBe(200);
    const published = await context.pool.query<{ id: string }>(
      'SELECT id FROM rule_pack_version WHERE review_id=$1 AND published_by=$2',
      [review.id, context.userId('MEMBER_B')],
    );
    const activeRun = await context.run('MEMBER_A', 'read_only');
    const inProduction = await readRulePack(
      { tx, runId: activeRun.runId } as Parameters<typeof readRulePack>[0],
      pack.code,
      'production',
    );
    expect(inProduction.data.pack).toMatchObject({
      publication: 'published',
      versionId: published.rows[0]!.id,
    });
    await expect(
      context.pool.query('UPDATE rule_pack_version SET publication=publication WHERE id=$1', [
        published.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  } finally {
    tx.release();
  }
});

test('模板审核需浏览器，退回版本与草稿都不会进入 Agent 工具', async () => {
  context = await createIntegrationContext();
  const admin = await context.login('ADMIN');
  const reviewer = await context.login('MEMBER_B');
  const reader = await context.run('MEMBER_A', 'read_only');
  const registry = new ToolRegistry(context.pool, [knowledgeGetTool()], { environment: 'test' });
  const draft = {
    code: 'synthetic_review_template',
    title: '合成审核模板',
    version: '1.0.0',
    source: '合成测试场景',
    body: '合成测试正文\n  保留正文缩进',
    dataLevel: 'confidential',
  };
  const request = {
    kind: 'template' as const,
    yaml: JSON.stringify(draft),
    requestKey: randomUUID().toUpperCase(),
  };
  const input = { kind: 'template', code: draft.code };
  const read = (call = fresh(reader)) => registry.execute(call, 'knowledge_get', input);
  expect((await stageReview(reviewer.headers, request)).statusCode).toBe(403);
  const created = await stageReview(admin.headers, request);
  expect(created.statusCode).toBe(200);
  const pending = knowledgeReviewSummarySchema.parse(created.json());
  expect(pending.status).toBe('pending');
  expect(created.json()).not.toHaveProperty('draft');
  expect((await stageReview(admin.headers, request)).json()).toEqual(pending);
  expect(
    (await stageReview(admin.headers, { ...request, requestKey: randomUUID() })).statusCode,
  ).toBe(409);
  const detailUrl = `${knowledgeReviewsUrl}/${pending.id}`;
  expect((await context.app.inject({ url: detailUrl })).statusCode).toBe(403);
  expect(
    (await context.app.inject({ url: detailUrl, headers: reviewer.headers })).json(),
  ).toMatchObject({ draft: { kind: 'template', content: draft } });
  expect(
    (await context.app.inject({ url: knowledgeReviewsUrl, headers: reviewer.headers })).json(),
  ).toMatchObject({ items: [pending], nextAfterId: null });
  expect((await read()).data).toEqual({ kind: 'template', template: null });

  const approval = {
    action: 'publish' as const,
    contentSha256: pending.contentSha256,
    requestKey: randomUUID().toUpperCase(),
  };
  const { 'x-csrf-token': _token, ...noToken } = reviewer.headers;
  expect((await decideReview(noToken, pending.id, approval)).statusCode).toBe(403);
  expect(
    (
      await decideReview(reviewer.headers, pending.id, {
        ...approval,
        contentSha256: '0'.repeat(64),
      })
    ).statusCode,
  ).toBe(409);
  const result = await decideReview(reviewer.headers, pending.id, approval);
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ status: 'published' });
  expect(
    (
      await context.pool.query(
        `SELECT v.published_at = r.reviewed_at AS recorded FROM template_version v
      JOIN knowledge_review r ON r.id=v.review_id WHERE r.id=$1`,
        [pending.id],
      )
    ).rows,
  ).toEqual([{ recorded: true }]);
  expect((await decideReview(reviewer.headers, pending.id, approval)).json()).toEqual(
    result.json(),
  );
  expect((await decideReview(admin.headers, pending.id, approval)).statusCode).toBe(409);
  const sameCall = fresh(reader);
  for (const readResult of [await read(sameCall), await read(sameCall)]) {
    expect(readResult).toMatchObject({ dataLevel: 'confidential', data: { template: draft } });
  }
  await expect(
    context.pool.query('DELETE FROM template_version WHERE review_id=$1', [pending.id]),
  ).rejects.toMatchObject({ code: '55000' });
  await expect(
    context.pool.query('UPDATE knowledge_review SET content_sha256=$2 WHERE id=$1', [
      pending.id,
      '1'.repeat(64),
    ]),
  ).rejects.toMatchObject({ code: '55000' });

  const candidate = await stageReview(admin.headers, {
    ...request,
    yaml: JSON.stringify({ ...draft, version: '1.1.0', body: '合成的错误正文' }),
    requestKey: randomUUID(),
  });
  const next = knowledgeReviewSummarySchema.parse(candidate.json());
  const reject = {
    action: 'reject' as const,
    contentSha256: next.contentSha256,
    reason: '出处未核对',
    requestKey: randomUUID(),
  };
  const rejected = await decideReview(reviewer.headers, next.id, reject);
  expect(rejected.statusCode).toBe(200);
  expect(rejected.json()).toMatchObject({ status: 'rejected', reason: reject.reason });
  expect((await decideReview(reviewer.headers, next.id, reject)).json()).toEqual(rejected.json());
  expect(
    (await decideReview(reviewer.headers, next.id, { ...reject, reason: '另一个原因' })).statusCode,
  ).toBe(409);
  expect((await read()).data).toMatchObject({ template: draft });

  const publishBody = async (version: string, body: string, expectedStatus = 200) => {
    const pending = knowledgeReviewSummarySchema.parse(
      (
        await stageReview(admin.headers, {
          ...request,
          yaml: JSON.stringify({ ...draft, version, body }),
          requestKey: randomUUID(),
        })
      ).json(),
    );
    expect(
      (
        await decideReview(reviewer.headers, pending.id, {
          action: 'publish',
          contentSha256: pending.contentSha256,
          requestKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(expectedStatus);
  };
  await publishBody('2.0.0', '已审阅的新正文');
  expect((await read()).data).toMatchObject({
    template: { version: '2.0.0', body: '已审阅的新正文' },
  });
  await publishBody('1.9.9', draft.body, 409);
  expect((await read()).data).toMatchObject({ template: { version: '2.0.0' } });
  expect(
    (
      await stageReview(admin.headers, {
        ...request,
        yaml: JSON.stringify({ ...draft, version: '02.0.0' }),
        requestKey: randomUUID(),
      })
    ).statusCode,
  ).toBe(400);
  await publishBody('2.0.1', draft.body);
  expect((await read()).data).toMatchObject({ template: { version: '2.0.1', body: draft.body } });
  expect(
    (
      await context.pool.query(
        'SELECT action,actor_user_id FROM audit_log WHERE target_type=$1 AND target_id=$2 ORDER BY id',
        ['knowledge_review', next.id],
      )
    ).rows,
  ).toEqual(
    expect.arrayContaining([
      { action: 'knowledge.review_staged', actor_user_id: context.userId('ADMIN') },
      { action: 'knowledge.review_rejected', actor_user_id: context.userId('MEMBER_B') },
    ]),
  );
});

test('迁移前没有审核卡的已发布标记无法用于正式读取或旧缓存重放', async () => {
  context = await createIntegrationContext();
  const tx = await context.pool.connect();
  const legacy = { ...pack, version: '8.0.0' };
  try {
    await tx.query('BEGIN');
    // 模拟迁移前留下的发布标记，限制在本测试的一次数据库事务内。
    await tx.query('ALTER TABLE rule_pack_version DISABLE TRIGGER rule_pack_review_required');
    const {
      rows: [identity],
    } = await tx.query<{ id: string }>(
      'INSERT INTO rule_pack(code,jurisdiction) VALUES($1,$2) RETURNING id',
      [legacy.code, legacy.jurisdiction],
    );
    const {
      rows: [content],
    } = await tx.query<{ id: string }>(
      `INSERT INTO rule_pack_version(pack_id,version,content,publication,published_by)
        VALUES($1,$2,$3::jsonb,'published',$4) RETURNING id`,
      [identity!.id, legacy.version, JSON.stringify(legacy), context.userId('MEMBER_A')],
    );
    await tx.query('ALTER TABLE rule_pack_version ENABLE TRIGGER rule_pack_review_required');
    await tx.query('COMMIT');
    const reader = await context.run('MEMBER_A', 'read_only');
    const toolContext = { tx, runId: reader.runId } as ToolExecutionContext;
    expect((await readRulePack(toolContext, legacy.code, 'production')).data.pack).toBeNull();
    await expect(
      refreshRulePackLevel(
        toolContext,
        { ...legacy, versionId: content!.id, publication: 'published' },
        'production',
      ),
    ).rejects.toMatchObject({ code: 'RULE_PACK_REVIEW_REQUIRED' });
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('规则缺确认或数值单位时维持待审，已存在的版本冲突也不改变审核决定', async () => {
  context = await createIntegrationContext();
  await publishDevelopmentRulePack(context.pool, pack, 'test');
  const admin = await context.login('ADMIN');
  const member = await context.login('MEMBER_A');
  const request = { kind: 'rule_pack' as const, requestKey: randomUUID() };
  expect(
    (
      await stageReview(admin.headers, {
        ...request,
        yaml: JSON.stringify({ ...pack, version: '3.0.0' }),
      })
    ).statusCode,
  ).toBe(400);
  const internalPack = { ...pack, dataLevel: 'internal' };
  const drafts = [
    { ...internalPack, version: '3.0.0' },
    {
      ...internalPack,
      version: '4.0.0',
      rules: [{ ...pack.rules[0], status: 'confirmed', parameters: { amount: 2 } }],
    },
    {
      ...internalPack,
      rules: pack.rules.map((rule) => ({
        ...rule,
        status: 'confirmed',
        units: Object.fromEntries(
          Object.keys(rule.parameters ?? {}).map((key) => [key, '合成单位']),
        ),
      })),
    },
  ];
  for (const [index, draft] of drafts.entries()) {
    const staged = await stageReview(admin.headers, {
      kind: 'rule_pack',
      yaml: JSON.stringify(draft),
      requestKey: randomUUID(),
    });
    const review = knowledgeReviewSummarySchema.parse(staged.json());
    const response = await decideReview(member.headers, review.id, {
      action: 'publish',
      contentSha256: review.contentSha256,
      requestKey: randomUUID(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain(
      index === 2 ? 'KNOWLEDGE_REVIEW_CONFLICT' : 'KNOWLEDGE_RULES_PENDING',
    );
    expect(
      (
        await context.app.inject({
          url: `${knowledgeReviewsUrl}/${review.id}`,
          headers: member.headers,
        })
      ).json(),
    ).toMatchObject({ status: 'pending', reviewedAt: null });
  }
});
