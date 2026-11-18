import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { conversationPublicEventSchema } from '@cert-board/shared';
import {
  initialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
} from './events.js';

const conversationId = randomUUID(),
  runId = randomUUID();
const event = (seq: number, type: string, payload: unknown, run = runId) =>
  conversationPublicEventSchema.parse({
    id: randomUUID(),
    conversationId,
    runId: run,
    seq,
    createdAt: '2026-11-18T12:00:00.000Z',
    type,
    payload,
  });
it('同一序号和同一messageId不重复追加，历史只从事件重建', () => {
  const messageId = randomUUID();
  const first = event(1, 'user_message', { content: '原样\n😀', messageId });
  let state = reduceConversationEvent(initialConversationState(conversationId), first);
  expect(reduceConversationEvent(state, first)).toBe(state);
  state = reduceConversationEvent(
    state,
    event(2, 'user_message', { content: '原样\n😀', messageId }),
  );
  expect(state.messages).toHaveLength(1);
  expect(state.lastSeq).toBe(2);
  expect(state.messages[0]?.text).toBe('原样\n😀');
});
it('序号断档、跨对话和frame编号不一致拒绝，不能跳过未读记录', () => {
  const first = event(1, 'model_started', { summary: '读取' });
  expect(() =>
    reduceConversationEvent(initialConversationState(conversationId), {
      ...first,
      conversationId: randomUUID(),
    }),
  ).toThrow();
  expect(() =>
    reduceConversationEvent(
      initialConversationState(conversationId),
      event(2, 'model_started', { summary: '读取' }),
    ),
  ).toThrow();
  expect(() => parseConversationEvent(JSON.stringify(first), 'model_started', '2')).toThrow();
  expect(() => parseConversationEvent(JSON.stringify(first), 'tool_completed', '1')).toThrow();
});
it('按run保留状态，旧轮结束不覆盖新轮，批准等待不冒称完成', () => {
  let state = reduceConversationEvent(
    initialConversationState(conversationId),
    event(1, 'tool_started', {
      callId: 'call1',
      name: 'queue_internal_message',
      summary: '准备消息',
    }),
  );
  state = reduceConversationEvent(
    state,
    event(2, 'tool_completed', {
      callId: 'call1',
      name: 'queue_internal_message',
      awaitingApproval: true,
      summary: '等待发起人批准',
    }),
  );
  expect(state.runs[runId]?.tools).toHaveLength(1);
  expect(state.runs[runId]?.tools[0]?.status).toBe('awaiting_approval');
  const next = randomUUID();
  state = reduceConversationEvent(state, event(3, 'user_message', { content: '新任务' }, next));
  state = reduceConversationEvent(
    state,
    event(4, 'run_status', { status: 'stopped', summary: '已停止', pendingSteeringCount: 2 }),
  );
  expect(state.currentRunId).toBe(next);
  expect(state.runs[next]?.status).toBe('queued');
  expect(state.runs[runId]).toMatchObject({ status: 'stopped', pendingSteeringCount: 2 });
});
it('计划、提问、批准和权限版本由真实事件更新', () => {
  let state = initialConversationState(conversationId);
  state = reduceConversationEvent(
    state,
    event(1, 'plan_updated', {
      steps: [{ title: '读取', status: 'running' }],
      progress: '开始读取',
    }),
  );
  state = reduceConversationEvent(
    state,
    event(2, 'question', { questionId: 'q1', question: '请选择', options: ['保留'] }),
  );
  expect(state.runs[runId]?.question?.questionId).toBe('q1');
  state = reduceConversationEvent(
    state,
    event(3, 'question_answered', { questionId: 'q1', newRunId: randomUUID(), summary: '已回答' }),
  );
  expect(state.runs[runId]?.question).toBeNull();
  state = reduceConversationEvent(
    state,
    event(4, 'permission_changed', {
      permissionMode: 'full',
      permissionVersion: 3,
      summary: '已改变',
    }),
  );
  state = reduceConversationEvent(
    state,
    event(5, 'permission_changed', {
      permissionMode: 'ask',
      permissionVersion: 2,
      summary: '旧模式',
    }),
  );
  expect(state.permissionMode).toBe('full');
  expect(state.permissionVersion).toBe(3);
});
it('工作区改动和预算停机只使用公开摘要与版本，不推测私有错误', () => {
  const version = randomUUID();
  let state = reduceConversationEvent(
    initialConversationState(conversationId),
    event(1, 'changes', { summary: '工作区已保存。', workspaceVersion: version }),
  );
  expect(state.runs[runId]?.workspaceChange).toEqual({
    summary: '工作区已保存。',
    workspaceVersion: version,
    seq: 1,
  });
  state = reduceConversationEvent(
    state,
    event(2, 'run_status', { status: 'budget_exhausted', summary: '运行状态已更新。' }),
  );
  expect(state.runs[runId]?.summary).toContain('用量计量');
  state = reduceConversationEvent(
    state,
    event(3, 'run_status', {
      status: 'budget_exhausted',
      summary: '上次模型调用用量待确认，请负责人核对。',
    }),
  );
  expect(state.runs[runId]?.summary).toBe('上次模型调用用量待确认，请负责人核对。');
});
it('批准结果只关联当前批准编号的末个待批准步骤，执行和未执行分别显示真实终态', () => {
  for (const executed of [true, false]) {
    const approvalId = randomUUID();
    let state = reduceConversationEvent(
      initialConversationState(conversationId),
      event(1, 'tool_completed', {
        callId: 'pending',
        name: 'queue_internal_message',
        awaitingApproval: true,
        summary: '等待批准',
      }),
    );
    state = reduceConversationEvent(
      state,
      event(2, 'approval_requested', { approvalId, summary: '等待发起人批准' }),
    );
    state = reduceConversationEvent(
      state,
      event(3, 'approval_resolved', { approvalId, executed, summary: '批准处理已记录' }),
    );
    expect(state.runs[runId]?.tools[0]?.status).toBe(executed ? 'completed' : 'failed');
    expect(state.runs[runId]?.tools[0]?.summary).toBe(
      executed ? '已按批准执行。' : '本次批准操作未执行，请核对处理结果。',
    );
    expect(state.runs[runId]?.approvalId).toBeNull();
  }
});
it('旧批准或缺少编号的历史结果不能改变当前待批准操作', () => {
  const approvalId = randomUUID();
  let state = reduceConversationEvent(
    initialConversationState(conversationId),
    event(1, 'tool_completed', { callId: 'pending', awaitingApproval: true, summary: '等待批准' }),
  );
  state = reduceConversationEvent(
    state,
    event(2, 'approval_requested', { approvalId, summary: '当前批准' }),
  );
  state = reduceConversationEvent(
    state,
    event(3, 'approval_resolved', { approvalId: randomUUID(), executed: true, summary: '旧批准' }),
  );
  state = reduceConversationEvent(
    state,
    event(4, 'approval_resolved', { executed: true, summary: '缺失编号' }),
  );
  expect(state.runs[runId]?.approvalId).toBe(approvalId);
  expect(state.runs[runId]?.tools[0]?.status).toBe('awaiting_approval');
});
it('停止或其他终态不再把未结束步骤显示为运行中或等待批准', () => {
  for (const status of ['stopped', 'failed', 'budget_exhausted', 'completed']) {
    let state = reduceConversationEvent(
      initialConversationState(conversationId),
      event(1, 'tool_started', { callId: 'working', summary: '执行中' }),
    );
    state = reduceConversationEvent(
      state,
      event(2, 'tool_completed', {
        callId: 'pending',
        awaitingApproval: true,
        summary: '等待批准',
      }),
    );
    state = reduceConversationEvent(
      state,
      event(3, 'run_status', { status, summary: '运行已结束' }),
    );
    expect(state.runs[runId]?.tools.map((tool) => tool.status)).toEqual(['failed', 'failed']);
    expect(state.runs[runId]?.tools.every((tool) => !tool.summary.includes('等待批准'))).toBe(true);
  }
});
