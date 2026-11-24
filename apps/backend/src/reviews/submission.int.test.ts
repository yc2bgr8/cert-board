import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { reviewSubmitResultSchema } from '@cert-board/shared';
import { createReviewTestContext } from './test-support.js';
import { stageSkillVersion } from '../skills/service.js';
import {
  captureRunEvaluation,
  readReviewEvaluation,
  updateSemanticEvaluation,
} from '../agent/evaluation/review-evaluation.js';

let context: Awaited<ReturnType<typeof createReviewTestContext>> | undefined;
afterEach(async () => {
  if (context) await context.close();
  context = undefined;
});
const cardCount = async () =>
  Number((await context!.pool.query('SELECT count(*) FROM review_card')).rows[0].count);

test('提交审核自动存档七维评测，重放不重复并且语义回执不能升分', async () => {
  context = await createReviewTestContext();
  const { pool, caller } = context;
  const call = { ...caller, callId: randomUUID() };
  const { reviewId } = reviewSubmitResultSchema.parse((await context.submit(undefined, call)).data);
  const stored = await readReviewEvaluation(pool, caller.runId, reviewId);
  expect(stored?.version).toBe('0.1.0');
  expect(Object.keys(stored?.result.dimensions ?? {})).toHaveLength(7);
  expect(stored?.deterministic.dimensions.evidence.status).toBe('passed');
  expect(stored?.deterministic.dimensions.answer_quality.status).toBe('needs_review');
  expect((await context.submit(undefined, call)).replayed).toBe(true);
  expect(
    (await pool.query('SELECT count(*)::int AS amount FROM eval_report')).rows[0]?.amount,
  ).toBe(1);
  expect(JSON.stringify(stored)).not.toContain(context.submission.evidence[0]!.quote);
  await expect(
    pool.query(
      `UPDATE eval_report SET result=jsonb_set(result,'{overall}','"passed"'::jsonb) WHERE review_id=$1`,
      [reviewId],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    pool.query(
      `UPDATE eval_report SET semantic='{"status":"completed","dimensions":{}}'::jsonb,result=deterministic WHERE review_id=$1`,
      [reviewId],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    pool.query(
      `UPDATE eval_report SET semantic='{"status":"completed","dimensions":{"collaboration":"passed"}}'::jsonb,result=deterministic WHERE review_id=$1`,
      [reviewId],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    pool.query(
      `UPDATE eval_report SET semantic='{"status":"completed","dimensions":{"evidence":"needs_review"},"model":"fixture"}'::jsonb WHERE review_id=$1`,
      [reviewId],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    pool.query(
      `UPDATE eval_report SET semantic='{"status":"completed","dimensions":{"answer_quality":"passed"}}'::jsonb,
      result=jsonb_set(result,'{dimensions,answer_quality,status}','"passed"'::jsonb) WHERE review_id=$1`,
      [reviewId],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await updateSemanticEvaluation(pool, caller.runId, reviewId, {
    status: 'completed',
    dimensions: { answer_quality: 'passed', evidence: 'needs_review' },
  });
  const scored = await readReviewEvaluation(pool, caller.runId, reviewId);
  expect(scored?.result.dimensions.answer_quality.status).toBe('needs_review');
  expect(scored?.result.dimensions.evidence.status).toBe('needs_review');
  await updateSemanticEvaluation(pool, caller.runId, reviewId, {
    status: 'completed',
    dimensions: { answer_quality: 'failed' },
  });
  expect(await readReviewEvaluation(pool, caller.runId, reviewId)).toEqual(scored);
  await expect(
    pool.query("UPDATE eval_report SET deterministic='{}'::jsonb WHERE review_id=$1", [reviewId]),
  ).rejects.toMatchObject({ code: '42501' });
});

test('评测持久化失败保留审核卡，无卡运行仍能存档可观察的评测维度', async () => {
  context = await createReviewTestContext();
  const { pool, caller } = context;
  await pool.query(`CREATE FUNCTION reject_eval_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '合成评测存档故障'; END; $$`);
  await pool.query(
    'CREATE TRIGGER reject_eval_fixture BEFORE INSERT ON eval_report FOR EACH ROW EXECUTE FUNCTION reject_eval_fixture()',
  );
  const { reviewId } = reviewSubmitResultSchema.parse((await context.submit()).data);
  expect(await readReviewEvaluation(pool, caller.runId, reviewId)).toBeNull();
  expect(await cardCount()).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM audit_log WHERE target_id=$1 AND action='evaluation.unavailable'",
        [reviewId],
      )
    ).rowCount,
  ).toBe(1);
  const member = await context.login('MEMBER_B');
  const retryUrl = `/api/reviews/${reviewId}/evaluation/retry`;
  const rejected = await context.app.inject({
    method: 'POST',
    url: retryUrl,
    headers: { ...member.headers, 'x-csrf-token': 'invalid' },
    payload: {},
  });
  expect(rejected.statusCode).toBe(403);
  const replay = () =>
    context!.app.inject({ method: 'POST', url: retryUrl, headers: member.headers, payload: {} });
  const failed = await replay();
  expect(failed.statusCode).toBe(503);
  expect(failed.json()).toMatchObject({ error: { code: 'EVALUATION_RETRY_FAILED' } });
  expect(
    (
      await pool.query(
        "SELECT 1 FROM audit_log WHERE target_id=$1 AND action='evaluation.unavailable'",
        [reviewId],
      )
    ).rowCount,
  ).toBe(2);
  await pool.query('DROP TRIGGER reject_eval_fixture ON eval_report');
  const restored = await replay();
  expect(restored.statusCode).toBe(200);
  expect(restored.json()).toMatchObject({
    version: '0.1.0',
    semantic: { status: 'not_evaluated' },
  });
  expect((await replay()).json()).toEqual(restored.json());
  expect(await cardCount()).toBe(1);
  expect((await pool.query('SELECT count(*)::int AS amount FROM run')).rows[0]?.amount).toBe(1);
  const {
    rows: [run],
  } = await pool.query<{ id: string }>(
    `INSERT INTO run(conversation_id,user_id,project_id,goal_id,status,finished_at)
      SELECT conversation_id,user_id,project_id,goal_id,'completed',clock_timestamp() FROM run WHERE id=$1 RETURNING id`,
    [caller.runId],
  );
  await pool.query(
    'CREATE TRIGGER reject_eval_fixture BEFORE INSERT ON eval_report FOR EACH ROW EXECUTE FUNCTION reject_eval_fixture()',
  );
  await captureRunEvaluation(pool, run!.id, 'completed');
  expect(
    (
      await pool.query(
        "SELECT 1 FROM audit_log WHERE target_type='run' AND target_id=$1 AND action='evaluation.unavailable'",
        [run!.id],
      )
    ).rowCount,
  ).toBe(1);
  expect((await pool.query('SELECT status FROM run WHERE id=$1', [run!.id])).rows[0]?.status).toBe(
    'completed',
  );
  await pool.query('DROP TRIGGER reject_eval_fixture ON eval_report');
  await captureRunEvaluation(pool, run!.id, 'completed');
  await captureRunEvaluation(pool, run!.id, 'completed');
  const final = await pool.query('SELECT review_id, result FROM eval_report WHERE run_id=$1', [
    run!.id,
  ]);
  expect(final.rows).toMatchObject([
    { review_id: null, result: { dimensions: { task_completion: { status: 'not_evaluated' } } } },
  ]);
});

test('同对话重提独立显示本次修改与所有待批文件', async () => {
  const attachment = { path: '交付/待批附件.md', text: '仍待批的附件' };
  context = await createReviewTestContext({ attachment });
  const firstReview = reviewSubmitResultSchema.parse((await context.submit()).data);
  const next = (
    await context.pool.query<{ id: string }>(
      `INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level)
       VALUES($1,$2,2,$3,'system','改稿回归','internal') RETURNING id`,
      [context.workspaceId, context.projectId, context.workspaceVersion],
    )
  ).rows[0]!.id;
  const after = createHash('sha256').update('原报告只修改两处').digest('hex');
  await context.pool.query(
    `INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type)
     VALUES($1,'交付/核查报告.md',$2,24,'internal','text/markdown')`,
    [next, after],
  );
  await context.pool.query(
    `INSERT INTO workspace_file(version_id,path,sha256,byte_size,data_level,media_type)
     SELECT $1,path,sha256,byte_size,data_level,media_type FROM workspace_file WHERE version_id=$2 AND path=$3`,
    [next, context.workspaceVersion, attachment.path],
  );
  await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
    next,
    context.workspaceId,
  ]);
  await context.pool.query("UPDATE run SET status='completed',finished_at=now() WHERE id=$1", [
    context.caller.runId,
  ]);
  const run = (
    await context.pool.query<{ id: string }>(
      `INSERT INTO run(conversation_id,user_id,project_id,goal_id,direction_version,status)
       SELECT conversation_id,user_id,project_id,goal_id,direction_version,'running' FROM run WHERE id=$1
       RETURNING id`,
      [context.caller.runId],
    )
  ).rows[0]!.id;
  const caller = { ...context.caller, runId: run, callId: randomUUID() };
  await context.read(caller);
  const revision = reviewSubmitResultSchema.parse(
    (
      await context.submit(
        { ...context.submission, workspaceVersion: next },
        { ...caller, callId: randomUUID() },
      )
    ).data,
  );
  const first = (
    await context.pool.query('SELECT status FROM review_card WHERE id=$1', [firstReview.reviewId])
  ).rows[0];
  expect(first?.status).toBe('pending');
  const {
    rows: [card],
  } = await context.pool.query('SELECT diff FROM review_card WHERE id=$1', [revision.reviewId]);
  expect(card.diff).toEqual({
    baseVersionId: context.workspaceVersion,
    changes: [
      {
        path: '交付/核查报告.md',
        change: 'modified',
        beforeSha256: createHash('sha256').update('').digest('hex'),
        afterSha256: after,
      },
    ],
    approvalBase: {
      baseVersionId: null,
      changes: expect.arrayContaining([
        { path: '交付/核查报告.md', change: 'added', beforeSha256: null, afterSha256: after },
        {
          path: attachment.path,
          change: 'added',
          beforeSha256: null,
          afterSha256: createHash('sha256').update(attachment.text).digest('hex'),
        },
      ]),
    },
  });
  expect(card.diff.approvalBase.changes).toHaveLength(2);
});

test.each(['检查项', '证据数'] as const)('提交审核执行发布技能的%s要求', async (requirement) => {
  context = await createReviewTestContext();
  const staged = await stageSkillVersion(context.pool, {
    metadata: {
      ...context.submission.skill,
      name: '合成策略',
      summary: '验证审核约束',
      agentCode: 'registration',
      capability: '一致性检查',
      level: 2,
      modes: ['ask', 'full'],
      requiredChecks: requirement === '检查项' ? ['V1', 'V3', 'V6'] : ['V1', 'V3'],
      minimumEvidence: requirement === '证据数' ? 2 : 1,
      risk: 'standard',
      suggestedSubagents: [],
    },
    body: '合成审核测试。',
  });
  const reviewer = await context.login('MEMBER_B');
  const release = await context.app.inject({
    method: 'POST',
    url: `/api/skills/${context.submission.skill.id}/actions`,
    headers: reviewer.headers,
    payload: {
      action: 'publish',
      requestKey: randomUUID(),
      expectedRevision: 0,
      versionId: staged.id,
      contentSha256: staged.contentSha256,
    },
  });
  expect(release.statusCode).toBe(200);
  const input =
    requirement === '证据数'
      ? {
          ...context.submission,
          claims: context.submission.claims.map((claim) => ({
            ...claim,
            sources: claim.sources.slice(0, 1),
          })),
        }
      : context.submission;
  if (requirement === '证据数') {
    expect(input.evidence).toHaveLength(2);
    expect(input.claims[0]?.sources).toHaveLength(1);
  }
  await expect(context.submit(input)).rejects.toMatchObject({
    code: 'TOOL_DATA_REJECTED',
    message: expect.stringContaining(
      requirement === '检查项' ? '关键检查未通过' : '依据数量低于当前技能',
    ),
  });
  expect(await cardCount()).toBe(0);
});

test('两条同页不同完整引语可提交，重复并发call只生成一张不可变卡片', async () => {
  context = await createReviewTestContext();
  const call = { ...context.caller, callId: randomUUID() };
  const [first, second] = await Promise.all([
    context.submit(undefined, call),
    context.submit(undefined, call),
  ]);
  const result = reviewSubmitResultSchema.parse(first.data);
  expect([first, second].filter((result) => result.replayed)).toHaveLength(1);
  expect(reviewSubmitResultSchema.parse(second.data).reviewId).toBe(result.reviewId);
  expect(await cardCount()).toBe(1);
  const card = (
    await context.pool.query('SELECT * FROM review_card WHERE id=$1', [result.reviewId])
  ).rows[0];
  expect(card.risk).toBe('standard');
  expect(card.card_type).toBe('finalize');
  expect(card.evidence_refs).toHaveLength(2);
  expect(
    card.evidence_refs.every((ref: { readInvocationId: string }) =>
      /^[0-9a-f-]{36}$/.test(ref.readInvocationId),
    ),
  ).toBe(true);
  expect(card.check_report.notRun).toEqual(['V2', 'V4', 'V5', 'V6', 'V7', 'V8']);
  expect(card.diff.changes[0].path).toBe('交付/核查报告.md');
  expect(
    (await context.pool.query('SELECT status FROM run WHERE id=$1', [context.caller.runId])).rows[0]
      .status,
  ).toBe('running');
  const mutationRejected = await context.pool
    .query("UPDATE review_card SET structured_result='{}'::jsonb WHERE id=$1", [result.reviewId])
    .then(
      () => false,
      () => true,
    );
  expect(mutationRejected).toBe(true);
});

test('V1通过也不能用未读取的资料直接建卡，失败全部回滚', async () => {
  context = await createReviewTestContext({ autoRead: false });
  await expect(context.submit()).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
  expect(
    Number(
      (
        await context.pool.query(
          "SELECT count(*) FROM undo_record WHERE tool_name='submit_for_review'",
        )
      ).rows[0].count,
    ),
  ).toBe(0);
});

test('搜索摘要即使内容完整也不是doc_read回执', async () => {
  context = await createReviewTestContext({ readToolName: 'doc_search' });
  await expect(context.submit()).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('只读到部分引语不能证明完整引用已读', async () => {
  context = await createReviewTestContext({ readText: '第一处 K123456\n第二处' });
  await expect(context.submit()).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('决策独有引语也必须在完整doc_read回执内，补读后才允许提交', async () => {
  const options: { readText?: string } = { readText: '第一处 K123456\n第二处 K654321' };
  context = await createReviewTestContext(options);
  const data = structuredClone(context.submission);
  data.decisions = [
    {
      id: 'D1',
      subject: '是否确认编号',
      choice: '保留待确认',
      alternatives: ['直接选用一个编号'],
      reason: '资料明确说明不代表正确编号。',
      sources: [
        {
          documentId: context.documentId,
          version: 1,
          page: 1,
          quote: '纯虚构测试资料，不代表正确编号。',
        },
      ],
      risk: 'high',
    },
  ];
  await expect(context.submit(data)).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
  delete options.readText;
  await context.read();
  expect(reviewSubmitResultSchema.parse((await context.submit(data)).data).status).toBe('pending');
});

test('两次分段读取不能拼装成一条完整读取回执', async () => {
  const options = { autoRead: false, readText: '第一处 K123456' };
  context = await createReviewTestContext(options);
  await context.read();
  options.readText = '第二处 K654321';
  await context.read();
  const data = structuredClone(context.submission);
  data.claims[0]!.sources[0]!.quote = '第一处 K123456 第二处 K654321';
  await expect(context.submit(data)).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('同用户另一对话的成功读取不能用于本对话审核', async () => {
  context = await createReviewTestContext();
  const run = await context.run();
  await expect(
    context.submit(undefined, { runId: run.runId, userId: run.userId, callId: randomUUID() }),
  ).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('同一对话历史运行中的成功读取仍可证明已读', async () => {
  context = await createReviewTestContext();
  const conversationId = (
    await context.pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM run WHERE id=$1',
      [context.caller.runId],
    )
  ).rows[0]!.conversation_id;
  await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [context.caller.runId]);
  const runId = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO run(conversation_id,user_id,project_id,goal_id,status) VALUES($1,$2,$3,$4,'running') RETURNING id",
      [conversationId, context.caller.userId, context.projectId, context.goalId],
    )
  ).rows[0]!.id;
  const result = await context.submit(undefined, {
    runId,
    userId: context.caller.userId,
    callId: randomUUID(),
  });
  expect(reviewSubmitResultSchema.parse(result.data).status).toBe('pending');
  expect(await cardCount()).toBe(1);
});

test('只改变空白的重复证据不会凑足最少两条证据', async () => {
  context = await createReviewTestContext();
  const data = structuredClone(context.submission);
  data.evidence = [data.evidence[0]!, { ...data.evidence[0]!, quote: '第一处\n\tK123456' }];
  await expect(context.submit(data)).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('V1关键检查失败不生成审核卡', async () => {
  context = await createReviewTestContext();
  const data = structuredClone(context.submission);
  data.claims[0]!.sources[0]!.quote = '第一处 K123457';
  await expect(context.submit(data)).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('提交只接受最新已发布版本，旧版本或未发布版本都拒绝', async () => {
  context = await createReviewTestContext();
  const next = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','新版','internal') RETURNING id",
      [context.workspaceId, context.projectId, context.workspaceVersion],
    )
  ).rows[0]!.id;
  await expect(
    context.submit({ ...context.submission, workspaceVersion: next }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
    next,
    context.workspaceId,
  ]);
  await expect(context.submit()).rejects.toMatchObject({ statusCode: 409 });
  expect(await cardCount()).toBe(0);
});

test('pending审核卡可撤销且重复撤销不重复生效，旧pending回执不能重放', async () => {
  context = await createReviewTestContext();
  const call = { ...context.caller, callId: randomUUID() };
  const first = await context.submit(undefined, call);
  const reviewId = reviewSubmitResultSchema.parse(first.data).reviewId;
  expect(first.undoId).not.toBeNull();
  const undoCall = { ...context.caller, callId: randomUUID() };
  await context.registry.undo(undoCall, first.undoId!);
  await context.registry.undo(undoCall, first.undoId!);
  expect(
    (await context.pool.query('SELECT status,version FROM review_card WHERE id=$1', [reviewId]))
      .rows[0],
  ).toMatchObject({ status: 'cancelled', version: 2 });
  await expect(context.submit(undefined, call)).rejects.toMatchObject({ statusCode: 409 });
});

test('卡片写入后审计失败时连同undo和工具调用一起回滚', async () => {
  context = await createReviewTestContext();
  await context.pool.query(
    "CREATE FUNCTION fail_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='review.submitted' THEN RAISE EXCEPTION 'PRIVATE_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$",
  );
  await context.pool.query(
    'CREATE TRIGGER fail_review_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_review_audit()',
  );
  let message = '';
  try {
    await context.submit();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message.includes('PRIVATE_AUDIT_FAILURE')).toBe(false);
  expect(message.length > 0).toBe(true);
  expect(await cardCount()).toBe(0);
  expect(
    Number(
      (
        await context.pool.query(
          "SELECT count(*) FROM tool_invocation WHERE tool_name='submit_for_review'",
        )
      ).rows[0].count,
    ),
  ).toBe(0);
});

test('旧审核回执重放继承来源历史升密，状态与原始正文不改', async () => {
  context = await createReviewTestContext();
  const call = { ...context.caller, callId: randomUUID() };
  const first = await context.submit(undefined, call);
  expect(first.dataLevel).toBe('internal');
  const digest = createHash('sha256').update('confidential-v2').digest('hex');
  await context.pool.query(
    "INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type) VALUES($1,2,$2,$2,0,'application/json','parsed_text','confidential','external')",
    [context.documentId, digest],
  );
  const second = await context.submit(undefined, call);
  expect(second.replayed).toBe(true);
  expect(second.dataLevel).toBe('confidential');
  expect(await cardCount()).toBe(1);
});

test('模型不能自报风险或更换未登记技能版本', async () => {
  context = await createReviewTestContext();
  await expect(context.submit({ ...context.submission, risk: 'standard' })).rejects.toBeDefined();
  await expect(
    context.submit({ ...context.submission, skill: { id: 'R09', version: '99.0.0' } }),
  ).rejects.toMatchObject({ statusCode: 422 });
  expect(await cardCount()).toBe(0);
});

test('普通成员可引用同事资料，禁用后新提交与历史重放均拒绝', async () => {
  context = await createReviewTestContext();
  const call = { ...context.caller, callId: randomUUID() };
  await context.submit(undefined, call);
  await context.pool.query('UPDATE document SET owner_user_id=$1 WHERE id=$2', [
    context.userId('MEMBER_B'),
    context.documentId,
  ]);
  expect((await context.submit(undefined, call)).replayed).toBe(true);
  await context.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [
    context.caller.userId,
  ]);
  await expect(context.submit()).rejects.toMatchObject({ statusCode: 403 });
  await expect(context.submit(undefined, call)).rejects.toMatchObject({ statusCode: 403 });
  expect(await cardCount()).toBe(1);
});
