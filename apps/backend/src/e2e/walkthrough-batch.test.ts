import { expect, test } from 'vitest';
import type { WalkthroughBatchContext } from './real-walkthrough.js';
import { batchScenes } from './walkthrough-batch.js';

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
