import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { reviewSubmitResultSchema } from '@cert-board/shared';
import { createReviewTestContext } from '../reviews/test-support.js';

let context: Awaited<ReturnType<typeof createReviewTestContext>>;
beforeEach(async () => {
  context = await createReviewTestContext();
});
afterEach(async () => {
  await context?.close();
});
async function card() {
  return reviewSubmitResultSchema.parse((await context.submit()).data);
}
const decision = (
  value: { version: number; workspaceVersion: string },
  action: 'approved' | 'rejected' = 'approved',
) => ({
  expectedVersion: value.version,
  workspaceVersion: value.workspaceVersion,
  requestKey: randomUUID(),
  action,
  ...(action === 'rejected' ? { reason: '请核对原件后重新提交。' } : {}),
});

test('审批只接收带Cookie、CSRF和正确来源的浏览器请求', async () => {
  const review = await card();
  const auth = await context.login('RA');
  const payload = decision(review);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: { origin: context.config.WEB_ORIGIN, 'sec-fetch-site': 'same-origin' },
        payload,
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: { cookie: auth.cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: { ...auth.headers, origin: 'http://127.0.0.1:9999' },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  const { 'x-csrf-token': _csrf, ...withoutCsrf } = auth.headers;
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: withoutCsrf,
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM review_decision')).rows[0].count,
  ).toBe(0);
});

test('浏览器会话请求批准只冻结一次，重试幂等，快照与判断只追加', async () => {
  const review = await card(),
    auth = await context.login('RA'),
    payload = decision(review);
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${review.reviewId}/decision`,
    headers: auth.headers,
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    cardId: review.reviewId,
    status: 'approved',
    version: 2,
    replayed: false,
  });
  const repeated = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${review.reviewId}/decision`,
    headers: auth.headers,
    payload,
  });
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json().replayed).toBe(true);
  const rows = await context.pool.query(
    'SELECT (SELECT COUNT(*)::int FROM review_decision) AS decisions,(SELECT COUNT(*)::int FROM submission_snapshot) AS snapshots',
  );
  expect(rows.rows[0]).toEqual({ decisions: 1, snapshots: 1 });
  const snapshot = (
    await context.pool.query('SELECT kind,workspace_version_id,created_by FROM submission_snapshot')
  ).rows[0];
  expect(snapshot).toMatchObject({
    kind: 'approved_review',
    workspace_version_id: review.workspaceVersion,
    created_by: context.userId('RA'),
  });
  await expect(
    context.pool.query("UPDATE submission_snapshot SET kind='submission'"),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    context.registry.undo(
      { ...context.caller, callId: randomUUID() },
      (await context.pool.query('SELECT id FROM undo_record WHERE target_id=$1', [review.reviewId]))
        .rows[0].id,
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json()).toMatchObject({
    status: 'approved',
    requiresJudgment: false,
    decision: { action: 'approved' },
  });
});

test('高风险全部AI内容在本人判断前隐藏，别人的判断不能借用', async () => {
  await context.close();
  context = await createReviewTestContext({ risk: 'high' });
  const review = await card(),
    auth = await context.login('RA'),
    other = await context.login('RB');
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(200);
  const locked = read.json();
  expect(locked.requiresJudgment).toBe(true);
  for (const key of ['submission', 'checks', 'diff', 'evidenceRefs', 'judgment', 'decision'])
    expect(Object.hasOwn(locked, key)).toBe(false);
  expect(read.body.includes('K123456')).toBe(false);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(403);
  const judgment = {
    expectedVersion: review.version,
    requestKey: randomUUID(),
    statement: '我先独立核对原文，认为两处编号不同，尚不能判断哪处正确。',
  };
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/judgment`,
        headers: auth.headers,
        payload: judgment,
      })
    ).statusCode,
  ).toBe(200);
  const repeat = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${review.reviewId}/judgment`,
    headers: auth.headers,
    payload: judgment,
  });
  expect(repeat.json().replayed).toBe(true);
  expect(
    (
      await context.app.inject({
        method: 'GET',
        url: `/api/reviews/${review.reviewId}`,
        headers: auth.headers,
      })
    ).json().requiresJudgment,
  ).toBe(false);
  expect(
    (
      await context.app.inject({
        method: 'GET',
        url: `/api/reviews/${review.reviewId}`,
        headers: other.headers,
      })
    ).json().requiresJudgment,
  ).toBe(true);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: other.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/judgment`,
        headers: auth.headers,
        payload: { ...judgment, requestKey: randomUUID(), statement: '见到AI后想改写原独立判断。' },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(200);
});

test('退回必须说明原因，原因可回读且不会创建冻结快照', async () => {
  const review = await card(),
    auth = await context.login('RA');
  const payload = decision(review, 'rejected');
  const { reason: _reason, ...without } = payload;
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: without,
      })
    ).statusCode,
  ).toBe(400);
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${review.reviewId}/decision`,
    headers: auth.headers,
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'rejected', snapshotId: null });
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.json().decision.reason).toBe(payload.reason);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(0);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: { ...payload, reason: '另一原因' },
      })
    ).statusCode,
  ).toBe(409);
});

