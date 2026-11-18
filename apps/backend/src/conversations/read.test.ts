import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectConversationEvent } from './read.js';
import { parseEventCursor } from './stream.js';

const row = {
  id: randomUUID(),
  conversationId: randomUUID(),
  runId: randomUUID(),
  seq: 1,
  createdAt: new Date().toISOString(),
};
describe('公开对话过程投影', () => {
  it('旧工具完成事件只投影固定摘要，不透正文、原参数、原摘要或批准内容', () => {
    const result = projectConversationEvent({
      ...row,
      type: 'tool_completed',
      payload: {
        name: 'doc_read',
        callId: 'call-1',
        summary: '不可信旧摘要',
        data: { text: '旧资料正文', arguments: '原参数', recipient: '外部收件人' },
        arguments: '顶层参数',
        approval: { body: '待批准正文' },
      },
    });
    expect(result.payload).toEqual({
      name: 'doc_read',
      callId: 'call-1',
      summary: '读取资料原文已完成',
    });
    expect(JSON.stringify(result)).not.toMatch(/旧资料正文|原参数|旧摘要|收件人|待批准正文/);
  });
  it('所有既有及新增事件有闭合白名单，无效字段不会进入SSE', () => {
    for (const type of [
      'user_message',
      'assistant_message',
      'model_started',
      'tool_started',
      'tool_failed',
      'plan_updated',
      'question',
      'approval_requested',
      'approval_resolved',
      'review_submitted',
      'run_status',
      'progress',
      'changes',
      'question_answered',
      'permission_changed',
    ]) {
      const projected = projectConversationEvent({
        ...row,
        type,
        payload: { arguments: '不得透传', data: '不得透传', headers: '不得透传' },
      });
      expect(projected.seq).toBe(1);
      expect(JSON.stringify(projected)).not.toContain('不得透传');
    }
    expect(
      projectConversationEvent({ ...row, type: 'unexpected', payload: { raw: '不显示' } }).type,
    ).toBe('progress');
  });
  it('用户和助手正文保留但不连带复制其他字段', () => {
    expect(
      projectConversationEvent({
        ...row,
        type: 'assistant_message',
        payload: { content: '正文\n😀', tool_calls: [{ function: { arguments: '秘密参数' } }] },
      }).payload,
    ).toEqual({ content: '正文\n😀' });
  });
  it('运行停机保留有界未投递计数，不接受非数值状态字段', () => {
    expect(
      projectConversationEvent({
        ...row,
        type: 'run_status',
        payload: { status: 'stopped', pendingSteeringCount: 2 },
      }).payload,
    ).toMatchObject({ status: 'stopped', pendingSteeringCount: 2 });
    expect(
      projectConversationEvent({
        ...row,
        type: 'run_status',
        payload: { pendingSteeringCount: '原始参数' },
      }).payload,
    ).not.toHaveProperty('pendingSteeringCount');
  });
});
it('Last-Event-ID只接受无歧义的安全十进制非负整数', () => {
  expect(parseEventCursor(undefined)).toBe(0);
  expect(parseEventCursor('0')).toBe(0);
  expect(parseEventCursor('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  for (const value of [
    '',
    '01',
    '-1',
    '1.1',
    '1e3',
    '1,2',
    ' 1',
    '+1',
    '9007199254740992',
    ['1', '2'],
    '1\nevent: stolen',
  ])
    expect(() => parseEventCursor(value)).toThrow(
      expect.objectContaining({ code: 'EVENT_CURSOR_INVALID' }),
    );
});
