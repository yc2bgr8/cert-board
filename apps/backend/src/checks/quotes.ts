export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function quoteAppears(pageText: string, quote: string): boolean {
  const normalizedQuote = normalizeWhitespace(quote);
  return normalizedQuote.length > 0 && normalizeWhitespace(pageText).includes(normalizedQuote);
}
