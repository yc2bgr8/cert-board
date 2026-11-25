import { expect, test } from 'vitest';
import { z } from 'zod';
import { readT1Fixture } from '../../documents/t1-seed.js';
import { runAgentKernel } from '../pi/index.js';
import { options, reply, scripted, tool, toolCall } from '../pi/scripted-test-fixture.js';
import { e07AddressSchema, e07SourceText, gradeL08E07, prepareL08E07, type E07Finding } from './l08-e07.js';

const corpus = await prepareL08E07();
const catalogue = ['L08-BP', 'L08-PT', 'L08-BT', 'L08-TP', 'L08-TB', 'L08-PB'];

function findings(): E07Finding[] {
  const address = { documentKey: 'D021', location: 1 };
  const text = e07SourceText(corpus, address)!;
  const starts = catalogue.map((name) => text.indexOf(name));
  const ends = catalogue.map((name, index) => starts[index]! + name.length);
  const quote = text.slice(Math.min(...starts), Math.max(...ends));
  return [
    { kind: 'missing_cleaning_report', evidence: [
      { documentKey: 'D014', location: 'xfa_datasets', quote: 'Reprocessing Validation Test.pdf' },
    ] },
    { kind: 'unknown_model', evidence: [
      { documentKey: 'D015', location: 2, quote: 'L08-ZZ' },
      { ...address, quote },
    ] },
    { kind: 'shelf_life_conflict', evidence: [
      { documentKey: 'D027', location: 3, quote: 'Shelf life: 3 years' },
      { documentKey: 'D044', location: 3, quote: 'Shelf life: 2 years' },
    ] },
  ];
}

test('E07 仅修改隔离副本，移除报告及重复件并保留 eSTAR 引用', async () => {
  const original = await readT1Fixture();
  expect(corpus.sourceSnapshot).toBe(original.snapshot);
  const remaining = new Set(corpus.documents.map(({ documentKey }) => documentKey));
  expect(original.documents.filter(({ id }) => !remaining.has(id)).map(({ id }) => id).sort()).toEqual(['D023', 'D050']);
  expect(corpus.documents.some(({ name }) => name === 'Reprocessing Validation Test.pdf')).toBe(false);
  expect(corpus.pages.some(({ documentKey }) => ['D023', 'D050'].includes(documentKey))).toBe(false);
  expect(corpus.attachmentReference.includes('Reprocessing Validation Test.pdf')).toBe(true);
  const changed = corpus.pages.filter(({ documentKey, location, text }) =>
    original.pages.find(({ doc, page }) => doc === documentKey && page === location)?.text !== text,
  ).map(({ documentKey, location }) => `${documentKey}#${location}`).sort();
  expect(changed).toEqual(['D015#2', 'D027#3']);
});

test('E07 Pi 剧本读到植入位置和原对照后，评测核对三个发现及原文', async () => {
  const result = findings();
  const locations = result.flatMap(({ evidence: refs }) => refs.map(({ documentKey, location }) => ({ documentKey, location })));
  const model = scripted([
    reply(...locations.map((address) => toolCall('doc_read', JSON.stringify(address)))),
    { role: 'assistant', content: JSON.stringify({ findings: result }) },
  ]);
  const observed: string[] = [];
  const reader = {
    ...tool('doc_read', async (value) => {
      const address = e07AddressSchema.parse(value);
      const text = e07SourceText(corpus, address);
      expect(text).toBeDefined();
      observed.push(`${address.documentKey}#${address.location}`);
      return { data: { ...address, text: text! } };
    }),
    parameters: z.toJSONSchema(e07AddressSchema, { io: 'input' }),
  };
  const run = await runAgentKernel({
    ...options(model.complete, [reader]),
    messages: [{ role: 'user', content: '核对录制资料中的附件、型号和储存期限，列出发现并附原文位置。' }],
  });
  expect(run.status).toBe('completed');
  expect(observed).toEqual(['D014#xfa_datasets', 'D015#2', 'D021#1', 'D027#3', 'D044#3']);
  const submitted = run.messages.findLast((message) => message.role === 'assistant' && message.content)?.content;
  expect(gradeL08E07(corpus, JSON.parse(submitted!))).toEqual({
    status: 'scored', passed: true, matched: 3, missed: [],
  });
});

test('E07 漏项、无对照及引用缺失都不能达标', () => {
  expect(gradeL08E07(corpus, { findings: findings().slice(0, 2) })).toMatchObject({
    passed: false, matched: 2, missed: ['shelf_life_conflict'],
  });
  const oneSide = findings();
  oneSide[1]!.evidence.pop();
  expect(gradeL08E07(corpus, { findings: oneSide })).toMatchObject({
    passed: false, matched: 2, missed: ['unknown_model'],
  });
  const restored = { ...corpus, documents: [...corpus.documents, {
    documentKey: 'D023', name: 'Reprocessing Validation Test.pdf', attachmentOf: 'D014',
  }] };
  expect(gradeL08E07(restored, { findings: findings() })).toMatchObject({
    passed: false, matched: 2, missed: ['missing_cleaning_report'],
  });
  const invalid = findings();
  invalid[0]!.evidence[0] = { documentKey: 'D023', location: 1, quote: 'Reprocessing Validation Test.pdf' };
  expect(gradeL08E07(corpus, { findings: invalid })).toEqual({ status: 'invalid_evidence' });
  const wrongQuote = findings();
  wrongQuote[2]!.evidence[0]!.quote = 'Shelf life: 9 years';
  expect(gradeL08E07(corpus, { findings: wrongQuote })).toEqual({ status: 'invalid_evidence' });
});
