import { readFile, realpath } from 'node:fs/promises';
import { Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('锁定Pi 1.3及无遥测pg-boss版本，原遥测包只能解析到本地空运行兼容包', async () => {
  const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const manifest = JSON.parse(await readFile(resolve(backend, 'package.json'), 'utf8'));
  expect(manifest.dependencies).toMatchObject({
    '@earendil-works/pi-agent-core': '1.3.0',
    '@earendil-works/pi-ai': '1.3.0',
    typebox: '1.3.27',
    'pg-boss': '12.35.1',
  });
  const aiPath = await realpath(resolve(backend, 'node_modules/@earendil-works/pi-ai'));
  const telemetryPath = await realpath(resolve(aiPath, '../pi-telemetry/index.js'));
  expect(telemetryPath.replaceAll('\\', '/')).toMatch(/packages\/pi-telemetry-compat\/index\.js$/);
  expect((await readFile(telemetryPath, 'utf8')).replace(/\/\/[^\n]*/g, '').trim()).toBe(
    'export {};',
  );
  const lock = parse(await readFile(resolve(backend, '../../pnpm-lock.yaml'), 'utf8')) as {
    packages: Record<string, unknown>;
    snapshots: Record<string, unknown>;
  };
  for (const name of [...Object.keys(lock.packages), ...Object.keys(lock.snapshots)]) {
    expect(name).not.toMatch(/@earendil-works\/pi-telemetry@|@opentelemetry\/|@sentry\/|posthog/i);
  }
});

it('导入Pi及一次自定义流运行不联网、不写日志、不创建遥测上下文', async () => {
  const network = vi.fn(() => {
    throw new Error('测试不允许网络');
  });
  vi.stubGlobal('fetch', network);
  const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
    throw new Error('测试不允许套接字');
  });
  const logs = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai/utils/event-stream');
  const optionsSeen: unknown[] = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: '本地合成测试',
      tools: [],
      model: {
        id: 'fixture',
        name: 'fixture',
        api: 'openai-completions',
        provider: 'fixture',
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 128,
      },
    },
    toolExecution: 'sequential',
    streamFn(model, _context, options) {
      optionsSeen.push(options);
      const stream = new AssistantMessageEventStream();
      const message = {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: '合成完成' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop' as const,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end(message);
      return stream;
    },
  });
  await agent.prompt('测试');
  await agent.waitForIdle();
  expect(optionsSeen).toHaveLength(1);
  expect(optionsSeen[0]).not.toHaveProperty('telemetryContext');
  expect(network).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
