import { expect, test } from 'vitest';
import { t1DocumentsSchema, t1PageSchema } from './t1-fixture.js';

test('T1逐页输入保持原文与换行，拒绝无效页码和置信度', () => {
  const page = { doc: 'D035', page: 5, method: 'text', text: '  510(K) number K170285\n' };
  expect(t1PageSchema.parse(page).text).toBe(page.text);
  expect(t1PageSchema.safeParse({ ...page, page: 0 }).success).toBe(false);
  expect(t1PageSchema.safeParse({ ...page, ocr_score: 1.1 }).success).toBe(false);
});

test('T1文件名先按NFC统一再验证长度', () => {
  const source = {
    id: 'D001',
    name: 'e\u0301'.repeat(200),
    path: 'example.pdf',
    source_type: 'fixture',
    parent: null,
    sha256: 'a'.repeat(64),
    bytes: 1,
    ext: '.pdf',
    duplicate_of: null,
    pages: 1,
    chars: 1,
    status: '成功',
  };
  expect(t1DocumentsSchema.parse([source])[0]?.name).toBe('é'.repeat(200));
});
