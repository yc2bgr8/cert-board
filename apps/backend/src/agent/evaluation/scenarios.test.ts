import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  KernelToolError,
  runAgentKernel,
  type KernelEvent,
  type KernelMessage,
} from '../pi/index.js';
import { options, reply, scripted, tool, toolCall } from '../pi/scripted-test-fixture.js';

const toolName = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u);
const input = z.record(z.string(), z.json());
const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().min(1).max(120),
    prompt: z.string().min(1).max(500),
    status: z.enum(['waiting_review', 'waiting_question']),
    continuation: z.object({ tool: toolName, input, receipt: z.json() }).strict().optional(),
    turns: z
      .array(
        z
          .object({
            tool: toolName,
            input,
            result: z.discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('data'),
                  data: z.json(),
                  terminal: z.enum(['review', 'question']).optional(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('error'),
                  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/u),
                  message: z.string().min(1).max(500),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

const scenarios = z
  .array(scenarioSchema)
  .min(1)
  .max(20)
  .parse(
    JSON.parse(
      readFileSync(new URL('../../../../../evals/agent/scenarios.json', import.meta.url), 'utf8'),
    ),
  );

test('场景编号唯一，等待状态对应唯一的最后一步', () => {
  expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
  for (const scenario of scenarios) {
    const terminals = scenario.turns.filter(
      ({ result }) => result.kind === 'data' && result.terminal,
    );
    expect(terminals).toEqual([scenario.turns.at(-1)]);
    expect(terminals[0]?.result).toMatchObject({
      terminal: scenario.status.slice('waiting_'.length),
    });
  }
});

test.each(scenarios)('$id $description', async (scenario) => {
  const model = scripted(
    scenario.turns.map(({ tool: name, input }) => reply(toolCall(name, JSON.stringify(input)))),
  );
  const observed: string[] = [];
  const events: KernelEvent[] = [];
  const tools = [...new Set(scenario.turns.map(({ tool }) => tool))].map((name) => ({
    ...tool(name, async (value) => {
      const step = scenario.turns[observed.length];
      expect(step?.tool).toBe(name);
      expect(value).toEqual(step!.input);
      observed.push(name);
      const result = step!.result;
      if (result.kind === 'error')
        throw new KernelToolError(result.code, result.message, { recoverable: true });
      return { data: result.data, ...(result.terminal ? { terminal: result.terminal } : {}) };
    }),
    parameters: { type: 'object', additionalProperties: true },
  }));
  const prompt: KernelMessage = { role: 'user', content: scenario.prompt };
  const history: KernelMessage[] = [];
  if (scenario.continuation) {
    const call = toolCall(scenario.continuation.tool, JSON.stringify(scenario.continuation.input));
    history.push(prompt, reply(call), {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(scenario.continuation.receipt),
    });
  }
  const result = await runAgentKernel({
    ...options(model.complete, tools),
    history,
    messages: history.length ? [] : [prompt],
    ...(history.length
      ? { continuation: { initialUsage: { steps: 1, totalTokens: 110, costNano: '1000' } } }
      : {}),
    onEvent(event) {
      events.push(event);
    },
  });
  expect(result.status).toBe(scenario.status);
  expect(observed).toEqual(scenario.turns.map(({ tool }) => tool));
  expect(model.requests).toHaveLength(scenario.turns.length);
  expect(result.usage.steps).toBe(scenario.turns.length + Number(Boolean(scenario.continuation)));
  expect(events).toContainEqual({
    type: 'waiting',
    reason: scenario.status.slice('waiting_'.length),
  });
  if (scenario.continuation) {
    expect(model.requests[0]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: JSON.stringify(scenario.continuation.receipt),
    });
  }
  for (const [index, turn] of scenario.turns.slice(0, -1).entries()) {
    const precedingReceipt = model.requests[index + 1]?.messages.at(-1);
    expect(precedingReceipt?.role).toBe('tool');
    const data = JSON.parse(precedingReceipt!.content!);
    if (turn.result.kind === 'error')
      expect(data).toMatchObject({ error: { code: turn.result.code } });
    else expect(data).toEqual(turn.result.data);
  }
});
