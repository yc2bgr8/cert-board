import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import {
  reviewSubmitResultSchema,
  skillRollbackListSchema,
  type SkillVersionMetadata,
} from '@cert-board/shared';
import { createReviewTestContext } from '../reviews/test-support.js';
import { ToolRegistry } from '../tools/registry.js';
import { submitForReviewTool } from '../tools/submit-for-review.js';
import { scanSkillRollbackProposals } from './rollback.js';
import { readActiveSkill, stageSkillVersion } from './service.js';

type Context = Awaited<ReturnType<typeof createReviewTestContext>>;
type Headers = Awaited<ReturnType<Context['login']>>['headers'];

let context: Context | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function publish(ctx: Context, headers: Headers, version: string, expectedRevision: number) {
  const metadata: SkillVersionMetadata = {
    id: 'R09',
    version,
    name: '合成一致性核对',
    summary: '核对合成资料的写法。',
    agentCode: 'registration',
    capability: '资料一致性检查',
    level: 2,
    modes: ['ask', 'full'],
    requiredChecks: ['V1', 'V3'],
    minimumEvidence: 2,
    risk: 'standard',
    suggestedSubagents: [],
  };
  const staged = await stageSkillVersion(ctx.pool, { metadata, body: `合成版本 ${version}` });
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/skills/R09/actions',
    headers,
    payload: {
      action: 'publish',
      expectedRevision,
      requestKey: randomUUID(),
      versionId: staged.id,
      contentSha256: staged.contentSha256,
    },
  });
  expect(response.statusCode).toBe(200);
  return staged.id;
}

