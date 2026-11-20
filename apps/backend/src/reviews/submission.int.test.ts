import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { reviewSubmitResultSchema } from '@cert-board/shared';
import { createReviewTestContext } from './test-support.js';
import { stageSkillVersion } from '../skills/service.js';

let context: Awaited<ReturnType<typeof createReviewTestContext>> | undefined;
afterEach(async () => {
  if (context) await context.close();
  context = undefined;
});
const cardCount = async () =>
  Number((await context!.pool.query('SELECT count(*) FROM review_card')).rows[0].count);

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
      minimumEvidence: requirement === '证据数' ? 3 : 1,
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
  await expect(context.submit()).rejects.toMatchObject({
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