test('卡片或工作区旧版本不能批准，目标停止也拒绝', async () => {
  const review = await card(),
    auth = await context.login('RA');
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: { ...decision(review), expectedVersion: 9 },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: { ...decision(review), workspaceVersion: randomUUID() },
      })
    ).statusCode,
  ).toBe(409);
  await context.pool.query("UPDATE goal SET status='paused',version=version+1 WHERE id=$1", [
    context.goalId,
  ]);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(409);
});

test('会话撤销和角色变化实时生效，管理角色不能冒用注册审核', async () => {
  const review = await card(),
    auth = await context.login('RA'),
    manager = await context.login('GM');
  expect(
    (
      await context.app.inject({
        method: 'GET',
        url: `/api/reviews/${review.reviewId}`,
        headers: manager.headers,
      })
    ).statusCode,
  ).toBe(403);
  await context.pool.query('DELETE FROM role_binding WHERE user_id=$1', [context.userId('RA')]);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(403);
  const other = await context.login('RB');
  await context.pool.query('UPDATE web_session SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1', [
    context.userId('RB'),
  ]);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: other.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(401);
});

test('引用资料作废后不能读取AI正文或作新决定', async () => {
  const review = await card(),
    auth = await context.login('RA');
  await context.pool.query(
    "UPDATE document SET voided=true,void_reason='测试作废',version=version+1 WHERE id=$1",
    [context.documentId],
  );
  expect(
    (
      await context.app.inject({
        method: 'GET',
        url: `/api/reviews/${review.reviewId}`,
        headers: auth.headers,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(0);
});

test('注册own权限不能借管理global角色读取引用或批准', async () => {
  await context.close();
  context = await createReviewTestContext({ documentOwnerRole: 'RB' });
  const review = await card(),
    auth = await context.login('RA');
  await context.pool.query('DELETE FROM role_binding WHERE user_id=$1', [context.userId('RA')]);
  await context.pool.query(
    "INSERT INTO role_binding(user_id,role,scope_type) VALUES($1,'RA','own'),($1,'GM','global')",
    [context.userId('RA')],
  );
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(403);
  expect(read.body.includes('K123456')).toBe(false);
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(0);
});

test('并发决定只生效一次，决定写入失败时快照也回滚', async () => {
  const review = await card(),
    auth = await context.login('RA');
  await context.pool
    .query(`CREATE FUNCTION reject_test_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_TEST_FAILURE'; END $$;
    CREATE TRIGGER reject_test_review BEFORE INSERT ON review_decision FOR EACH ROW EXECUTE FUNCTION reject_test_review_decision();`);
  const failed = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${review.reviewId}/decision`,
    headers: auth.headers,
    payload: decision(review),
  });
  expect(failed.statusCode).toBe(500);
  expect(failed.body.includes('PRIVATE_TEST_FAILURE')).toBe(false);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(0);
  await context.pool.query('DROP TRIGGER reject_test_review ON review_decision');
  const responses = await Promise.all(
    [1, 2].map(() =>
      context.app.inject({
        method: 'POST',
        url: `/api/reviews/${review.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(review),
      }),
    ),
  );
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(1);
});

test('新稿不能批准旧卡，下一次提交的差异以真实已批准版本为基线', async () => {
  const first = await card(),
    auth = await context.login('RA');
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${first.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(first),
      })
    ).statusCode,
  ).toBe(200);
  const stale = await card();
  const next = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','新稿fixture','internal') RETURNING id",
      [context.workspaceId, context.projectId, context.workspaceVersion],
    )
  ).rows[0]!.id;
  await context.pool.query(
    "INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type) VALUES($1,'交付/核查报告.md',$2,1,'internal','text/markdown')",
    [next, 'c'.repeat(64)],
  );
  await context.pool.query(
    'UPDATE workspace SET current_version_id=$1,version=version+1 WHERE id=$2',
    [next, context.workspaceId],
  );
  expect(
    (
      await context.app.inject({
        method: 'POST',
        url: `/api/reviews/${stale.reviewId}/decision`,
        headers: auth.headers,
        payload: decision(stale),
      })
    ).statusCode,
  ).toBe(409);
  const second = reviewSubmitResultSchema.parse(
    (await context.submit({ ...context.submission, workspaceVersion: next })).data,
  );
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${second.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().diff).toMatchObject({
    baseVersionId: context.workspaceVersion,
    changes: [{ path: '交付/核查报告.md', change: 'modified' }],
  });
});
