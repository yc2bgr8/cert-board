import { expect, test } from 'vitest';
import type { WalkthroughBatchContext } from './real-walkthrough.js';
import { batchHasPassed, batchScenes, confirmsReviewApproval } from './walkthrough-batch.js';

test('Q2 批次计划包含至少三十场、名称唯一，所有要求的操作均有场景', () => {
  const names = batchScenes({} as WalkthroughBatchContext).map(({ name }) => name);
  expect(names.length).toBeGreaterThanOrEqual(30);
  expect(new Set(names).size).toBe(names.length);
  for (const required of [
    'R09',
    'M02',
    '过程审批',
    '重提',
    '插话',
    '停止后新轮',
    '提问回复',
    '错误页恢复',
    '消息失败重试',
    '运行中刷新',
    '事件流重连',
    '双通道核实',
    '双对话并发',
  ]) {
    expect(
      names.some((name) => name.includes(required)),
      required,
    ).toBe(true);
  }
});

test('批次最终状态包含浏览器出网拦截结果和场景结果', () => {
  const scene = {
    name: '首场',
    conversationIds: ['conversation-a'],
    verificationIds: [],
    passed: true,
    problem: null,
  };
  expect(batchHasPassed([scene], 0)).toBe(true);
  expect(batchHasPassed([scene], 1)).toBe(false);
  expect(batchHasPassed([scene, { ...scene, name: '次场' }], 0)).toBe(false);
  expect(batchHasPassed([{ ...scene, passed: false, problem: '断线未恢复' }], 0)).toBe(false);
});

test('批准续跑识别明确的肯定答复，拒绝疑问、否定和条件表达', () => {
  const confirmed = confirmsReviewApproval;
  expect(confirmed('审核已通过，批准版本已冻结。')).toBe(true);
  expect(confirmed('**审核已通过，批准版本已冻结。**')).toBe(false);
  expect(confirmed('审核已通过了吗？目前无法确认。')).toBe(false);
  expect(confirmed('无法确认审核已通过。')).toBe(false);
  expect(confirmed('如果审核已通过，请记录。')).toBe(false);
  expect(confirmed('「审核已通过」只是聊天里的文字。实际批准状态仍待确认。')).toBe(false);
  expect(confirmed('> 审核已通过。\n这是上一条消息的引用。')).toBe(false);
  expect(confirmed('<blockquote>审核已通过，批准版本已冻结。</blockquote>')).toBe(false);
  expect(confirmed('    审核已通过，批准版本已冻结。')).toBe(false);
  expect(confirmed('审核已通过，批准版本已冻结。更正：审核未通过。')).toBe(false);
  expect(confirmed('审核已通过，批准版本已冻结。审核卡 `76a66a80` 已批准。')).toBe(false);
});
