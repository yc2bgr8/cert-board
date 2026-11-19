import { randomUUID } from 'node:crypto';
import {
  approvalResolutionSchema,
  internalMessageQueuedSchema,
  documentPageReadSchema,
  documentSearchResultSchema,
  type ModelGatewayConfig,
} from '@cert-board/shared';
import type { GatewayTransport } from '../modelgw/service.js';
import {
  browserVerificationUncertainty,
  createBrowserReviewScript,
} from './browser-review-fixture.js';

export type BrowserScenario =
  | 'read'
  | 'steering'
  | 'stop'
  | 'mode'
  | 'approval'
  | 'review'
  | 'revision'
  | 'approval_text'
  | 'proposal'
  | 'external_quote'
  | 'consult_verification'
  | 'consult_verification_unavailable';
export const browserModels: ModelGatewayConfig = {
  version: 1,
  models: [
    {
      id: 'browser-fixture',
      upstreamModel: 'fixture/browser',
      baseUrl: 'https://fixture.invalid/api/v1',
      apiKeyEnv: 'FIXTURE_UNUSED_KEY',
      family: 'fixture',
      enabled: true,
      accepted: false,
      purposes: ['agent'],
      maxDataLevel: 'internal',
      contextLength: 1000000,
      maxOutputTokens: 4096,
      supportsImages: false,
      prices: { inputUsdPerMillion: '0', cacheReadUsdPerMillion: '0', outputUsdPerMillion: '0' },
      provider: { only: ['fixture'], allow_fallbacks: false, require_parameters: true },
      reasoning: { enabled: false },
    },
  ],
};
const response = (message: unknown, finishReason = 'stop') => ({
  id: randomUUID(),
  object: 'chat.completion',
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0 },
});
const call = (name: string, input: unknown) =>
  response(
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    'tool_calls',
  );

