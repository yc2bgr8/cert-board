import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { reviewSubmitResultSchema, reviewSections } from '@cert-board/shared';
import { createReviewTestContext } from '../reviews/test-support.js';
import { checkSubmission } from '../checks/service.js';
import { reviewContentHash } from '../reviews/content.js';

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

async function legacyCard() {
  const { decisions: _decisions, ...submission } = context.submission;
  const claim = submission.claims[0]!;
  submission.claims = Array.from({ length: 20 }, (_, index) => ({
    ...claim,
    id: `C${index + 1}`,
    object: '资料'.repeat(100),
    field: '字段'.repeat(100),
    value: '记录'.repeat(1000),
    sources: [submission.evidence[0]!],
  }));
  submission.uncertain = Array.from({ length: 20 }, () => '待核对'.repeat(160));
  submission.missing = Array.from({ length: 20 }, () => '待补充'.repeat(160));
  // 历史合法上限只计原始结构，展示时新增空数组会越过新提交的上限。
  let extra = JSON.stringify(submission).length - 63_995;
  for (const item of submission.claims) {
    const value = String(item.value);
    const remove = Math.min(extra, value.length - 1);
    item.value = value.slice(0, value.length - remove);
    extra -= remove;
  }
  expect(JSON.stringify(submission)).toHaveLength(63_995);
  const checks = await checkSubmission(
    context.pool,
    { runId: context.caller.runId, userId: context.caller.userId },
    context.submission,
  );
  const read = (
    await context.pool.query<{ id: string }>(
      "SELECT id FROM tool_invocation WHERE run_id=$1 AND tool_name='doc_read' AND status='completed' ORDER BY created_at LIMIT 1",
      [context.caller.runId],
    )
  ).rows[0]!;
  const evidenceRefs = submission.evidence.map((source) => ({
    ...source,
    readInvocationId: read.id,
  }));
  const files = (
    await context.pool.query<{ path: string; sha256: string }>(
      'SELECT path,sha256 FROM workspace_file WHERE version_id=$1 ORDER BY path COLLATE "C"',
      [context.workspaceVersion],
    )
  ).rows;
  const diff = {
    baseVersionId: null,
    changes: files.map((file) => ({
      path: file.path,
      change: 'added',
      beforeSha256: null,
      afterSha256: file.sha256,
    })),
  };
  const contentHash = reviewContentHash({
    submission,
    checks,
    diff,
    evidenceRefs,
    risk: 'high',
    cardType: 'finalize',
  });
  const reviewId = randomUUID(),
    invocationId = randomUUID();
  const run = (
    await context.pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM run WHERE id=$1',
      [context.caller.runId],
    )
  ).rows[0]!;
  const tx = await context.pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO tool_invocation(id,run_id,conversation_id,user_id,call_id,tool_name,tool_version,arguments_hash,effect,operation,status,data_level)
      VALUES($1,$2,$3,$4,$5,'submit_for_review','builtin-review-v1',$6,'reversible_write','execute','started','internal')`,
      [
        invocationId,
        context.caller.runId,
        run.conversation_id,
        context.caller.userId,
        randomUUID(),
        createHash('sha256').update(JSON.stringify(submission)).digest('hex'),
      ],
    );
    await tx.query(
      `INSERT INTO undo_record(invocation_id,run_id,conversation_id,user_id,tool_name,tool_version,target_type,target_id,before_state,before_version,status)
      VALUES($1,$2,$3,$4,'submit_for_review','builtin-review-v1','review_card',$5,'{"created":false}'::jsonb,NULL,'pending')`,
      [invocationId, context.caller.runId, run.conversation_id, context.caller.userId, reviewId],
    );
    await tx.query(
      `INSERT INTO review_card(id,project_id,goal_id,conversation_id,run_id,invocation_id,created_by,workspace_version_id,skill_id,skill_version,risk,card_type,structured_result,check_report,diff,evidence_refs,content_hash,data_level)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'high','finalize',$11,$12,$13,$14,$15,'internal')`,
      [
        reviewId,
        context.projectId,
        context.goalId,
        run.conversation_id,
        context.caller.runId,
        invocationId,
        context.caller.userId,
        context.workspaceVersion,
        submission.skill.id,
        submission.skill.version,
        submission,
        checks,
        diff,
        JSON.stringify(evidenceRefs),
        contentHash,
      ],
    );
    await tx.query(
      "UPDATE undo_record SET status='available',after_version='1' WHERE invocation_id=$1",
      [invocationId],
    );
    await tx.query(
      "INSERT INTO conversation_tool_result(invocation_id,conversation_id,user_id,content_json,data_level) VALUES($1,$2,$3,$4,'internal')",
      [
        invocationId,
        run.conversation_id,
        context.caller.userId,
        {
          status: 'completed',
          result: {
            data: {
              reviewId,
              version: 1,
              status: 'pending',
              workspaceVersion: context.workspaceVersion,
              skill: submission.skill,
              requiresBrowserDecision: true,
            },
            dataLevel: 'internal',
            afterVersion: '1',
          },
        },
      ],
    );
    await tx.query("UPDATE tool_invocation SET status='completed' WHERE id=$1", [invocationId]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  return { reviewId, version: 1, workspaceVersion: context.workspaceVersion, contentHash };
}

test('旧无decisions卡的原始内容哈希及已有人的判断均不改写，其他成员仍可审核', async () => {
  const review = await legacyCard();
  const auth = await context.login('MEMBER_A');
  const session = (
    await context.pool.query<{ id: string }>(
      'SELECT id FROM web_session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
      [context.userId('MEMBER_A')],
    )
  ).rows[0]!;
  const statement = '  旧判断 e\u0301\r\n保留原件核对意见。';
  const saved = (
    await context.pool.query<{ id: string }>(
      `INSERT INTO review_judgment(card_id,actor_user_id,session_id,request_key,source_version,content_hash,statement)
    VALUES($1,$2,$3,$4,1,$5,$6) RETURNING id`,
      [
        review.reviewId,
        context.userId('MEMBER_A'),
        session.id,
        randomUUID(),
        review.contentHash,
        statement,
      ],
    )
  ).rows[0]!;
  const before = (
    await context.pool.query('SELECT structured_result,content_hash FROM review_card WHERE id=$1', [
      review.reviewId,
    ])
  ).rows[0];
  expect(Object.hasOwn(before.structured_result, 'decisions')).toBe(false);
  const read = await context.app.inject({
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.json().legacySubmission).toBe(true);
  expect(read.json().submission.decisions).toEqual([]);
  expect(read.json().judgment.statement).toBe(statement);
  expect(read.json().requiresJudgment).toBe(false);
  const other = await context.login('MEMBER_B');
  const colleagueView = await context.app.inject({
    url: `/api/reviews/${review.reviewId}`,
    headers: other.headers,
  });
  expect(colleagueView.statusCode).toBe(200);
  expect(colleagueView.json().judgment).toBeNull();
  const approved = await context.app.inject({
    method: 'POST',
    url: `/api/reviews/${review.reviewId}/decision`,
    headers: other.headers,
    payload: decision(review),
  });
  expect(approved.statusCode).toBe(200);
  const after = (
    await context.pool.query('SELECT structured_result,content_hash FROM review_card WHERE id=$1', [
      review.reviewId,
    ])
  ).rows[0];
  expect(after).toEqual(before);
  expect(
    (await context.pool.query('SELECT statement FROM review_judgment WHERE id=$1', [saved.id]))
      .rows[0].statement,
  ).toBe(statement);
  expect(
    (
      await context.pool.query('SELECT actor_user_id FROM review_decision WHERE card_id=$1', [
        review.reviewId,
      ])
    ).rows[0].actor_user_id,
  ).toBe(context.userId('MEMBER_B'));
});

test('仅用于过程中判断的资料作废后，GET与批准都必须拒绝', async () => {
  const text = '第三份资料：尚待核对原件。';
  const sha = createHash('sha256').update(text).digest('hex');
  const doc = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO document(project_id,source_key,name,source_path,owner_user_id) VALUES($1,'DECISION-ONLY','判断依据','decision.txt',$2) RETURNING id",
      [context.projectId, context.caller.userId],
    )
  ).rows[0]!.id;
  const version = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type) VALUES($1,1,$2,$2,$3,'application/json','parsed_text','internal','external') RETURNING id",
      [doc, sha, Buffer.byteLength(text)],
    )
  ).rows[0]!.id;
  await context.pool.query(
    "INSERT INTO document_page(version_id,page_number,text,method,locator_kind) VALUES($1,1,$2,'text','physical_page')",
    [version, text],
  );
  await context.registry.execute({ ...context.caller, callId: randomUUID() }, 'doc_read', {
    id: doc,
    version: 1,
    page: 1,
  });
  context.submission.decisions = [
    {
      id: 'D1',
      subject: '是否发布',
      choice: '等待原件',
      alternatives: ['立即发布'],
      reason: '判断专属来源仍待核对。',
      sources: [{ documentId: doc, version: 1, page: 1, quote: text }],
      risk: 'high',
    },
  ];
  const review = await card(),
    auth = await context.login('MEMBER_B');
  expect(
    (await context.app.inject({ url: `/api/reviews/${review.reviewId}`, headers: auth.headers }))
      .statusCode,
  ).toBe(200);
  await context.pool.query(
    "UPDATE document SET voided=true,void_reason='判断专属来源作废',version=version+1 WHERE id=$1",
    [doc],
  );
  const read = await context.app.inject({
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(403);
  expect(read.body.includes(text)).toBe(false);
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
    (await context.pool.query('SELECT count(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(0);
});

test('审批只接收带Cookie、CSRF和正确来源的浏览器请求', async () => {
  const review = await card();
  const auth = await context.login('MEMBER_A');
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
    auth = await context.login('MEMBER_A'),
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
    created_by: context.userId('MEMBER_A'),
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

test('高风险直接返回八部分内容，其他成员无需独立判断也能审核并冻结', async () => {
  await context.close();
  context = await createReviewTestContext({ risk: 'high' });
  context.submission.decisions = [
    {
      id: 'D1',
      subject: '如何处理两处编号差异',
      choice: '保留待确认差异',
      alternatives: ['直接选择一个编号'],
      reason: '两处原文写法不同，不能仅凭对照确认正确编号。',
      sources: context.submission.evidence,
      risk: 'high',
    },
  ];
  const review = await card();
  for (const member of ['MEMBER_A', 'MEMBER_B'] as const) {
    const auth = await context.login(member);
    const read = await context.app.inject({
      method: 'GET',
      url: '/api/reviews/' + review.reviewId,
      headers: auth.headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().requiresJudgment).toBe(false);
    expect(read.json().legacySubmission).toBe(false);
    expect(read.json().judgment).toBeNull();
    expect(read.json().sections).toEqual(reviewSections);
    expect(read.json().submission.decisions).toEqual(context.submission.decisions);
    expect(read.body.includes('K123456')).toBe(true);
  }
  const other = await context.login('MEMBER_B');
  const removed = await context.app.inject({
    method: 'POST',
    url: '/api/reviews/' + review.reviewId + '/judgment',
    headers: other.headers,
    payload: {
      expectedVersion: review.version,
      requestKey: randomUUID(),
      statement: '不再需要此入口。',
    },
  });
  expect(removed.statusCode).toBe(404);
  const approved = await context.app.inject({
    method: 'POST',
    url: '/api/reviews/' + review.reviewId + '/decision',
    headers: other.headers,
    payload: decision(review),
  });
  expect(approved.statusCode).toBe(200);
  expect(
    (await context.pool.query('SELECT count(*)::int AS count FROM review_judgment')).rows[0].count,
  ).toBe(0);
  expect(
    (
      await context.pool.query('SELECT actor_user_id FROM review_decision WHERE card_id=$1', [
        review.reviewId,
      ])
    ).rows[0].actor_user_id,
  ).toBe(context.userId('MEMBER_B'));
  expect(
    (
      await context.pool.query('SELECT created_by FROM submission_snapshot WHERE id=$1', [
        approved.json().snapshotId,
      ])
    ).rows[0].created_by,
  ).toBe(context.userId('MEMBER_B'));
  expect(
    (
      await context.pool.query(
        "SELECT actor_user_id FROM audit_log WHERE action='review.approved' AND target_id=$1",
        [review.reviewId],
      )
    ).rows[0].actor_user_id,
  ).toBe(context.userId('MEMBER_B'));
});

test('退回必须说明原因，原因可回读且不会创建冻结快照', async () => {
  const review = await card(),
    auth = await context.login('MEMBER_A');
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
    auth = await context.login('MEMBER_A');
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

test('任何部门成员均可查看审核，禁用和会话撤销实时阻断浏览器决定', async () => {
  const review = await card(),
    auth = await context.login('MEMBER_A'),
    colleague = await context.login('MEMBER_B');
  expect(
    (
      await context.app.inject({
        method: 'GET',
        url: `/api/reviews/${review.reviewId}`,
        headers: colleague.headers,
      })
    ).statusCode,
  ).toBe(200);
  await context.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [
    context.userId('MEMBER_A'),
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
  ).toBe(401);
  const other = await context.login('MEMBER_B');
  await context.pool.query('UPDATE web_session SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1', [
    context.userId('MEMBER_B'),
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
    auth = await context.login('MEMBER_A');
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

test('其他普通部门成员可读取同事提供的依据并完成最终审核', async () => {
  await context.close();
  context = await createReviewTestContext({ documentOwner: 'MEMBER_B' });
  const review = await card(),
    auth = await context.login('MEMBER_B');
  const read = await context.app.inject({
    method: 'GET',
    url: `/api/reviews/${review.reviewId}`,
    headers: auth.headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.body.includes('K123456')).toBe(true);
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
  expect(
    (await context.pool.query('SELECT COUNT(*)::int AS count FROM submission_snapshot')).rows[0]
      .count,
  ).toBe(1);
  expect(
    (
      await context.pool.query('SELECT actor_user_id FROM review_decision WHERE card_id=$1', [
        review.reviewId,
      ])
    ).rows[0].actor_user_id,
  ).toBe(context.userId('MEMBER_B'));
});

test('并发决定只生效一次，决定写入失败时快照也回滚', async () => {
  const review = await card(),
    auth = await context.login('MEMBER_A');
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
    auth = await context.login('MEMBER_A');
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
