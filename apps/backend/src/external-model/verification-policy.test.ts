import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { VerificationClaim, VerificationMessage, VerificationModel } from '@cert-board/shared';
import { arrangeVerificationConclusion, eligibleParticipants } from './verification-policy.js';

const model = (id: string, family: string): VerificationModel => ({
  id,
  family,
  label: id,
  channel: 'cursor',
});
const gpt = model('gpt', 'openai');
const gpt2 = model('gpt-second', 'openai');
const claude = model('claude', 'anthropic');
const from = (entry: VerificationModel) => ({
  id: randomUUID(),
  type: 'model' as const,
  author: entry.label,
  model: entry.id,
  round: 1,
  channel: entry.channel,
  text: '合成答复',
  mention: null,
  archiveId: null,
  redactions: 0,
  sources: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});
const reference = { title: '合成出处', url: 'https://example.invalid/source', excerpt: '示例 2.1' };
const claim = (issue: string, sources = [reference]): VerificationClaim => ({
  issue,
  statement: issue,
  stance: 'supports',
  sources,
});

test('按厂商拆分有出处的共识，人工信息和无出处事实单列', () => {
  const human: VerificationMessage = {
    ...from(gpt),
    id: randomUUID(),
    channel: null,
    type: 'human',
    model: null,
    author: '张三',
    text: '我们此前向团队提供了样品。',
    round: null,
  };
  const gptPost = from(gpt);
  const claudePost = from(claude);
  const conclusion = arrangeVerificationConclusion(
    [
      {
        message: gptPost,
        claims: [claim('版本号一致'), claim('仅同厂商意见'), claim('K000001', [])],
        participant: gpt,
      },
      { message: from(gpt2), claims: [claim('仅同厂商意见')], participant: gpt2 },
      {
        message: claudePost,
        claims: [claim('版本号一致'), claim('K000001', [])],
        participant: claude,
      },
      { message: human, claims: [], participant: null },
    ],
    '采用有出处的版本号。',
    {},
  );
  expect(conclusion.items.map((item) => item.category)).toEqual([
    'trusted',
    'disputed',
    'unverified',
    'human',
  ]);
  expect(conclusion.items[0]?.evidence.map((entry) => entry.messageId)).toEqual([
    gptPost.id,
    claudePost.id,
  ]);
  expect(conclusion.items[3]?.evidence[0]?.author).toBe('张三');
});

test('同一议题不同立场时即使两家有出处，也保留分歧与主持人的取舍', () => {
  const conclusion = arrangeVerificationConclusion(
    [
      { message: from(gpt), claims: [claim('需要补表')], participant: gpt },
      {
        message: from(claude),
        claims: [{ ...claim('需要补表'), stance: 'disputes' }],
        participant: claude,
      },
    ],
    '保留两种意见。',
    { 需要补表: '先回查提交要求。' },
  );
  expect(conclusion.items[0]).toMatchObject({
    category: 'disputed',
    selection: '先回查提交要求。',
  });
});

test('无人发言时按每个参与模型分别限轮，发言以后解除这一限制', () => {
  const counts = { gpt: 7, claude: 3 };
  expect(eligibleParticipants([gpt, claude], counts, 7, false)).toEqual([claude]);
  expect(eligibleParticipants([gpt, claude], counts, 3, false)).toEqual([]);
  expect(eligibleParticipants([gpt, claude], counts, 3, true)).toEqual([gpt, claude]);
});

test('两家都表达支持但给出不同事实时不归为可信', () => {
  const first = { ...claim('附件份数'), statement: '需要一份。' };
  const second = { ...claim('附件份数'), statement: '需要两份。' };
  const conclusion = arrangeVerificationConclusion(
    [
      { message: from(gpt), claims: [first], participant: gpt },
      { message: from(claude), claims: [second], participant: claude },
    ],
    '需要复核具体份数。',
    {},
  );
  expect(conclusion.items[0]?.category).toBe('disputed');
});
