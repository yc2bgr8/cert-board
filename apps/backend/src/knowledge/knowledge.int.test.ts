import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { factCandidateSchema, type FactDecisionInput } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { factProposeTool, knowledgeGetTool } from '../tools/knowledge-tools.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseRulePackSeed, publishDevelopmentRulePack, readRulePack } from './rule-packs.js';

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

async function fixtureSource(level: 'internal' | 'confidential' = 'internal') {
  const text = '合成证据：最初登记号 EX-01，后续更正值 EX-02。';
  const docId = randomUUID();
  await context.pool.query(
    `INSERT INTO document (id,project_id,source_key,name,source_path,owner_user_id) VALUES($1,$2,$3,'合成事实资料','fact.txt',$4)`,
    [docId, context.projectId, `FACT-${docId}`, context.userId('MEMBER_A')],
  );
  const {
    rows: [entry],
  } = await context.pool.query<{ id: string }>(
    `INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type)
       VALUES($1,1,$2,$2,$3,'text/plain','parsed_text',$4,'external') RETURNING id`,
    [docId, digest(text), Buffer.byteLength(text), level],
  );
  await context.pool.query(
    `INSERT INTO document_page(version_id,page_number,text,method,locator_kind) VALUES($1,1,$2,'text','physical_page')`,
    [entry!.id, text],
  );
  return { documentId: docId, version: 1, page: 1, quote: text };
}

test('锁定事实只由负责人通过浏览器修订，Agent 的候选与已确认事实分开', async () => {
  context = await createIntegrationContext();
  const evidence = await fixtureSource('confidential');
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
  const original = factCandidateSchema.parse((await invoke('EX-01')).data);
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
  const replacement = factCandidateSchema.parse(
    (
      await registry.execute(fresh(nextWriter), 'fact_propose', {
        ...proposal,
        value: 'EX-02',
        evidence: await fixtureSource(),
      })
    ).data,
  );
  expect(replacement.baseRevision).toBe(1);
  expect(replacement.dataLevel).toBe('internal');
  expect((await read()).data).toMatchObject({
    facts: [{ id: firstId, value: 'EX-01', revision: 1 }],
  });
  const command = { decision: 'confirm', expectedVersion: 1, validUntil: null } as const;
  expect((await approve(replacement.id, command, colleague.headers)).statusCode).toBe(403);
  expect(
    (await approve(replacement.id, { ...command, validUntil: '2000-01-01T00:00:00Z' })).statusCode,
  ).toBe(422);
  const accepted = await approve(replacement.id, command);
  expect(accepted.statusCode).toBe(200);
  expect((await read()).data).toMatchObject({
    facts: [
      { value: 'EX-02', revision: 2, replacesId: firstId, locked: true, dataLevel: 'confidential' },
    ],
  });
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
  const candidate = factCandidateSchema.parse(proposal.data);
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
    const published = await context.pool.query<{ id: string }>(
      `INSERT INTO rule_pack_version(pack_id,version,content,publication,published_by)
         SELECT id,'1.0.0',$2::jsonb,'published',$3 FROM rule_pack WHERE code=$1 RETURNING id`,
      [pack.code, JSON.stringify({ ...pack, version: '1.0.0' }), context.userId('MEMBER_A')],
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
