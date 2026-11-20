import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import {
  skillPageSchema,
  type SkillActionInput,
  type SkillVersionMetadata,
} from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { loadManagedAgentDefinition, loadSelectedSkill } from '../agent/definitions.js';
import { readActiveSkill, stageSkillVersion } from './service.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>> | undefined;
afterEach(async () => {
  await context?.close();
});

const skillDraft = (version: string): { metadata: SkillVersionMetadata; body: string } => ({
  metadata: {
    id: 'R01',
    version,
    name: '合成立项测试',
    summary: '核对合成资料',
    agentCode: 'registration',
    capability: '注册立项',
    level: 2,
    modes: ['ask', 'full'],
    requiredChecks: ['V1', 'V3'],
    minimumEvidence: 3,
    risk: 'standard',
    suggestedSubagents: [],
  },
  body: `合成技能正文 ${version}`,
});

test('注册人员可审核发布、停用与回退，版本正文和审阅事件只允许追加', async () => {
  context = await createIntegrationContext();
  const ctx = context;
  const first = await stageSkillVersion(ctx.pool, skillDraft('1.0.0'));
  const second = await stageSkillVersion(ctx.pool, skillDraft('2.0.0'));
  expect(await stageSkillVersion(ctx.pool, skillDraft('1.0.0'))).toMatchObject({
    id: first.id,
    created: false,
  });
  await expect(
    stageSkillVersion(ctx.pool, { ...skillDraft('1.0.0'), body: '想覆盖原草稿' }),
  ).rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT' });
  expect(await readActiveSkill(ctx.pool, 'registration', { id: 'R01' })).toBeUndefined();
  await expect(
    loadSelectedSkill(ctx.pool, 'registration', { id: 'R01' }, 'ask'),
  ).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
  const alice = await ctx.login('MEMBER_A');
  const bob = await ctx.login('MEMBER_B');
  const post = (command: SkillActionInput, headers = alice.headers) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/skills/R01/actions',
      headers,
      payload: command,
    });
  const publish: SkillActionInput = {
    action: 'publish',
    requestKey: randomUUID(),
    expectedRevision: 0,
    versionId: first.id,
    contentSha256: first.contentSha256,
  };
  const { 'x-csrf-token': _csrf, ...withoutCsrf } = alice.headers;
  expect((await post(publish, withoutCsrf as typeof alice.headers)).statusCode).toBe(403);
  expect((await post({ ...publish, contentSha256: second.contentSha256 })).statusCode).toBe(409);
  const accepted = await post(publish);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({
    revision: 1,
    activeVersionId: first.id,
    replayed: false,
  });
  expect((await post(publish)).json()).toMatchObject({ revision: 1, replayed: true });
  expect(
    (
      await post({
        ...publish,
        requestKey: randomUUID(),
        versionId: second.id,
        contentSha256: second.contentSha256,
      })
    ).statusCode,
  ).toBe(409);

  const promote = await post(
    {
      ...publish,
      requestKey: randomUUID(),
      versionId: second.id,
      contentSha256: second.contentSha256,
      expectedRevision: 1,
    },
    bob.headers,
  );
  expect(promote.statusCode).toBe(200);
  const registration = await loadManagedAgentDefinition(ctx.pool, 'registration', 'ask');
  expect(registration.skills).toContainEqual(
    expect.objectContaining({ id: 'R01', version: '2.0.0' }),
  );
  expect(
    (await loadManagedAgentDefinition(ctx.pool, 'maintenance', 'ask')).skills.some(
      ({ id }) => id === 'R01',
    ),
  ).toBe(false);
  expect(await loadSelectedSkill(ctx.pool, 'registration', { id: 'R01' }, 'ask')).toMatchObject({
    publication: 'published',
    skill: { version: '2.0.0' },
    reviewPolicy: { minimumEvidence: 3, requiredChecks: ['V1', 'V3'] },
  });
  await expect(
    loadSelectedSkill(ctx.pool, 'registration', { id: 'R01' }, 'read_only'),
  ).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
  expect(await readActiveSkill(ctx.pool, 'maintenance', { id: 'R01' })).toBeNull();

  const disable = await post(
    {
      ...publish,
      action: 'disable',
      requestKey: randomUUID(),
      expectedRevision: 2,
      versionId: second.id,
      contentSha256: second.contentSha256,
    },
    bob.headers,
  );
  expect(disable.statusCode).toBe(200);
  expect(disable.json()).toMatchObject({ revision: 3, activeVersionId: null });
  await expect(
    loadSelectedSkill(ctx.pool, 'registration', { id: 'R01' }, 'ask'),
  ).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
  const inventory = await ctx.app.inject({ url: '/api/skills', headers: alice.headers });
  expect(skillPageSchema.parse(inventory.json()).items[0]).toMatchObject({
    activeVersionId: null,
    previousVersionId: first.id,
  });
  const rollback = await post({
    ...publish,
    action: 'rollback',
    requestKey: randomUUID(),
    expectedRevision: 3,
  });
  expect(rollback.statusCode).toBe(200);
  expect(rollback.json()).toMatchObject({ revision: 4, activeVersionId: first.id });
  expect(await readActiveSkill(ctx.pool, 'registration', { id: 'R01' })).toMatchObject({
    skill: { version: '1.0.0' },
  });
  expect(
    await readActiveSkill(ctx.pool, 'registration', { id: 'R01', version: '2.0.0' }),
  ).toBeNull();
  await expect(
    ctx.pool.query("UPDATE skill_version SET body='modified' WHERE id=$1", [first.id]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    ctx.pool.query('DELETE FROM skill_release WHERE skill_id=$1', ['R01']),
  ).rejects.toMatchObject({ code: '42501' });
  const audit = await ctx.pool.query(
    "SELECT action,actor_user_id,before_hash,after_hash FROM audit_log WHERE target_type='skill' ORDER BY created_at",
  );
  expect(audit.rows.map((row) => [row.action, row.actor_user_id])).toEqual([
    ['skill.publish', ctx.userId('MEMBER_A')],
    ['skill.publish', ctx.userId('MEMBER_B')],
    ['skill.disable', ctx.userId('MEMBER_B')],
    ['skill.rollback', ctx.userId('MEMBER_A')],
  ]);
  expect(audit.rows[2]).toMatchObject({ before_hash: second.contentSha256, after_hash: null });
  expect(audit.rows[3]).toMatchObject({ after_hash: first.contentSha256 });
});

