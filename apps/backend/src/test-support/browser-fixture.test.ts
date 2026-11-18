import { expect, test, vi, afterEach } from 'vitest';
import { browserModels, browserScenario } from './browser-fixture.js';
import { startBrowserHarness } from './browser-harness.js';
import type { UpstreamChatRequest } from '../modelgw/service.js';
import { modelGatewayConfigSchema } from '@cert-board/shared';

afterEach(() => vi.unstubAllEnvs());
const id = '10000000-0000-4000-8000-000000000001';
test('浏览器剧本配置遵守真实模型网关边界', () => {
  expect(modelGatewayConfigSchema.safeParse(browserModels).success).toBe(true);
});
test('浏览器夹具在非test环境拒绝建立模型或测试服务器', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  expect(() => browserScenario('read', id)).toThrow('BROWSER_FIXTURE_TEST_ONLY');
  await expect(startBrowserHarness()).rejects.toThrow('BROWSER_HARNESS_TEST_ONLY');
});
test('停止剧本返回已知零用量，由真实网关记账后丢弃迟到输出', async () => {
  const scenario = browserScenario('stop', id);
  const request = {
    messages: [{ role: 'user', content: '只读核查' }],
    tools: [{ type: 'function', function: { name: 'plan_update', parameters: {} } }],
  } as UpstreamChatRequest;
  const model = browserModels.models[0]!;
  await scenario.transport.send(model, request);
  await scenario.transport.send(model, request);
  const controller = new AbortController();
  const pending = scenario.transport.send(
    model,
    {
      ...request,
      messages: [
        {
          role: 'tool',
          tool_call_id: 'fixture',
          content: JSON.stringify({
            items: [
              {
                documentId: id,
                sourceKey: 'DTEST',
                name: '合成资料',
                version: 1,
                page: 1,
                locatorKind: 'physical_page',
                dataLevel: 'internal',
                snippetOffset: 0,
                snippet: '合成原文',
                method: 'text',
                ocrScore: null,
              },
            ],
            hasMore: false,
            nextOffset: null,
          }),
        },
      ],
    },
    controller.signal,
  );
  await scenario.reached;
  controller.abort();
  expect(await pending).toMatchObject({
    usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
  });
  expect(scenario.observed.failed).toBe(false);
});
test('只读目录没有plan_update时直接检索，不调用隐藏工具', async () => {
  const scenario = browserScenario('read', id);
  const request = {
    messages: [{ role: 'user', content: '只读核查' }],
    tools: [{ type: 'function', function: { name: 'doc_search', parameters: {} } }],
  } as UpstreamChatRequest;
  expect(await scenario.transport.send(browserModels.models[0]!, request)).toMatchObject({
    choices: [{ message: { tool_calls: [{ function: { name: 'doc_search' } }] } }],
  });
});
