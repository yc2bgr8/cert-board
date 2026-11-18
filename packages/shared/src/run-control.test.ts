import { expect, test } from 'vitest';
import {
  runControlNotificationSchema,
  runStopInputSchema,
  runStopParamsSchema,
  runStopResultSchema,
} from './run-control.js';

test('停止通知只包含固定动作与归属编号，不能夹带正文或伪装审批', () => {
  const runId = '10000000-0000-4000-8000-000000000001';
  const userId = '20000000-0000-4000-8000-000000000001';
  const notice = { version: 1, action: 'stop', runId, userId };
  expect(runControlNotificationSchema.safeParse(notice).success).toBe(true);
  expect(runControlNotificationSchema.safeParse({ ...notice, action: 'approve' }).success).toBe(
    false,
  );
  expect(
    runControlNotificationSchema.safeParse({ ...notice, body: '不能进入通知的正文' }).success,
  ).toBe(false);
  expect(runControlNotificationSchema.safeParse({ ...notice, userId: '伪造身份' }).success).toBe(
    false,
  );
});

test('停止接口不接受自报身份或执行权，响应状态明确', () => {
  const runId = '10000000-0000-4000-8000-000000000001';
  expect(runStopInputSchema.safeParse({}).success).toBe(true);
  expect(runStopInputSchema.safeParse({ userId: runId }).success).toBe(false);
  expect(runStopInputSchema.safeParse({ generation: 1 }).success).toBe(false);
  expect(runStopParamsSchema.safeParse({ id: runId }).success).toBe(true);
  expect(runStopResultSchema.safeParse({ runId, status: 'stopped', changed: true }).success).toBe(
    true,
  );
  expect(runStopResultSchema.safeParse({ runId, status: 'approved', changed: true }).success).toBe(
    false,
  );
});
