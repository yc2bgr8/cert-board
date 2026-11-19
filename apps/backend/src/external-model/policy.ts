import { randomUUID } from 'node:crypto';
import { AppError } from '../api/errors.js';
import type { ExternalModelMessage } from '../modelgw/external.js';

const overlapSize = 24;
const normalized = (value: string) => value.normalize('NFC').toLowerCase().replace(/\s+/gu, '');

function literal(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectedPattern(words: readonly string[]) {
  return [...new Set(words.map((word) => word.normalize('NFC')))]
    .sort((left, right) => right.length - left.length)
    .map(literal)
    .join('|');
}

export function fitProtectedPrefix(
  value: string,
  words: readonly string[],
  rawLimit: number,
  wireLimit: number,
) {
  const content = value.normalize('NFC');
  const alternatives = protectedPattern(words);
  const matches = alternatives ? content.matchAll(new RegExp(alternatives, 'giu')) : [];
  const tokenLengths = new Map<string, number>();
  let offset = 0;
  let used = 0;
  function plain(until: number) {
    const available = Math.max(0, Math.min(until - offset, rawLimit - offset, wireLimit - used));
    const portion = content.slice(offset, offset + available).replace(/\p{Surrogate}$/u, '');
    offset += portion.length;
    used += portion.length;
    return offset === until;
  }
  for (const match of matches) {
    if (!plain(match.index)) return content.slice(0, offset).trimEnd();
    const term = match[0];
    const tokenSize =
      tokenLengths.get(term) ?? `[[CB-${'0'.repeat(36)}-${tokenLengths.size + 1}]]`.length;
    if (offset + term.length > rawLimit || used + tokenSize > wireLimit)
      return content.slice(0, offset).trimEnd();
    tokenLengths.set(term, tokenSize);
    offset += term.length;
    used += tokenSize;
  }
  plain(content.length);
  return content.slice(0, offset).trimEnd();
}

export function redactExternalMessages(messages: ExternalModelMessage[], words: readonly string[]) {
  const alternatives = protectedPattern(words);
  if (!alternatives) {
    return { messages, replacementCount: 0, restore: (value: string) => value };
  }
  const pattern = new RegExp(alternatives, 'giu');
  const residue = new RegExp(alternatives, 'iu');
  const rawMessages = messages.map(({ role, content }) => ({
    role,
    content: content.normalize('NFC'),
  }));
  const nonce = randomUUID();
  const prefix = `[[CB-${nonce}-`;
  if (rawMessages.some(({ content }) => content.includes(prefix)))
    throw new AppError(409, 'EXTERNAL_REPLACEMENT_COLLISION', '消息含替换代号，请修改文字后重试。');
  const replacements = new Map<string, string>();
  let replacementCount = 0;
  const replaced = rawMessages.map(({ role, content }) => ({
    role,
    content: content.replace(pattern, (term) => {
      replacementCount++;
      const chosen = replacements.get(term) ?? `${prefix}${replacements.size + 1}]]`;
      replacements.set(term, chosen);
      return chosen;
    }),
  }));
  if (replaced.some(({ content }) => residue.test(content)))
    throw new AppError(403, 'EXTERNAL_PROTECTED_TERM', '替换后仍含保密词，请缩小发送范围。');
  const reverse = new Map([...replacements].map(([phrase, token]) => [token, phrase]));
  return {
    messages: replaced,
    replacementCount,
    restore(value: string) {
      const tokens = new RegExp(`${literal(prefix)}[0-9]+\\]\\]`, 'g');
      return value.replace(tokens, (token) => reverse.get(token) ?? token);
    },
  };
}

export function containsConfidentialOverlap(
  outgoing: readonly ExternalModelMessage[],
  confidentialPages: readonly string[],
) {
  if (!confidentialPages.length) return false;
  const spans = new Set<string>();
  for (const message of outgoing) {
    const value = normalized(message.content);
    for (let offset = 0; offset + overlapSize <= value.length; offset++)
      spans.add(value.slice(offset, offset + overlapSize));
  }
  return confidentialPages.some((page) => {
    const value = normalized(page);
    if (value.length > 0 && value.length < overlapSize)
      return outgoing.some((message) => normalized(message.content).includes(value));
    for (let offset = 0; offset + overlapSize <= value.length; offset++)
      if (spans.has(value.slice(offset, offset + overlapSize))) return true;
    return false;
  });
}