async function finishReview(
  ctx: Context,
  headers: Headers,
  version: string,
  action: 'approved' | 'rejected',
) {
  const caller = await ctx.run('MEMBER_A', 'full');
  await ctx.read(caller);
  const skill = { id: 'R09', version };
  const registry = new ToolRegistry(ctx.pool, [
    ...ctx.definitions.filter((definition) => definition.metadata.name !== 'submit_for_review'),
    submitForReviewTool({ ...ctx.policy, skill }),
  ]);
  const result = reviewSubmitResultSchema.parse(
    (
      await registry.execute({ ...caller, callId: randomUUID() }, 'submit_for_review', {
        ...ctx.submission,
        skill,
      })
    ).data,
  );
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/api/reviews/${result.reviewId}/decision`,
    headers,
    payload: {
      action,
      expectedVersion: result.version,
      workspaceVersion: result.workspaceVersion,
      requestKey: randomUUID(),
      ...(action === 'rejected' ? { reason: '请核对合成原件。' } : {}),
    },
  });
  expect(response.statusCode).toBe(200);
}

async function proposals(ctx: Context, headers: Headers) {
  const result = await ctx.app.inject({ url: '/api/skill-rollback-proposals', headers });
  expect(result.statusCode).toBe(200);
  return skillRollbackListSchema.parse(result.json()).items;
}

test('按生效版本与阈值统计、并发去重、驳回后等待新增十张，由浏览器批准回退', async () => {
  context = await createReviewTestContext();
  const ctx = context;
  const alice = await ctx.login('MEMBER_A');
  const bob = await ctx.login('MEMBER_B');
  const { 'x-csrf-token': _csrf, ...noCsrf } = alice.headers;
  const policy = () =>
    ctx.app.inject({ url: '/api/skill-rollback-policy', headers: alice.headers });
  expect((await policy()).json()).toEqual({ minimumCards: 10, rejectionPercent: 50, revision: 0 });
  const setPolicy = (expectedRevision: number, headers: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/skill-rollback-policy',
      headers,
      payload: { expectedRevision, minimumCards: 2, rejectionPercent: 50 },
    });
  expect((await setPolicy(0, noCsrf)).statusCode).toBe(403);
  expect((await setPolicy(0, bob.headers)).statusCode).toBe(200);
  expect((await setPolicy(0, alice.headers)).statusCode).toBe(409);
  expect((await policy()).json()).toEqual({ minimumCards: 2, rejectionPercent: 50, revision: 1 });

  const oldVersion = await publish(ctx, alice.headers, '1.0.0', 0);
  await finishReview(ctx, bob.headers, '1.0.0', 'rejected');
  const activeVersion = await publish(ctx, alice.headers, '2.0.0', 1);
  await finishReview(ctx, bob.headers, '2.0.0', 'rejected');
  await scanSkillRollbackProposals(ctx.pool);
  expect(await proposals(ctx, alice.headers)).toEqual([]);

  await finishReview(ctx, bob.headers, '2.0.0', 'approved');
  await Promise.all([scanSkillRollbackProposals(ctx.pool), scanSkillRollbackProposals(ctx.pool)]);
  const [initial] = await proposals(ctx, alice.headers);
  expect(await proposals(ctx, bob.headers)).toHaveLength(1);
  expect(initial).toMatchObject({
    skillId: 'R09',
    activeVersion: '2.0.0',
    previousVersion: '1.0.0',
    status: 'pending',
    releaseRevision: 2,
    evidence: {
      total: 2,
      rejected: 1,
      from: expect.any(String),
      to: expect.any(String),
      previous: { total: 1, rejected: 1 },
      reasons: ['请核对合成原件。'],
    },
  });
  expect(await readActiveSkill(ctx.pool, 'registration', { id: 'R09' })).toMatchObject({
    skill: { version: '2.0.0' },
  });
  const decide = (
    id: string,
    action: 'approve' | 'dismiss',
    requestKey: string,
    headers: Record<string, string> = alice.headers,
  ) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/skill-rollback-proposals/${id}/decision`,
      headers,
      payload: { action, requestKey, expectedRevision: 2 },
    });
  expect((await decide(initial!.id, 'approve', randomUUID(), noCsrf)).statusCode).toBe(403);
  const dismissal = randomUUID();
  expect((await decide(initial!.id, 'dismiss', dismissal)).json()).toMatchObject({
    status: 'dismissed',
    replayed: false,
  });
  expect((await decide(initial!.id, 'dismiss', dismissal)).json()).toMatchObject({
    status: 'dismissed',
    replayed: true,
  });
  for (let i = 0; i < 9; i++) await finishReview(ctx, bob.headers, '2.0.0', 'rejected');
  await scanSkillRollbackProposals(ctx.pool);
  expect(await proposals(ctx, alice.headers)).toEqual([]);
  await finishReview(ctx, bob.headers, '2.0.0', 'rejected');
  await scanSkillRollbackProposals(ctx.pool);
  const [next] = await proposals(ctx, alice.headers);
  expect(next?.id).toBeDefined();
  expect(next?.id).not.toBe(initial!.id);
  const approval = randomUUID();
  expect((await decide(next!.id, 'approve', approval)).json()).toMatchObject({
    status: 'approved',
    replayed: false,
  });
  expect((await decide(next!.id, 'approve', approval)).json()).toMatchObject({
    status: 'approved',
    replayed: true,
  });
  const releases = await ctx.pool.query(
    'SELECT active_version_id,revision,action FROM skill_release WHERE skill_id=$1 ORDER BY revision',
    ['R09'],
  );
  expect(releases.rows).toEqual([
    { active_version_id: oldVersion, revision: 1, action: 'publish' },
    { active_version_id: activeVersion, revision: 2, action: 'publish' },
    { active_version_id: oldVersion, revision: 3, action: 'rollback' },
  ]);
  const audit = await ctx.pool.query(
    'SELECT action,actor_user_id FROM audit_log WHERE target_type=$1',
    ['skill_rollback_policy'],
  );
  expect(audit.rows).toEqual([
    { action: 'skill.rollback_policy_updated', actor_user_id: ctx.userId('MEMBER_B') },
  ]);
});

test('没有可回退版本时只显示提醒，浏览器也无法批准回退', async () => {
  context = await createReviewTestContext();
  const ctx = context;
  const { headers } = await ctx.login();
  await publish(ctx, headers, '1.0.0', 0);
  expect(
    (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/skill-rollback-policy',
        headers,
        payload: { expectedRevision: 0, minimumCards: 1, rejectionPercent: 50 },
      })
    ).statusCode,
  ).toBe(200);
  await finishReview(ctx, headers, '1.0.0', 'rejected');
  await scanSkillRollbackProposals(ctx.pool);
  const [notice] = await proposals(ctx, headers);
  expect(notice).toMatchObject({ status: 'notice', activeVersion: '1.0.0', previousVersion: null });
  expect(
    (
      await ctx.app.inject({
        method: 'POST',
        url: `/api/skill-rollback-proposals/${notice!.id}/decision`,
        headers,
        payload: { action: 'approve', requestKey: randomUUID(), expectedRevision: 1 },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await ctx.pool.query('SELECT revision FROM skill WHERE id=$1', ['R09'])).rows[0]?.revision,
  ).toBe(1);
});
