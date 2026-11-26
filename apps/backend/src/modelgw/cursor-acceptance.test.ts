import { expect, test, vi } from 'vitest';
import { chatRequestSchema } from '@cert-board/shared';
import { CursorAcpStartupError, readCursorTurn } from '../external-model/cursor-acp.js';
import { VerificationChannelError } from '../external-model/verification-runtime.js';
import {
  cursorAcceptanceModels,
  cursorUsesWalkthroughDatabase,
  CursorReplyFormatError,
  parseCursorModelTurn,
  readCursorAcceptanceConfig,
  sendCursorAcceptance,
} from './cursor-acceptance.js';

vi.mock('../external-model/cursor-acp.js', async (original) => ({
  ...(await original<typeof import('../external-model/cursor-acp.js')>()),
  readCursorTurn: vi.fn(),
}));

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

test('验收账号仅可从专用走查网页和本地走查库启用', () => {
  const origin = 'http://127.0.0.1:28280';
  const database = 'postgresql://cert_board@127.0.0.1:25435/cert_board_walkthrough';
  expect(cursorUsesWalkthroughDatabase({ WEB_ORIGIN: origin, DATABASE_URL: database })).toBe(true);
  expect(cursorUsesWalkthroughDatabase({ WEB_ORIGIN: 'http://127.0.0.1:28380', DATABASE_URL: database })).toBe(false);
  for (const DATABASE_URL of [
    undefined,
    database.replace('25435', '25432'),
    database.replace('cert_board_walkthrough', 'cert_board_lan'),
    database.replace('127.0.0.1', 'localhost'),
    `${database}?host=fixture.invalid`,
  ])
    expect(cursorUsesWalkthroughDatabase({ WEB_ORIGIN: origin, DATABASE_URL })).toBe(false);
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
  const [, , prompt] = vi.mocked(readCursorTurn).mock.lastCall!;
  expect(typeof prompt).toBe('string');
  const [contract, payload] = (prompt as string).split('\n\nRequest JSON:\n');
  const [body, format] = payload!.split('\n\n回执格式');
  expect(contract).toContain('由 cert-board 执行');
  expect(format).toContain('50 UTF-8 字节');
  expect(format).not.toContain('CERT_BOARD_TURN_START');
  expect(format).toContain('字节预算不足以容纳边界');
  expect(JSON.parse(body!)).toMatchObject({ ...request, max_tokens: 50 });
});

test('只重建明确未派发的 ACP 启动握手，普通派发拒绝或发送失败不重试', async () => {
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  const model = cursorAcceptanceModels[0]!;
  const turn = vi.mocked(readCursorTurn);
  turn
    .mockClear()
    .mockRejectedValueOnce(new CursorAcpStartupError())
    .mockResolvedValueOnce(JSON.stringify({ content: '完成', actions: [] }));
  await expect(sendCursorAcceptance(cursor, model, request)).resolves.toMatchObject({
    choices: [{ finish_reason: 'stop' }],
  });
  expect(turn).toHaveBeenCalledTimes(2);
  for (const confirmedNotSent of [true, false]) {
    turn
      .mockClear()
      .mockRejectedValueOnce(new VerificationChannelError('failed', confirmedNotSent));
    await expect(sendCursorAcceptance(cursor, model, request)).rejects.toMatchObject({
      confirmedNotSent,
    });
    expect(turn).toHaveBeenCalledOnce();
  }
});

test('Cursor 付款提示单独中止，结构化回复中引用该提示仍可读取', async () => {
  const model = cursorAcceptanceModels[0]!;
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  const text = 'Add a payment method to continue';
  const turn = vi.mocked(readCursorTurn).mockClear();
  turn.mockResolvedValueOnce(`\n${text}\n`);
  await expect(sendCursorAcceptance(cursor, model, request)).rejects.toThrow(
    'Cursor 要求添加付款方式。',
  );
  expect(turn).toHaveBeenCalledOnce();
  turn.mockResolvedValueOnce(JSON.stringify({ content: text, actions: [] }));
  await expect(sendCursorAcceptance(cursor, model, request)).resolves.toMatchObject({
    choices: [{ finish_reason: 'stop', message: { content: text } }],
  });
});

