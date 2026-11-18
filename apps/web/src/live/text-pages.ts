import { ApiError } from './api.js';

type TextPage = {
  text: string;
  offset: number;
  totalCharacters: number;
  truncated: boolean;
  nextOffset: number | null;
};
export function joinTextPages(pages: readonly TextPage[]) {
  let text = '';
  const total = pages[0]?.totalCharacters ?? 0;
  for (const [index, page] of pages.entries()) {
    if (
      page.offset !== text.length ||
      page.totalCharacters !== total ||
      (index > 0 && pages[index - 1]?.nextOffset !== page.offset)
    )
      throw new ApiError(
        502,
        'TEXT_PAGE_MISMATCH',
        '原文续读位置不一致，请重新加载；未拼接缺口或重复内容。',
      );
    text += page.text;
    if (text.length > 2000000)
      throw new ApiError(413, 'TEXT_VIEW_LIMIT', '文本超过当前页面展示上限，请分段核对。');
    if (
      (page.truncated && page.nextOffset !== text.length) ||
      (!page.truncated && (page.nextOffset !== null || text.length !== total))
    )
      throw new ApiError(502, 'TEXT_PAGE_MISMATCH', '原文分页不完整，请重新加载后继续读取。');
  }
  return {
    text,
    complete: pages.length > 0 && pages.at(-1)?.truncated === false,
    totalCharacters: total,
  };
}
export function exactQuoteParts(text: string, quote: string | undefined) {
  if (!quote) return null;
  const start = text.indexOf(quote);
  return start < 0
    ? null
    : {
        before: text.slice(0, start),
        match: text.slice(start, start + quote.length),
        after: text.slice(start + quote.length),
      };
}
