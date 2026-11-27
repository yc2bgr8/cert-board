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
  it('已完成的台账查询只显示经过校验的回执和对应目录的口径', () => {
    const certQuery = {
      status: 'partial',
      template: 'overdue_milestones',
      catalogVersion: '1.0.0',
      scope: 'department',
      asOf: row.createdAt,
      gaps: ['coverage_unverified'],
      truncated: false,
    };
    const payload = {
      name: 'cert_query',
      callId: 'call-1',
      certQuery,
      data: { rows: [{ title: '合成台账正文' }] },
      arguments: '合成查询参数',
    };
    const project = (type: string, event = payload) =>
      projectConversationEvent({ ...row, type, payload: event }).payload;
    expect(project('tool_completed')).toMatchObject({
      certQuery: { ...certQuery, method: expect.stringContaining('法域日历日') },
    });
    expect(JSON.stringify(project('tool_completed'))).not.toMatch(/合成台账正文|合成查询参数|rows/);
    expect(project('tool_completed', { ...payload, name: 'doc_read' })).not.toHaveProperty(
      'certQuery',
    );
    expect(project('tool_failed')).not.toHaveProperty('certQuery');
    const badReceipt = { ...certQuery, rows: ['不得混入回执'] };
    expect(project('tool_completed', { ...payload, certQuery: badReceipt })).not.toHaveProperty(
      'certQuery',
    );
    const oldReceipt = { ...certQuery, catalogVersion: '0.9.0' };
    expect(project('tool_completed', { ...payload, certQuery: oldReceipt })).toMatchObject({
      certQuery: oldReceipt,
    });
    expect(project('tool_completed', { ...payload, certQuery: oldReceipt })).not.toHaveProperty(
      'certQuery.method',
    );
  });
  it('等待过程批准的当前标志和完整旧回执都不能显示工具已完成', () => {
    for (const payload of [
      { name: 'queue_internal_message', awaitingApproval: true, summary: '不可直接透传的摘要' },
      {
        name: 'queue_internal_message',
        data: { approvalId: randomUUID(), status: 'pending', message: '不可直接透传的批准正文' },
      },
    ]) {
      const result = projectConversationEvent({ ...row, type: 'tool_completed', payload });
      expect(result.payload).toEqual({
        name: 'queue_internal_message',
        awaitingApproval: true,
        summary: '等待发起人在浏览器批准后继续',
      });
      expect(JSON.stringify(result)).not.toMatch(/不可直接透传|已完成|approvalId/);
    }
  });
  it('不从任意摘要或无效历史data推断等待批准，不输出原data', () => {
    const result = projectConversationEvent({
      ...row,
      type: 'tool_completed',
      payload: {
        name: 'queue_internal_message',
        summary: '等待发起人在浏览器批准后继续',
        data: { approvalId: '非UUID', status: 'pending', message: '不能透露' },
      },
    });
    expect(result.payload).toEqual({
      name: 'queue_internal_message',
      summary: '登记内部测试消息已完成',
    });
    expect(JSON.stringify(result)).not.toContain('不能透露');
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
  it('预算停机只显示允许的解释，不透上游错误或用量', () => {
    const blocked = projectConversationEvent({
      ...row,
      type: 'run_status',
      payload: {
        status: 'budget_exhausted',
        reasonCode: 'BUDGET_BLOCKED',
        message: '私有错误正文',
        usage: { private: true },
      },
    });
    expect(blocked.payload).toEqual({
      status: 'budget_exhausted',
      summary: '用量或账本状态需要核对。本轮已停止派发模型请求。',
    });
    const unknown = projectConversationEvent({
      ...row,
      type: 'run_status',
      payload: { status: 'failed', reasonCode: '私有错误正文' },
    });
    expect(unknown.payload).toEqual({ status: 'failed', summary: '运行状态已更新。' });
    expect(
      projectConversationEvent({
        ...row,
        type: 'run_status',
        payload: { status: 'stopped', reasonCode: 'REVIEW_NOT_SUBMITTED' },
      }).payload,
    ).toEqual({
      status: 'stopped',
      summary: '本轮结束时未提交审核。请核对已保存的改动和未完成事项。',
    });
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