test.each([false, true])('验收报告失效后拒绝上游发送（派发复核期间发生变化 %s）', async (duringDispatch) => {
  const verifyAcceptanceScope = vi.fn(async () => undefined);
  if (duringDispatch) verifyAcceptanceScope.mockResolvedValueOnce(undefined);
  verifyAcceptanceScope.mockRejectedValueOnce(new Error('CURSOR_ACCEPTANCE_SCOPE_REQUIRED'));
  const cursor = {
    executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture',
    verifyAcceptanceScope,
  };
  const beforeDispatch = vi.fn(async () => undefined);
  const sent = vi.fn();
  vi.mocked(readCursorTurn).mockImplementationOnce(async (_config, _model, _prompt, authorize) => {
    await authorize(new AbortController().signal);
    sent();
    return '{"content":"完成","actions":[]}';
  });
  await expect(sendCursorAcceptance(cursor, cursorAcceptanceModels[0]!, request, undefined, {
    prepare: beforeDispatch,
  }))
    .rejects.toThrow('CURSOR_ACCEPTANCE_SCOPE_REQUIRED');
  expect(verifyAcceptanceScope).toHaveBeenCalledTimes(duringDispatch ? 2 : 1);
  expect(beforeDispatch).toHaveBeenCalledTimes(duringDispatch ? 1 : 0);
  expect(sent).not.toHaveBeenCalled();
});

test.each([
  { reply: ' \n ', failure: 'empty' },
  { reply: '合成未结构化文本', failure: 'unframed_text' },
  { reply: '{"content":', failure: 'invalid_json' },
  { reply: '{"content":"合成未结构化文本"}', failure: 'invalid_envelope' },
  {
    reply: '{"content":"合成未结构化文本","actions":[{"name":"not_offered","arguments":{}}]}',
    failure: 'unavailable_action',
  },
])('坏回复按固定类别拒绝且不保留正文（$failure）', async ({ reply, failure }) => {
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  const turn = vi.mocked(readCursorTurn);
  turn.mockClear().mockResolvedValueOnce(reply);
  const error = await sendCursorAcceptance(cursor, cursorAcceptanceModels[0]!, request).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(CursorReplyFormatError);
  expect(error).toMatchObject({ failure });
  expect(String(error)).not.toContain('合成未结构化文本');
  expect(turn).toHaveBeenCalledOnce();
});

const framed = (id: string, body: string) =>
  `CERT_BOARD_TURN_START ${id}\n${body}\nCERT_BOARD_TURN_END ${id}`;
const action = '{"content":null,"actions":[{"name":"doc_read","arguments":{"page":3}}]}';

test('仅转发当前回合终止帧内的动作，忽略前置进度文字', () => {
  const answer = '正在核对合成资料。\r\n' + framed('this-turn', action).replaceAll('\n', '\r\n');
  const turn = parseCursorModelTurn(answer, request, false, 'this-turn').choices[0]!;
  expect(turn.message).toMatchObject({
    content: null,
    tool_calls: [{ function: { name: 'doc_read', arguments: '{"page":3}' } }],
  });
  expect(() => parseCursorModelTurn(answer, request, true, 'this-turn'))
    .toThrow(CursorReplyFormatError);
  expect(() => parseCursorModelTurn(answer, { ...request, tool_choice: 'none' }, false, 'this-turn'))
    .toThrow(CursorReplyFormatError);
  expect(() => parseCursorModelTurn(answer, { ...request, max_tokens: 50 }, false, 'this-turn'))
    .toThrow('输出超过本次请求上限');
});