export function browserScenario(kind: BrowserScenario, contactId: string) {
  if (process.env.NODE_ENV !== 'test') throw new Error('BROWSER_FIXTURE_TEST_ONLY');
  let phase = 0;
  const reviewScript =
    kind === 'review' || kind === 'revision' || kind === 'consult_verification_unavailable'
      ? createBrowserReviewScript(
          kind !== 'review',
          kind === 'consult_verification_unavailable' ? browserVerificationUncertainty : undefined,
        )
      : undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const observed = {
    calls: 0,
    toolNames: [] as string[][],
    latestUser: '',
    reviewVerificationReceived: false,
    readPage: 0,
    failed: false,
  };
  async function wait(signal?: AbortSignal) {
    entered();
    if (signal?.aborted) return;
    let abort!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve;
      signal?.addEventListener('abort', abort, { once: true });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gate,
        cancelled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('BROWSER_GATE_TIMEOUT')), 45000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  const transport: GatewayTransport = {
    kind: 'fixture',
    async send(_model, request, signal) {
      try {
        observed.calls++;
        observed.toolNames.push((request.tools ?? []).map((tool) => tool.function.name));
        observed.latestUser =
          request.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
        const latest = request.messages.at(-1);
        const previous: unknown = latest?.role === 'tool' ? JSON.parse(latest.content) : null;
        if (kind === 'approval_text') {
          observed.reviewVerificationReceived = request.messages.some(
            (message) =>
              message.role === 'user' &&
              message.content.startsWith('审核发起的外部核实资料（系统附加）') &&
              message.content.includes('合成核实资料'),
          );
          return response({
            role: 'assistant',
            content: '对话文字不能代替审批，请在审核卡上点击通过或退回修改。',
          });
        }
        if (kind === 'external_quote')
          return response({ role: 'assistant', content: '已收到外部资料，待用项目资料核对。' });
        if (kind === 'consult_verification') {
          if (observed.calls === 1)
            return call('consult_external_model', { question: '核实合成清单中的版本编号要求。' });
          if (!JSON.stringify(previous).includes('人工补充：检查页码与版本。'))
            throw new Error('BROWSER_VERIFICATION_HUMAN_INPUT_MISSING');
          return response({
            role: 'assistant',
            content: '收到核实结论及人工补充，继续核查页码与版本。',
          });
        }
        if (kind === 'consult_verification_unavailable') {
          if (observed.calls === 1)
            return call('consult_external_model', { question: '核实合成的对比器械编号。' });
          if (observed.calls === 2 && !JSON.stringify(previous).includes('不确定事项'))
            throw new Error('BROWSER_VERIFICATION_UNCERTAINTY_MISSING');
        }
        if (reviewScript) {
          const action = reviewScript(previous);
          return call(action.name, action.input);
        }
        if (kind === 'proposal')
          return call('propose_external', {
            contactId,
            subject: '核对年度注册联络人协议（本地测试）',
            body: '联络人 A：\n\n请核对年度注册协议续期所需材料。\n\n这是一条虚构测试提案。',
          });
        if (kind === 'approval') {
          if (phase++ === 0)
            return call('queue_internal_message', {
              contactId,
              subject: '本地核查提醒',
              body: '请核对资料原件。本消息仅进入本地测试队列。',
            });
          if (approvalResolutionSchema.safeParse(previous).success)
            return response({
              role: 'assistant',
              content: '发起人已拒绝，本次没有登记内部测试消息。',
            });
          internalMessageQueuedSchema.parse(previous);
          return response({
            role: 'assistant',
            content: '内部测试消息已排队，未发送到任何外部对象。',
          });
        }
        switch (phase++) {
          case 0:
            if (!(request.tools ?? []).some((tool) => tool.function.name === 'plan_update')) {
              phase = 2;
              return call('doc_search', { query: '510(k) number', limit: 3 });
            }
            return call('plan_update', {
              steps: [
                { title: '检索项目资料', status: 'running' },
                { title: '阅读原文并说明限制', status: 'pending' },
              ],
              progress: '先定位资料，再逐条核对原文。',
            });
          case 1:
            return call('doc_search', { query: '510(k) number', limit: 3 });
          case 2: {
            const hit = documentSearchResultSchema.parse(previous).items[0];
            if (!hit) throw new Error('BROWSER_FIXTURE_SOURCE_MISSING');
            if (kind !== 'read') await wait(signal);
            if (signal?.aborted)
              return response({ role: 'assistant', content: '此迟到结果不应显示。' });
            return call('doc_read', {
              id: hit.documentId,
              version: hit.version,
              page: hit.page,
              offset: hit.snippetOffset,
            });
          }
          case 3: {
            // 插话可能位于工具回执之后，从真实对话历史寻找最近的正文回执。
            const read = request.messages
              .filter((message) => message.role === 'tool')
              .map((message) => {
                try {
                  return documentPageReadSchema.safeParse(JSON.parse(message.content));
                } catch {
                  return null;
                }
              })
              .reverse()
              .find((value) => value?.success);
            if (!read?.success) throw new Error('BROWSER_FIXTURE_READ_MISSING');
            observed.readPage = read.data.page;
            const steering = kind === 'steering' ? `\n\n已收到插话：${observed.latestUser}` : '';
            return response({
              role: 'assistant',
              content: [
                `已读取资料原文，正确编号仍待确认。${steering}`,
                '## 核查进度',
                '| 来源 | 状态 |\n| --- | --- |\n| 510(k) 摘要 | 已阅读 |',
                '```javascript\nconst status = "待核对";\n```',
                '<div data-markdown-sample="html">HTML 样例内容</div>',
                '<style data-probe="stylesheet">:root { --fixture-global-style: applied; }</style>',
                '<link rel="stylesheet" href="https://external.invalid/blocked.css" />',
                '<script>globalThis.__certInjected=true</script>',
                '<script async src="/assets/markdown-fixture.js"></script>',
                '![外部图片](https://external.invalid/fixture-image.svg)',
                '[外部参考](https://example.invalid/reference)',
              ].join('\n\n'),
            });
          }
          default:
            throw new Error('BROWSER_FIXTURE_UNEXPECTED_TURN');
        }
      } catch {
        observed.failed = true;
        throw new Error('BROWSER_FIXTURE_FAILED');
      }
    },
  };
  return { kind, transport, observed, reached, release };
}
export type BrowserFixtureControl = ReturnType<typeof browserScenario>;
