import type { ExternalModelRequest, ExternalModelRuntime } from '../modelgw/external.js';

export function externalModelFixture(monthlyLimitNano?: bigint) {
  if (process.env.NODE_ENV !== 'test') throw new Error('EXTERNAL_MODEL_FIXTURE_TEST_ONLY');
  const requests: ExternalModelRequest[] = [];
  const runtime: ExternalModelRuntime = {
    kind: 'fixture',
    profiles: [
      {
        id: 'external-fixture',
        label: '外部模型剧本',
        upstreamModel: 'fixture/external',
        providers: ['fixture-provider'],
        prices: {
          inputUsdPerMillion: '0.15',
          cacheReadUsdPerMillion: '0.016',
          outputUsdPerMillion: '0.47',
        },
        maxOutputTokens: 256,
        searchReserveNano: 20_000_000n,
      },
    ],
    ...(monthlyLimitNano === undefined ? {} : { monthlyLimitNano }),
    async checkLocally(messages) {
      return !messages.some((message) => message.content.includes('本地检查拒绝样例'));
    },
    async send(request) {
      requests.push(request);
      const question = request.messages.at(-1)!.content;
      if (question.includes('费用不明样例')) return { content: '缺少用量。' };
      return {
        content: `剧本模型收到材料，以下内容需与项目资料核对。\n\n${question}\n`,
        citations:
          'tools' in request
            ? [{ title: '浏览器验收来源', url: 'https://example.invalid/external-source' }]
            : [],
        costNano: 'tools' in request ? '20000000' : '1000',
        fixture: 'external_model',
      };
    },
  };
  return { runtime, requests };
}
