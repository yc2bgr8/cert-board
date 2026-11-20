import { expect, test, vi } from 'vitest';
import { emailDispatchResult, incomingEmailSourceId } from './email.js';

test('收到明确 SMTP 回执直接分类，只有结果不明才查询已发送', async () => {
  const lookup = vi.fn<() => Promise<'found' | 'missing'>>().mockResolvedValue('found');
  expect(await emailDispatchResult('accepted', lookup)).toBe('done');
  expect(await emailDispatchResult('rejected', lookup)).toBe('failed');
  expect(lookup).not.toHaveBeenCalled();
  expect(await emailDispatchResult('disconnected', lookup)).toBe('done');
  lookup.mockRejectedValueOnce(new Error('fixture lookup unavailable'));
  expect(await emailDispatchResult('disconnected', lookup)).toBe('reconcile');
});

test('没有 Message-ID 时按原发送人、时间点和正文生成稳定编号', () => {
  const message = {
    sender: 'Sender@example.invalid',
    sentAt: '2026-11-20T12:00:00+08:00',
    body: '一行\r\n两行',
  };
  const id = incomingEmailSourceId(message);
  expect(id).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(
    incomingEmailSourceId({ ...message, sentAt: '2026-11-20T04:00:00Z', body: '一行\n两行' }),
  ).toBe(id);
  expect(incomingEmailSourceId({ ...message, body: '改过的正文' })).not.toBe(id);
  expect(incomingEmailSourceId({ ...message, messageId: ' <example@example.invalid> ' })).toBe(
    '<example@example.invalid>',
  );
});