test('内置开发草稿可继续本机试用，已发布技能停用后不回到内置版本', async () => {
  context = await createIntegrationContext();
  const ctx = context;
  const candidate = skillDraft('3.0.0');
  const staged = await stageSkillVersion(ctx.pool, {
    ...candidate,
    metadata: { ...candidate.metadata, id: 'R09' },
  });
  expect(await loadSelectedSkill(ctx.pool, 'registration', { id: 'R09' }, 'ask')).toMatchObject({
    publication: 'draft',
    skill: { version: '0.1.0' },
  });
  const member = await ctx.login('MEMBER_B');
  const act = (action: 'publish' | 'disable', expectedRevision: number) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/skills/R09/actions',
      headers: member.headers,
      payload: {
        action,
        expectedRevision,
        requestKey: randomUUID(),
        versionId: staged.id,
        contentSha256: staged.contentSha256,
      },
    });
  expect((await act('publish', 0)).statusCode).toBe(200);
  expect((await act('disable', 1)).statusCode).toBe(200);
  expect(
    (await loadManagedAgentDefinition(ctx.pool, 'registration', 'ask')).skills.some(
      ({ id }) => id === 'R09',
    ),
  ).toBe(false);
  await expect(
    loadSelectedSkill(ctx.pool, 'registration', { id: 'R09' }, 'ask'),
  ).rejects.toMatchObject({ code: 'SKILL_UNAVAILABLE' });
});
