import { expect, test } from 'vitest';
import { decodeUtf8Text, sliceUnicodeText } from './text.js';

test('UTF8读取保持BOM与原文，拒绝二进制静默替换', () => {
  const text = '\ufeff原文\r\n😀';
  expect(decodeUtf8Text(Buffer.from(text))).toBe(text);
  expect(() => decodeUtf8Text(Buffer.from([0xff, 0xfe]))).toThrow('不是有效UTF-8');
});
test('完整Unicode分页可重组，非法边界与过小上限拒绝', () => {
  const original = '甲😀𠀀乙';
  let offset = 0;
  let restored = '';
  do {
    const part = sliceUnicodeText(original, { offset, limit: 2 });
    restored += part.text;
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (offset < original.length);
  expect(restored).toBe(original);
  expect(() => sliceUnicodeText(original, { offset: 2, limit: 2 })).toThrow('完整字符边界');
  expect(() => sliceUnicodeText(original, { offset: 1, limit: 1 })).toThrow('至少设置为2');
});
