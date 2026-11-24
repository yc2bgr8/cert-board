import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { humanFeedbackResultSchema } from '@cert-board/shared';
import { createReviewTestContext } from '../reviews/test-support.js';
import { ToolRegistry } from '../tools/registry.js';
import { skillLoadTool } from '../tools/skill-load.js';
import { appendConversationMessage } from './storage.js';

test('共享注册成员可对 Agent 消息和审核卡作浏览器反馈，保留实际技能版本和本人最近选择', async () => {
  const c = await createReviewTestContext();
  try {
    const original = await c.run('MEMBER_A', 'full');
    const registered = new ToolRegistry(c.pool, [skillLoadTool()], { environment: 'test' });
    await registered.execute(
      { runId: original.runId, userId: original.userId, callId: original.callId },
      'skill_load',
      { id: 'R09' },
    );
    const assistant = await appendConversationMessage(c.pool, {
      runId: original.runId,
      userId: original.userId,
      requestKey: randomUUID(),
      message: { role: 'assistant', content: '合成资料段落的核查结论。' },
    });
    const user = await appendConversationMessage(c.pool, {
      runId: original.runId,
      userId: original.userId,
      requestKey: randomUUID(),
      message: { role: 'user', content: '合成用户问题。' },
    });
    const owner = await c.login('MEMBER_A');
    const peer = await c.login('MEMBER_B');
    const url = `/api/conversations/${original.conversationId}/feedback`;
    const send = (
      payload: object,
      headers: Record<string, string> = peer.headers,
      endpoint = url,
    ) => c.app.inject({ method: 'POST', url: endpoint, headers, payload });
    const helpful = {
      kind: 'message',
      targetId: assistant.id,
      requestKey: randomUUID(),
      rating: 'helpful',
      reason: null,
    };
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = peer.headers;
    expect((await send(helpful, withoutCsrf)).statusCode).toBe(403);
    expect((await send({ ...helpful, targetId: user.id })).statusCode).toBe(404);
    const another = await c.run('MEMBER_A');
    expect(
      (await send(helpful, peer.headers, `/api/conversations/${another.conversationId}/feedback`))
        .statusCode,
    ).toBe(404);
    const submitted = await send(helpful);
    expect(submitted.statusCode).toBe(200);
    const first = humanFeedbackResultSchema.parse(submitted.json());
    expect((await send(helpful)).json()).toEqual(first);
    expect((await send({ ...helpful, rating: 'unhelpful' })).statusCode).toBe(409);
    expect(
      (
        await c.pool.query('SELECT skills,user_id,data_level FROM human_feedback WHERE id=$1', [
          first.id,
        ])
      ).rows,
    ).toEqual([
      {
        skills: [expect.objectContaining({ id: 'R09', version: expect.any(String) })],
        user_id: c.userId('MEMBER_B'),
        data_level: 'internal',
      },
    ]);
    const change = await send({
      ...helpful,
      requestKey: randomUUID(),
      rating: 'unhelpful',
      reason: '请核对合成段落。',
    });
    const corrected = humanFeedbackResultSchema.parse(change.json());
    expect(corrected.rating).toBe('unhelpful');
    const selected = `${url}?kind=message&targetId=${assistant.id}`;
    expect((await c.app.inject({ url: selected, headers: peer.headers })).json()).toEqual({
      item: corrected,
    });
    expect((await c.app.inject({ url: selected, headers: owner.headers })).json()).toEqual({
      item: null,
    });
    expect(
      (await c.pool.query('SELECT data_level FROM human_feedback WHERE id=$1', [corrected.id]))
        .rows,
    ).toEqual([{ data_level: 'confidential' }]);
    await expect(
      c.pool.query('DELETE FROM human_feedback WHERE id=$1', [first.id]),
    ).rejects.toMatchObject({ code: '55000' });

    await c.submit();
    const {
      rows: [card],
    } = await c.pool.query<{ id: string; conversation_id: string }>(
      'SELECT id,conversation_id FROM review_card WHERE run_id=$1',
      [c.caller.runId],
    );
    const cardResult = await send(
      { ...helpful, targetId: card!.id, kind: 'review', requestKey: randomUUID() },
      peer.headers,
      `/api/conversations/${card!.conversation_id}/feedback`,
    );
    const recorded = humanFeedbackResultSchema.parse(cardResult.json());
    expect(recorded).toMatchObject({ kind: 'review', targetId: card!.id, rating: 'helpful' });
    expect(
      (await c.pool.query('SELECT skills FROM human_feedback WHERE id=$1', [recorded.id])).rows,
    ).toEqual([{ skills: [c.policy.skill] }]);
    expect(
      (await c.pool.query('SELECT status FROM review_card WHERE id=$1', [card!.id])).rows,
    ).toEqual([{ status: 'pending' }]);
  } finally {
    await c.close();
  }
});
