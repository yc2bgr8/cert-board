import { expect, test, vi } from 'vitest';
import { chatRequestSchema } from '@cert-board/shared';
import { readCursorTurn } from '../external-model/cursor-acp.js';
import {
  cursorAcceptanceModels,
  parseCursorModelTurn,
  readCursorAcceptanceConfig,
  sendCursorAcceptance,
} from './cursor-acceptance.js';

vi.mock('../external-model/cursor-acp.js', () => ({ readCursorTurn: vi.fn() }));

const request = chatRequestSchema.parse({
  messages: [{ role: 'user', content: '读合成资料第三页' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'doc_read',
        description: '读取合成资料',
        parameters: {
          type: 'object',
          properties: { page: { type: 'integer' } },
          required: ['page'],
        },
      },
    },
  ],
});

test('Cursor 的结构化动作转给 cert-board 工具循环，并给每次动作新编号', () => {
  const raw = JSON.stringify({
    content: '读合成资料',
    actions: [{ name: 'doc_read', arguments: { page: 3 } }],
  });
  const first = parseCursorModelTurn(raw, request).choices[0]!;
  const second = parseCursorModelTurn(raw, request).choices[0]!;
  expect(first).toMatchObject({
    finish_reason: 'tool_calls',
    message: {
      content: '读合成资料',
      tool_calls: [
        { id: expect.any(String), function: { name: 'doc_read', arguments: '{"page":3}' } },
      ],
    },
  });
  expect(first.message.tool_calls?.[0]?.id).not.toBe(second.message.tool_calls?.[0]?.id);
});

test('未登记工具、只允许文本时的工具调用、工具参数非对象和伪造用量均拒绝', () => {
  const bad = (name: string, args: unknown) =>
    JSON.stringify({ content: null, actions: [{ name, arguments: args }] });
  expect(() => parseCursorModelTurn(bad('execute_shell', {}), request)).toThrow();
  expect(() => parseCursorModelTurn(bad('doc_read', 'raw'), request)).toThrow();
  expect(() =>
    parseCursorModelTurn(bad('doc_read', {}), { ...request, tool_choice: 'none' }),
  ).toThrow();
  expect(() =>
    parseCursorModelTurn(
      JSON.stringify({ content: '完成', actions: [], usage: { cost: 0 } }),
      request,
    ),
  ).toThrow();
  expect(
    parseCursorModelTurn(JSON.stringify({ content: '完成', actions: [] }), request).choices[0]
      ?.finish_reason,
  ).toBe('stop');
});

test('验收路由不处理保密资料，缺专用开关、隐私凭证或开发模式时拒绝', async () => {
  expect(
    cursorAcceptanceModels.every(
      (model) => model.maxDataLevel === 'internal' && model.developmentOnly,
    ),
  ).toBe(true);
  await expect(readCursorAcceptanceConfig('development', {})).resolves.toBeUndefined();
  await expect(
    readCursorAcceptanceConfig('development', { CERT_CURSOR_ACCEPTANCE: '1' }),
  ).resolves.toBeUndefined();
  await expect(
    readCursorAcceptanceConfig('development', { CERT_CURSOR_ACCEPTANCE_WORKER: '1' }),
  ).rejects.toThrow();
  await expect(
    readCursorAcceptanceConfig('production', { CERT_CURSOR_ACCEPTANCE_WORKER: '1' }),
  ).rejects.toThrow();
});

test('按单次上限检查完整 UTF-8 输出，包括工具参数', () => {
  const answer = JSON.stringify({
    content: null,
    actions: [{ name: 'doc_read', arguments: { note: '核查资料' } }],
  });
  const limit = Buffer.byteLength(answer, 'utf8');
  expect(() => parseCursorModelTurn(answer, { ...request, max_tokens: limit })).not.toThrow();
  expect(() => parseCursorModelTurn(answer, { ...request, max_tokens: limit - 1 })).toThrow(
    '输出超过本次请求上限',
  );
});

test('未指定单次上限时，将同一个模型默认值用于提示与接收校验', async () => {
  const model = { ...cursorAcceptanceModels[0]!, maxOutputTokens: 50 };
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  vi.mocked(readCursorTurn).mockResolvedValueOnce(
    JSON.stringify({ content: '必然超出默认上限'.repeat(10), actions: [] }),
  );
  await expect(sendCursorAcceptance(cursor, model, request)).rejects.toThrow(
    '输出超过本次请求上限',
  );
  expect(readCursorTurn).toHaveBeenCalledWith(
    cursor,
    model.cursorModel,
    expect.objectContaining({
      maximumResponseBytes: 50,
      request: expect.objectContaining({ max_tokens: 50 }),
    }),
    expect.any(Function),
    undefined,
  );
});
