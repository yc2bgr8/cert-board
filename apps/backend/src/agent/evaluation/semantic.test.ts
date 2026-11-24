import { expect, test } from 'vitest';
import { localGatewayModelSchema, structuredSubmissionSchema } from '@cert-board/shared';
import { options, scripted } from '../pi/scripted-test-fixture.js';
import { chooseLocalReviewModel, evaluateReviewSemantics } from './semantic.js';

const primary = options(scripted([]).complete).model;
const local = (family: string) =>
  localGatewayModelSchema.parse({
    id: 'scripted-local-review',
    transport: 'local',
    upstreamModel: 'fixture',
    baseUrl: 'http://127.0.0.1:28080/v1',
    family,
    enabled: true,
    accepted: false,
    purposes: ['evaluation'],
    maxDataLevel: 'confidential',
    contextLength: 65536,
    maxOutputTokens: 1024,
    supportsImages: false,
    prices: { inputUsdPerMillion: '0', cacheReadUsdPerMillion: '0', outputUsdPerMillion: '0' },
    reasoning: { enabled: false },
  });

const submission = structuredSubmissionSchema.parse({
  skill: { id: 'R09', version: '0.1.0' },
  workspaceVersion: '287cb2ae-e655-4465-8905-ca08345faa8c',
  conclusion: '合成核查。',
  claims: [
    {
      id: 'c1',
      object: '示例',
      field: '写法',
      value: '待核对',
      unit: null,
      sources: [],
      status: 'unverified',
    },
  ],
  decisions: [],
  evidence: [],
  missing: [],
  uncertain: [],
  nextStep: '人工复查。',
});

test('复核从已配置的本地端点选用不同家族，同家族和远端评审不能接入这条提交路径', () => {
  const config = {
    version: 1 as const,
    models: [primary, local('scripted')],
  };
  expect(chooseLocalReviewModel(config, primary)).toEqual({
    model: null,
    reason: 'same_model_family',
  });
  expect(chooseLocalReviewModel({ ...config, models: [primary] }, primary)).toEqual({
    model: null,
    reason: 'model_unavailable',
  });
  expect(
    chooseLocalReviewModel({ ...config, models: [local('other-local')] }, primary).model?.family,
  ).toBe('other-local');
});

test('同一地址和上游标识的配置别名不能互相复核', () => {
  const first = local('one-family');
  const alias = {
    ...local('different-label'),
    id: 'another-local-alias',
    baseUrl: 'http://127.0.0.1:28080/v1/',
  };
  expect(chooseLocalReviewModel({ version: 1, models: [first, alias] }, first)).toEqual({
    model: null,
    reason: 'same_upstream_model',
  });
  expect(
    localGatewayModelSchema.safeParse({ ...alias, baseUrl: 'http://localhost:28080/v1' }).success,
  ).toBe(false);
});

test('语义服务只接受允许的维度，模型失败或坏结构留下固定原因', async () => {
  const judge = local('other-local');
  await expect(
    evaluateReviewSemantics(judge, submission, async (request) => {
      expect(request.model).toBe(judge.id);
      expect(request.tools).toBeUndefined();
      expect(request.messages.at(-1)?.content).toContain('合成核查。');
      return '{"answer_quality":"needs_review","evidence":"failed"}';
    }),
  ).resolves.toEqual({
    status: 'completed',
    dimensions: { answer_quality: 'needs_review', evidence: 'failed' },
  });
  await expect(
    evaluateReviewSemantics(judge, submission, async () => '{"policy":"passed"}'),
  ).resolves.toEqual({ status: 'unavailable', reason: 'invalid_response' });
  await expect(
    evaluateReviewSemantics(judge, submission, async () => {
      throw new Error('仅测试故障');
    }),
  ).resolves.toEqual({ status: 'unavailable', reason: 'provider_failure' });
});
