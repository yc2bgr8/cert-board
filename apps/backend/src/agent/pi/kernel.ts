import { randomUUID } from 'node:crypto';
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { JsonValue } from '@earendil-works/pi-ai';
import { z } from 'zod';
import {
  chatRequestSchema,
  gatewayResponseSchema,
  gatewayModelConfigSchema,
} from '@cert-board/shared';
import {
  assistantMessage,
  fromPiMessage,
  hasCompleteToolHistory,
  parseToolArguments,
  piModel,
  responseUsage,
  toPiMessage,
} from './messages.js';
import {
  KernelToolError,
  type AgentKernelOptions,
  type AgentKernelResult,
  type KernelEvent,
  type KernelMessage,
  type KernelTerminal,
  type KernelUsage,
} from './types.js';

export * from './types.js';
const safeCode = (error: unknown, fallback: string) =>
  error instanceof KernelToolError ? error.code : fallback;
const safeToolMessage = (error: KernelToolError) =>
  error.message.length <= 512 && !error.message.includes('\0')
    ? error.message
    : '工具检查未通过，请核对参数和资料后重试。';

export async function runAgentKernel(options: AgentKernelOptions): Promise<AgentKernelResult> {
  const outputs: KernelMessage[] = [];
  const usageByRequest = new Map<string, { totalTokens: number; costNano: string }>();
  const base = options.continuation?.initialUsage ?? { steps: 0, totalTokens: 0, costNano: '0' };
  const usage = (): KernelUsage => ({
    steps: base.steps + usageByRequest.size,
    totalTokens: [...usageByRequest.values()].reduce(
      (total, entry) => total + entry.totalTokens,
      base.totalTokens,
    ),
    costNano: [...usageByRequest.values()]
      .reduce((total, entry) => total + BigInt(entry.costNano), BigInt(base.costNano))
      .toString(),
  });
  let terminal: KernelTerminal | undefined;
  let fatal: string | undefined;
  let notifiedWaiting = false;
  let lastMeteredStep = 0;
  const stop = new AbortController();
  const abort = () => {
    stop.abort();
    agent.abort();
  };
  const emit = async (event: KernelEvent) => {
    if (!options.onEvent || fatal === 'KERNEL_EVENT_PERSIST_FAILED') return;
    try {
      await options.onEvent(event);
    } catch {
      fatal = 'KERNEL_EVENT_PERSIST_FAILED';
      abort();
    }
  };
  const failResult = (code: string): AgentKernelResult => ({
    status: options.signal.aborted ? 'stopped' : 'failed',
    reasonCode: code,
    messages: outputs,
    usage: usage(),
  });
  const config = gatewayModelConfigSchema.safeParse(options.model);
  const initial = chatRequestSchema.safeParse({
    messages: [
      { role: 'system', content: options.systemPrompt },
      ...options.history,
      ...options.messages,
    ],
  });
  if (
    !config.success ||
    !initial.success ||
    (options.continuation
      ? options.messages.length !== 0 ||
        !['user', 'tool'].includes(options.history.at(-1)?.role ?? '')
      : options.messages.length === 0) ||
    [...options.history, ...options.messages].some((message) => message.role === 'system')
  )
    return failResult('KERNEL_INPUT_INVALID');
  if (options.signal.aborted) return failResult('RUN_ABORTED');
  const history = initial.data.messages.slice(1, options.history.length + 1);
  const prompts = initial.data.messages.slice(options.history.length + 1);
  if (!hasCompleteToolHistory([...history, ...prompts]))
    return failResult('KERNEL_HISTORY_INVALID');
  const model = piModel(config.data);
  const localSignal = (signal?: AbortSignal) =>
    AbortSignal.any([options.signal, stop.signal, ...(signal ? [signal] : [])]);
  const names = new Map<string, string>();
  for (const message of [...history, ...prompts])
    if (message.role === 'assistant')
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  const providedNames = new Set(options.tools.map((tool) => tool.name));
  if (providedNames.size !== options.tools.length || options.tools.length > 64)
    return failResult('KERNEL_TOOL_CATALOG_INVALID');
  const executed = new Map<string, { data: JsonValue; isError: boolean }>();
  const toolFailure = (code: string, message: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }],
    details: { error: { code, message } },
    isError: true,
  });
  const tools: AgentTool[] = options.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as AgentTool['parameters'],
    executionMode: 'sequential',
    replay: 'never',
    async execute(callId, input, signal) {
      const activeSignal = localSignal(signal);
      if (activeSignal.aborted || terminal || fatal)
        return toolFailure('RUN_NOT_EXECUTING', '运行已停止或等待审核，本次后续工具未执行。');
      await emit({ type: 'tool_started', callId, name: tool.name });
      if (activeSignal.aborted || fatal)
        return toolFailure('RUN_NOT_EXECUTING', '运行已停止，本次工具未执行。');
      try {
        const result = await tool.execute(input, { callId, signal: activeSignal });
        const parsed = z.json().safeParse(result.data);
        if (!parsed.success || JSON.stringify(parsed.data).length > 32000)
          throw new KernelToolError(
            'TOOL_OUTPUT_INVALID',
            '工具返回格式或长度无效，运行已停止，请联系维护人员核对。',
            { recoverable: false },
          );
        const data = parsed.data;
        executed.set(callId, { data, isError: false });
        if (result.terminal) terminal = result.terminal;
        else if (tool.name === 'submit_for_review') terminal = 'review';
        else if (tool.name === 'propose_external') terminal = 'proposal';
        return {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          details: data,
          structuredContent: data,
          terminate: Boolean(terminal),
        };
      } catch (error) {
        const recoverable =
          error instanceof KernelToolError && error.recoverable && !activeSignal.aborted;
        const code = activeSignal.aborted
          ? 'RUN_ABORTED'
          : safeCode(error, 'TOOL_EXECUTION_FAILED');
        if (!recoverable) fatal = code;
        const message =
          error instanceof KernelToolError
            ? safeToolMessage(error)
            : '工具执行未完成，运行已停止；请核对运行记录，不要猜测操作结果。';
        const result = toolFailure(code, message);
        executed.set(callId, { data: result.details, isError: true });
        return { ...result, terminate: !recoverable };
      }
    },
  }));
  const streamFn: StreamFn = async (_piModel, context, streamOptions) => {
    const stream = new AssistantMessageEventStream();
    const signal = localSignal(streamOptions?.signal);
    const message = assistantMessage(model);
    try {
      if (signal.aborted || fatal || terminal)
        throw new KernelToolError('RUN_NOT_EXECUTING', '运行已停止，不能继续调用模型。', {
          recoverable: false,
        });
      const requestKey = randomUUID();
      const request = chatRequestSchema.parse({
        model: config.data.id,
        messages: [
          { role: 'system', content: getCurrentSystemPrompt(context.messages) },
          ...context.messages.filter((entry) => entry.role !== 'system').map(fromPiMessage),
        ],
        tools: getCurrentTools(context.messages).map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
        max_tokens: config.data.maxOutputTokens,
        stream: false,
        tool_choice: 'auto',
      });
      await emit({ type: 'model_started', requestKey });
      if (signal.aborted || fatal)
        throw new KernelToolError('RUN_NOT_EXECUTING', '运行已停止，不能继续调用模型。', {
          recoverable: false,
        });
      const response = gatewayResponseSchema.parse(
        await options.complete(request, { requestKey, signal }),
      );
      if (
        response.requestKey !== requestKey ||
        response.model !== config.data.id ||
        response.upstreamModel !== config.data.upstreamModel
      )
        throw new KernelToolError(
          'MODEL_REQUEST_MISMATCH',
          '模型回执与调用身份不匹配，运行已停止。',
          { recoverable: false },
        );
      usageByRequest.set(requestKey, response.usage);
      message.usage = responseUsage(response);
      if (signal.aborted)
        throw new KernelToolError('RUN_ABORTED', '运行已取消。', { recoverable: false });
      const calls = response.message.tool_calls ?? [];
      if (new Set(calls.map((call) => call.id)).size !== calls.length)
        throw new KernelToolError(
          'MODEL_TOOL_CALL_DUPLICATE',
          '模型同一响应重复了工具调用编号，运行已停止。',
          { recoverable: false },
        );
      if (response.finishReason === 'length' || response.finishReason === 'content_filter')
        throw new KernelToolError(
          'MODEL_RESPONSE_INCOMPLETE',
          '模型响应不完整，不能执行其中工具。',
          { recoverable: false },
        );
      message.content = [
        ...(response.message.content === null
          ? []
          : [{ type: 'text' as const, text: response.message.content }]),
        ...calls.map((call) => ({
          type: 'toolCall' as const,
          id: randomUUID(),
          name: call.function.name,
          ...parseToolArguments(call.function.arguments),
        })),
      ];
      message.stopReason = calls.length ? 'toolUse' : 'stop';
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason, message });
    } catch (error) {
      fatal ??= signal.aborted ? 'RUN_ABORTED' : safeCode(error, 'MODEL_CALL_FAILED');
      message.content = [
        {
          type: 'text',
          text: signal.aborted
            ? '运行已停止；已完成操作请以执行记录为准。'
            : '模型调用未完成，运行已停止；请查看模型网关与预算记录。',
        },
      ];
      message.stopReason = signal.aborted ? 'aborted' : 'error';
      message.errorMessage =
        message.content[0]!.type === 'text' ? message.content[0]!.text : '运行已停止。';
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    }
    stream.end(message);
    return stream;
  };
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: options.systemPrompt,
      tools,
      messages: history.map((message) => toPiMessage(message, model, names)),
      thinkingLevel: 'off',
    },
    streamFn,
    getApiKey: () => undefined,
    toolExecution: 'sequential',
    async beforeToolCall(_context, signal) {
      if (localSignal(signal).aborted || terminal || fatal)
        return { block: true, reason: '运行已停止或等待审核，后续工具未执行。', terminate: true };
      return undefined;
    },
    async finishTurn() {
      if (usageByRequest.size > lastMeteredStep) {
        lastMeteredStep = usageByRequest.size;
        try {
          await options.onTurn?.(usage());
        } catch (error) {
          fatal = safeCode(error, 'KERNEL_TURN_CHECK_FAILED');
        }
      }
      if (terminal && !fatal && !notifiedWaiting) {
        notifiedWaiting = true;
        await emit({ type: 'waiting', reason: terminal });
      }
      if (terminal || fatal || options.signal.aborted || stop.signal.aborted)
        return { action: 'end' };
      return undefined;
    },
  });
  agent.subscribe(async (event) => {
    if (event.type === 'tool_execution_end') {
      let actual = executed.get(event.toolCallId);
      if (!actual) {
        const unknown = !providedNames.has(event.toolName);
        const code =
          terminal || fatal || options.signal.aborted
            ? 'RUN_NOT_EXECUTING'
            : unknown
              ? 'TOOL_UNREGISTERED'
              : 'TOOL_INPUT_INVALID';
        if (unknown && !terminal) fatal ??= code;
        const safe = toolFailure(
          code,
          code === 'TOOL_INPUT_INVALID'
            ? '参数未通过工具模式，请按目录中的字段和类型修正后重试。'
            : '工具未执行，请使用当前允许的目录并核对运行状态。',
        );
        actual = { data: safe.details, isError: true };
        event.result.content = safe.content;
        event.result.details = safe.details;
      }
      await emit({
        type: 'tool_completed',
        callId: event.toolCallId,
        name: event.toolName,
        data: actual.data,
        isError: actual.isError,
      });
    }
    if (
      event.type === 'message_end' &&
      (event.message.role === 'assistant' || event.message.role === 'toolResult')
    ) {
      const message = fromPiMessage(event.message);
      outputs.push(message);
      await emit({ type: 'message', message });
    }
  });
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal.aborted) abort();
    if (options.continuation) await agent.continue();
    else await agent.prompt(prompts.map((message) => toPiMessage(message, model, names)));
  } catch {
    fatal ??= 'KERNEL_INTERNAL_ERROR';
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
  if (options.signal.aborted) return failResult('RUN_ABORTED');
  if (fatal) return failResult(fatal);
  return {
    status: terminal ? `waiting_${terminal}` : 'completed',
    messages: outputs,
    usage: usage(),
  };
}
