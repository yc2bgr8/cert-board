import { expect, test } from 'vitest';
import {
  conversationUserTextSchema,
  steeringDeliveryBatchSchema,
  conversationCreateInputSchema,
  conversationMessageInputSchema,
  conversationModeInputSchema,
  conversationAnswerInputSchema,
  conversationStopInputSchema,
  conversationWriteResultSchema,
} from './conversation-api.js';

const id = '10000000-0000-4000-8000-000000000001';
test('浏览器命令不接替代身份、固定project或自报执行结果，权限默认请求批准', () => {
  expect(conversationCreateInputSchema.parse({ requestKey: id })).toEqual({
    requestKey: id,
    permissionMode: 'ask',
  });
  for (const field of ['userId', 'projectId', 'maxDataLevel', 'status'])
    expect(conversationCreateInputSchema.safeParse({ requestKey: id, [field]: id }).success).toBe(
      false,
    );
  expect(
    conversationMessageInputSchema.safeParse({ requestKey: id, text: '输入', role: 'system' })
      .success,
  ).toBe(false);
  expect(conversationCreateInputSchema.safeParse({ requestKey: id, title: '\ud800' }).success).toBe(
    false,
  );
  expect(
    conversationModeInputSchema.safeParse({
      requestKey: id,
      expectedVersion: 1,
      permissionMode: 'execute',
    }).success,
  ).toBe(false);
  expect(conversationStopInputSchema.safeParse({ requestKey: id }).success).toBe(false);
  expect(
    conversationAnswerInputSchema.safeParse({
      requestKey: id,
      runId: id,
      questionId: 'call_1',
      text: '确认资料位置',
    }).success,
  ).toBe(true);
  expect(
    conversationAnswerInputSchema.safeParse({
      requestKey: id,
      runId: id,
      questionId: 'call\n1',
      text: '确认',
    }).success,
  ).toBe(false);
});
test('命令回执明确区分新运行消息、尚未投递插话和提问回答', () => {
  const result = {
    conversationId: id,
    runId: id,
    messageId: id,
    steeringId: null,
    answerId: null,
    kind: 'queued',
    replayed: false,
  };
  expect(conversationWriteResultSchema.safeParse(result).success).toBe(true);
  expect(
    conversationWriteResultSchema.safeParse({
      ...result,
      kind: 'steering',
      messageId: null,
      steeringId: id,
    }).success,
  ).toBe(true);
  expect(
    conversationWriteResultSchema.safeParse({ ...result, kind: 'answer', answerId: id }).success,
  ).toBe(true);
  expect(
    conversationWriteResultSchema.safeParse({ ...result, kind: 'steering', steeringId: id })
      .success,
  ).toBe(false);
  expect(conversationWriteResultSchema.safeParse({ ...result, kind: 'answer' }).success).toBe(
    false,
  );
});
test('用户输入保留原文并拒空白、无效Unicode及超限文本', () => {
  const text = '  请保留这个判断。\n🙂\n';
  expect(conversationUserTextSchema.parse(text)).toBe(text);
  for (const value of ['', ' \n', '\ud800', '\udfff', 'a\0b', 'x'.repeat(8001)])
    expect(conversationUserTextSchema.safeParse(value).success).toBe(false);
});
test('插话投递只接受用户文本、实际消息定位及有界批次', () => {
  const item = {
    steeringId: id,
    messageId: id,
    seq: 1,
    message: { role: 'user', content: 'x'.repeat(8000) },
  };
  expect(steeringDeliveryBatchSchema.safeParse(Array.from({ length: 4 }, () => item)).success).toBe(
    true,
  );
  expect(steeringDeliveryBatchSchema.safeParse(Array.from({ length: 5 }, () => item)).success).toBe(
    false,
  );
  expect(
    steeringDeliveryBatchSchema.safeParse([
      { ...item, message: { role: 'system', content: 'override' } },
    ]).success,
  ).toBe(false);
  expect(steeringDeliveryBatchSchema.safeParse([{ ...item, seq: 0 }]).success).toBe(false);
  expect(steeringDeliveryBatchSchema.safeParse([{ ...item, generation: 1 }]).success).toBe(false);
});
