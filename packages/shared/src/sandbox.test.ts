import { expect, test } from 'vitest';
import { codeRunInputSchema, codeRunReceiptSchema } from './sandbox.js';

test('sandbox aliases share the NFC and UTF-8 length requirements', () => {
  const run = (name: string) =>
    codeRunInputSchema.safeParse({
      code: 'pass',
      inputs: [{ source: 'workspace', path: 'AGENTS.md', name }],
    });
  expect(run('示'.repeat(66) + 'é').success).toBe(true);
  expect(run('示'.repeat(67)).success).toBe(false);
  expect(run('示'.repeat(66) + 'e\u0301').data?.inputs[0]?.name).toBe('示'.repeat(66) + 'é');
  expect(run('CON.txt').success).toBe(false);
  expect(run('隐\u200d藏').success).toBe(false);
});

test('旧沙箱回执能读取必需的授权和审计字段', () => {
  const sha256 = 'a'.repeat(64);
  const receipt = {
    codeSha256: sha256,
    elapsedMs: 3,
    inputHashes: [],
    outputHashes: [sha256],
    documents: [],
    readsWorkspace: true,
  };
  expect(
    codeRunReceiptSchema.parse({
      ...receipt,
      files: [{ path: '样例.txt', byteSize: 1, sha256, workspacePath: '示例/样例.txt' }],
    }),
  ).toEqual(receipt);
});
