import { expect, it } from 'vitest';
import {
  appendConversationMessageSchema,
  conversationEventSchema,
  conversationHistoryOptionsSchema,
} from './conversations.js';

const id = '10000000-0000-4000-8000-000000000001';
it('私有消息使用既有OpenAI契约，保留原文，拒绝空助手与超限输入', () => {
  const input = {
    runId: id,
    userId: id,
    requestKey: id,
    message: { role: 'user', content: '  原文 e\u0301\r\n' },
  };
  expect(appendConversationMessageSchema.parse(input).message).toEqual(input.message);
  for (const message of [
    { role: 'assistant', content: null },
    { role: 'user', content: '文'.repeat(100000) },
    { role: 'user', content: '资料', headers: {} },
  ]) {
    expect(appendConversationMessageSchema.safeParse({ ...input, message }).success).toBe(false);
  }
});
it('界面过程为固定类型有界私有JSON，拒绝嵌套凭据和原始请求头', () => {
  expect(
    conversationEventSchema.safeParse({
      type: 'tool_completed',
      payload: { data: { text: '资料正文' } },
    }).success,
  ).toBe(true);
  for (const payload of [
    { headers: {} },
    { data: { OPENROUTER_API_KEY: 'synthetic' } },
    { credentials: {} },
    { data: { password: 'synthetic' } },
    { text: 'x'.repeat(65536) },
  ]) {
    expect(conversationEventSchema.safeParse({ type: 'tool_completed', payload }).success).toBe(
      false,
    );
  }
  expect(conversationEventSchema.safeParse({ type: 'raw_pi_event', payload: {} }).success).toBe(
    false,
  );
});
it('历史分页默认50，拒绝负游标和超100条读取', () => {
  expect(conversationHistoryOptionsSchema.parse({})).toEqual({ afterSeq: 0, limit: 50 });
  expect(conversationHistoryOptionsSchema.safeParse({ afterSeq: -1 }).success).toBe(false);
  expect(conversationHistoryOptionsSchema.safeParse({ limit: 101 }).success).toBe(false);
});
