import { randomUUID } from 'node:crypto';
import { AppError } from '../api/errors.js';
import type { ExternalModelMessage } from '../modelgw/external.js';

const overlapSize = 24;
const normalized = (value: string) => value.normalize('NFC').toLowerCase().replace(/\s+/gu, '');

function literal(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactExternalMessages(messages: ExternalModelMessage[], words: readonly string[]) {
  const normalizedWords = [...new Set(words.map((word) => word.normalize('NFC')))];
  if (!normalizedWords.length) {
    return { messages, replacementCount: 0, restore: (value: string) => value };
  }
  const alternatives = normalizedWords
    .sort((left, right) => right.length - left.length)
    .map(literal)
    .join('|');
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
    for (let offset = 0; offset + overlapSize <= value.length; offset++)
      if (spans.has(value.slice(offset, offset + overlapSize))) return true;
    return false;
  });
}
