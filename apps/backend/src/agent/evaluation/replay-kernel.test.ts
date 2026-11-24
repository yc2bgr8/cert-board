import { expect, test } from 'vitest';
import { options, reply, scripted, toolCall } from '../pi/scripted-test-fixture.js';
import { runRecordedReplay } from './replay-kernel.js';

const past = { documentId: 'f1057db9-bbc0-4cfe-bec7-dd45006dd6d5', version: 1, page: 1 };
const future = { documentId: '0a77fb44-4424-4a72-8583-f4d2423178fa', version: 1, page: 1 };
const input = {
  scope: {
    asOf: '2018-01-01',
    brands: ['示例™'],
    applicants: ['Example Ltd.'],
    kNumbers: ['K253845'],
    licenceNumbers: ['113514'],
  },
  prompt: '回放示例™，品牌方 Example Ltd.，本案编号 K253845。',
  pages: [
    { ...past, availableOn: '2017-12-01', text: 'K253845 为回放对象。可参照历史器械 K170825。' },
    { ...future, availableOn: '2020-01-01', text: '未来结论包含 K253845。' },
  ],
};

test('相同 Pi 内核回放屏蔽网站工具、目标身份与未来页，原文可逐字追溯', async () => {
  const judge = scripted([
    reply(toolCall('doc_search')),
    reply(toolCall('doc_read', JSON.stringify(past))),
    {
      role: 'assistant',
      content: JSON.stringify({ evidence: [{ ...past, quote: '可参照历史器械 K170825。' }] }),
    },
  ]);
  const proof = await runRecordedReplay(input, new Map(), options(judge.complete));
  expect(proof).toMatchObject({ valid: true, findings: [] });
  expect(judge.requests[0]?.tools?.map(({ function: fn }) => fn.name)).toEqual([
    'doc_search',
    'doc_read',
    'official_lookup',
  ]);
  expect(JSON.stringify(judge.requests.map(({ messages }) => messages))).not.toMatch(
    /示例™|Example Ltd\.|K253845|未来结论/u,
  );
});

test('同一内核报告未来来源或目标编号时作废', async () => {
  const judge = scripted([
    reply(toolCall('doc_read', JSON.stringify(future))),
    {
      role: 'assistant',
      content: JSON.stringify({ evidence: [{ ...future, quote: '未来结论包含 K253845。' }] }),
    },
  ]);
  await expect(runRecordedReplay(input, new Map(), options(judge.complete))).resolves.toMatchObject(
    {
      valid: false,
      findings: [
        'future_evidence',
        'target_identifier_in_evidence',
        'unread_evidence',
        'target_identity_in_response',
      ],
    },
  );
  expect(judge.requests[1]?.messages.at(-1)).toMatchObject({
    role: 'tool',
    content: '{"status":"unavailable"}',
  });
});

test('完整回放回复含目标身份时作废，没证据的明确弃答可保留', async () => {
  const answer = (conclusion: string) =>
    scripted([{ role: 'assistant', content: JSON.stringify({ conclusion, evidence: [] }) }]);
  await expect(
    runRecordedReplay(input, new Map(), options(answer('目标编号：Ｋ２５\n３８４５').complete)),
  ).resolves.toMatchObject({
    valid: false,
    findings: ['target_identity_in_response'],
  });
  await expect(
    runRecordedReplay(input, new Map(), options(answer('目前没有足够资料作判断。').complete)),
  ).resolves.toMatchObject({ valid: true, findings: [] });
});

test('遮挡标记不能作为原始资料的逐字引语', async () => {
  const judge = scripted([
    reply(toolCall('doc_read', JSON.stringify(past))),
    {
      role: 'assistant',
      content: JSON.stringify({ evidence: [{ ...past, quote: '[已遮挡] 为回放对象。' }] }),
    },
  ]);
  await expect(runRecordedReplay(input, new Map(), options(judge.complete))).resolves.toMatchObject(
    { valid: false, findings: ['quote_mismatch'] },
  );
});

test('身份之外的组合字符可以从原页逐字引用', async () => {
  const quote = '原文 Cafe\u0301。';
  const judge = scripted([
    reply(toolCall('doc_read', JSON.stringify(past))),
    { role: 'assistant', content: JSON.stringify({ evidence: [{ ...past, quote }] }) },
  ]);
  const scenario = {
    ...input,
    pages: [{ ...past, availableOn: '2017-12-01', text: `目标 K253845。${quote}` }],
  };
  await expect(
    runRecordedReplay(scenario, new Map(), options(judge.complete)),
  ).resolves.toMatchObject({ valid: true, findings: [] });
});

test('完整回放回复中的数字型许可号和全角申请人同样作废', async () => {
  for (const extra of [
    { licenceNumber: 113514 },
    { licenseId: 113514 },
    { license_ids: [113514] },
    { applicant: 'Ｅｘａｍｐｌｅ Ｌｔｄ．' },
  ]) {
    const judge = scripted([
      { role: 'assistant', content: JSON.stringify({ evidence: [], ...extra }) },
    ]);
    await expect(
      runRecordedReplay(input, new Map(), options(judge.complete)),
    ).resolves.toMatchObject({
      valid: false,
      findings: ['target_identity_in_response'],
    });
  }
});

test('普通年份不作身份处理，具有编号语义的数字字段仍然检查', async () => {
  const scenario = { ...input, scope: { ...input.scope, kNumbers: ['K002024'] } };
  const replyWith = (data: object) =>
    scripted([{ role: 'assistant', content: JSON.stringify({ evidence: [], ...data }) }]);
  await expect(
    runRecordedReplay(
      scenario,
      new Map(),
      options(replyWith({ publicationYear: 2024, documentCount: 113514 }).complete),
    ),
  ).resolves.toMatchObject({ valid: true, findings: [] });
  await expect(
    runRecordedReplay(scenario, new Map(), options(replyWith({ k_number: 2024 }).complete)),
  ).resolves.toMatchObject({ valid: false, findings: ['target_identity_in_response'] });
});