test.each([
  framed('previous-turn', action),
  framed('this-turn', action) + '\n' + framed('this-turn', action),
  'CERT_BOARD_TURN_START this-turn\n' + action,
  framed('this-turn', action) + '\n帧后文字',
  framed('this-turn', action) + '\n' + String.fromCharCode(96).repeat(3),
  action + '\n' + framed('this-turn', action),
])('歧义或跨回合的帧整体拒绝', (answer) => {
  try {
    parseCursorModelTurn(answer, request, false, 'this-turn');
    expect.unreachable('已接受误配或歧义帧。');
  } catch (error) {
    expect(error).toMatchObject({ failure: 'invalid_frame' });
  }
});

test('每个 ACP 派发独立生成回合边界，转发上轮回执无效', async () => {
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  const model = cursorAcceptanceModels[0]!;
  const ids: string[] = [];
  const turn = vi.mocked(readCursorTurn);
  const idFromPrompt = (prompt: unknown) => {
    const id = /CERT_BOARD_TURN_START ([a-f0-9-]{36})/u.exec(String(prompt))?.[1];
    if (!id) throw new Error('未生成回合编号。');
    ids.push(id);
    return id;
  };
  turn.mockImplementationOnce(async (_config, _model, prompt) =>
    framed(idFromPrompt(prompt), action),
  );
  await expect(sendCursorAcceptance(cursor, model, request)).resolves.toMatchObject({
    choices: [{ finish_reason: 'tool_calls' }],
  });
  turn.mockImplementationOnce(async (_config, _model, prompt) => {
    idFromPrompt(prompt);
    return framed(ids[0]!, action);
  });
  await expect(sendCursorAcceptance(cursor, model, request)).rejects.toMatchObject({
    failure: 'invalid_frame',
  });
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

test('实际动作装不进帧时，可返回预算内的完整裸 JSON', async () => {
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  const candidate = '{"content":null,"actions":[{"name":"doc_read","arguments":{"page":321654}}]}';
  vi.mocked(readCursorTurn).mockImplementationOnce(async (_config, _model, prompt) => {
    expect(String(prompt)).toContain('CERT_BOARD_TURN_START');
    expect(String(prompt)).toContain('仅在包含边界会超出字节上限时');
    return candidate;
  });
  await expect(sendCursorAcceptance(cursor, cursorAcceptanceModels[0]!, {
    ...request, max_tokens: 180,
  })).resolves.toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] });
});

test('只读网关核实接收自己的文本和判断字段，仍拒绝动作和超长回复', async () => {
  const cursor = { executable: 'fixture', entrypoint: 'fixture', profileDirectory: 'fixture' };
  const model = cursorAcceptanceModels.find(({ purposes }) => purposes.includes('verification'))!;
  const reply = '[合成指南，第 3 页] 来源应含版本和页码，核查结果待确认。';
  const ask = { messages: request.messages, tool_choice: 'none' as const, max_tokens: 120 };
  const turn = vi.mocked(readCursorTurn);
  const structured = JSON.stringify({ text: reply, claims: [] });
  turn.mockClear().mockResolvedValueOnce(structured);
  await expect(sendCursorAcceptance(cursor, model, ask)).resolves.toMatchObject({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: structured } }],
  });
  expect(turn).toHaveBeenCalledOnce();
  expect(turn.mock.lastCall?.[2]).toMatchObject({ maximumResponseBytes: 120, request: ask });
  for (const malformed of [reply, structured.slice(0, -1)]) {
    turn.mockResolvedValueOnce(malformed);
    await expect(sendCursorAcceptance(cursor, model, ask)).rejects.toBeInstanceOf(CursorReplyFormatError);
  }
  turn.mockResolvedValueOnce('{"content":"确定","actions":[{"name":"doc_read","arguments":{}}]}');
  await expect(sendCursorAcceptance(cursor, model, ask)).rejects.toBeInstanceOf(CursorReplyFormatError);
  turn.mockResolvedValueOnce(reply.repeat(10));
  await expect(sendCursorAcceptance(cursor, model, ask)).rejects.toThrow('输出超过本次请求上限');
  turn.mockResolvedValueOnce(reply);
  await expect(sendCursorAcceptance(cursor, model, { ...ask, tools: request.tools })).rejects.toBeInstanceOf(CursorReplyFormatError);
});
