import { documentPageReadOptionsSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export function decodeUtf8Text(content: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new AppError(
      415,
      'WORKSPACE_BINARY_FILE',
      '该文件不是有效UTF-8文本，请用对应文档工具读取。',
    );
  }
}
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
export function sliceUnicodeText(text: string, options: unknown = {}) {
  const parsed = documentPageReadOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new AppError(
      400,
      'WORKSPACE_READ_OPTIONS',
      '读取位置或上限无效；每次最多12000，请使用nextOffset续读。',
    );
  const { offset, limit } = parsed.data;
  if (
    offset > text.length ||
    (offset > 0 && low(text.charCodeAt(offset)) && high(text.charCodeAt(offset - 1)))
  )
    throw new AppError(
      400,
      'WORKSPACE_READ_OFFSET',
      '读取位置不在完整字符边界，请使用上次返回的nextOffset。',
    );
  let end = Math.min(offset + limit, text.length);
  if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end--;
  if (end === offset && offset < text.length)
    throw new AppError(400, 'WORKSPACE_READ_LIMIT', '读取上限不足以容纳完整字符，请至少设置为2。');
  return {
    text: text.slice(offset, end),
    offset,
    totalCharacters: text.length,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  };
}
