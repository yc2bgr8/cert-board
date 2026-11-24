import { createHash } from 'node:crypto';
import { isAlias, isNode, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { coverLetterFieldsSchema, type DocumentCitation } from '@cert-board/shared';
import { readFile } from 'node:fs/promises';
import { AppError } from '../api/errors.js';

const key = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u);
const singleLine = (value: string) => !value.includes('\0') && !/[\r\n]/u.test(value);
const authority = z.strictObject({
  id: key,
  url: z.url({ protocol: /^https$/u }),
  section: z.string().trim().min(1).max(160),
  checkedOn: z.iso.date(),
});
const paragraph = z.strictObject({
  id: key,
  text: z.string().min(1).max(2_000).refine(singleLine),
  sources: key.array().min(1).max(5),
});
const manifestSchema = z.strictObject({
  code: key,
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/u),
  publication: z.literal('draft'),
  title: z.string().min(1).max(140).refine(singleLine),
  fields: z.record(
    key,
    z.array(z.string().trim().min(1).max(100).refine(singleLine)).min(1).max(6),
  ),
  sources: authority.array().min(1).max(12),
  paragraphs: paragraph.array().min(1).max(24),
});
type Reference = DocumentCitation;
type ReadPage = (ref: Reference) => Promise<string | null>;
const slot = /\{\{([a-z][a-z0-9_]{1,63})\}\}/gu;
const markdownPunctuation = new Set([
  '\\',
  '`',
  '*',
  '_',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '#',
  '+',
  '.',
  '!',
  '|',
  '<',
  '>',
  '&',
]);
const escaped = (value: string) =>
  [...value]
    .map((character) => (markdownPunctuation.has(character) ? '\\' + character : character))
    .join('');

export const coverLetterFileName = '510k-cover-letter.draft.md';
export const coverLetterSourcesName = '510k-cover-letter.sources.json';
export function coverLetterReference({ documentId, version, page, quote }: Reference) {
  return {
    documentId,
    version,
    page,
    quoteSha256: createHash('sha256').update(quote).digest('hex'),
  };
}
export function coverLetterReferenceKey(ref: ReturnType<typeof coverLetterReference>) {
  return JSON.stringify([ref.documentId, ref.version, ref.page, ref.quoteSha256]);
}
export function loadCoverLetterManifest() {
  return readFile(
    new URL('../../../../knowledge/k05/us-510k-cover-letter.yaml', import.meta.url),
    'utf8',
  );
}

export function parseK05Draft(text: string) {
  if (Buffer.byteLength(text, 'utf8') > 32_000) throw new Error('K05 模板超过允许大小。');
  const document = parseDocument(text, {
    strict: true,
    uniqueKeys: true,
    resolveKnownTags: false,
    merge: false,
  });
  if (document.errors.length || document.warnings.length) throw new Error('K05 模板 YAML 无效。');
  visit(document, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (node.tag || ('anchor' in node && node.anchor))))
      throw new Error('K05 模板不能用标签、锚点或别名。');
  });
  const value = manifestSchema.parse(document.toJS({ maxAliasCount: 0 }));
  const idSet = new Set(value.sources.map(({ id }) => id));
  if (
    idSet.size !== value.sources.length ||
    new Set(value.paragraphs.map(({ id }) => id)).size !== value.paragraphs.length
  )
    throw new Error('K05 模板中有重复的来源或段落编号。');
  for (const entry of value.paragraphs) {
    if (
      entry.sources.some((source) => !idSet.has(source)) ||
      /\{\{|\}\}/u.test(entry.text.replace(slot, ''))
    )
      throw new Error('K05 模板的来源引用或占位符无效。');
  }
  const slots = new Set(
    value.paragraphs.flatMap(({ text }) => [...text.matchAll(slot)].map((match) => match[1]!)),
  );
  const labels = Object.values(value.fields)
    .flat()
    .map((label) => label.toLowerCase());
  if (
    slots.size !== Object.keys(value.fields).length ||
    [...slots].some((field) => !Object.hasOwn(value.fields, field)) ||
    labels.some((label) => /[:：]/u.test(label)) ||
    new Set(labels).size !== labels.length
  )
    throw new Error('K05 模板必须为每个占位符声明独立的资料字段标签。');
  return value;
}

function labelledValues(text: string, labels: string[]) {
  const accepted = new Set(labels.map((label) => label.toLowerCase()));
  return text.split(/\r?\n/u).flatMap((line) => {
    const fields = /^\s*([^:：]+)[:：][ \t]*(.*?)[ \t]*$/u.exec(line);
    return fields && accepted.has(fields[1]!.trim().toLowerCase()) ? [fields[2]!] : [];
  });
}

function citesFieldLine(page: string, quote: string, labels: string[], value: string) {
  if (!labelledValues(quote, labels).includes(value)) return false;
  const lines = quote.split(/\r?\n/u);
  for (let start = page.indexOf(quote); start !== -1; start = page.indexOf(quote, start + 1)) {
    const end = start + quote.length;
    const beginsLine = start === 0 || page[start - 1] === '\n';
    const endsLine = end === page.length || page[end] === '\n' || page.startsWith('\r\n', end);
    const complete = lines.slice(beginsLine ? 0 : 1, endsLine ? lines.length : -1);
    if (labelledValues(complete.join('\n'), labels).includes(value)) return true;
  }
  return false;
}

export async function renderK05Draft(
  template: string,
  input: unknown,
  readPage: ReadPage,
  { synthetic = false } = {},
) {
  const manifest = parseK05Draft(template);
  const fields = coverLetterFieldsSchema.parse(input);
  const versions = new Map<string, Map<number, string>>();
  const verified = new Map<string, (typeof fields)[string]>();
  const unverified: string[] = [];
  for (const [field, entry] of Object.entries(fields)) {
    if (!Object.hasOwn(manifest.fields, field)) throw new Error('K05 字段需由模板声明。');
    const ref = entry.source;
    const versionKey = JSON.stringify([ref.documentId, ref.version]);
    const pages = versions.get(versionKey) ?? new Map<number, string>();
    versions.set(versionKey, pages);
    const page = pages.get(ref.page) ?? (await readPage(ref));
    if (!page?.includes(ref.quote))
      throw new AppError(422, 'K05_ORIGINAL_MISMATCH', 'K05 依据与资料库原文不一致。');
    pages.set(ref.page, page);
  }
  for (const [field, entry] of Object.entries(fields)) {
    const ref = entry.source;
    const labels = manifest.fields[field]!;
    const pages = versions.get(JSON.stringify([ref.documentId, ref.version]))!;
    const values = new Set([...pages.values()].flatMap((page) => labelledValues(page, labels)));
    if (
      values.size === 1 &&
      values.has(entry.value) &&
      citesFieldLine(pages.get(ref.page)!, ref.quote, labels, entry.value)
    )
      verified.set(field, entry);
    else unverified.push(field);
  }
  const missing = new Set<string>();
  const notice = synthetic ? 'Synthetic test data. For internal review.' : 'For internal review.';
  const lines = [`# ${escaped(manifest.title)} — draft`, notice];
  const documentParagraphs: string[] = [];
  const paragraphs = manifest.paragraphs.map((item, index) => {
    const evidence = new Map<string, Reference>();
    const values = new Map<string, string>();
    const text = item.text.replace(slot, (_match, field: string) => {
      const entry = verified.get(field);
      if (!entry) {
        missing.add(field);
        const placeholder = `[TO VERIFY: ${field}]`;
        values.set(field, placeholder);
        return placeholder;
      }
      evidence.set(field, entry.source);
      values.set(field, entry.value);
      return escaped(entry.value);
    });
    lines.push(text);
    documentParagraphs.push(item.text.replace(slot, (_match, field: string) => values.get(field)!));
    return {
      id: item.id,
      number: index + 1,
      sources: item.sources,
      evidence: [...evidence].map(([field, source]) => ({
        field,
        source,
        value: verified.get(field)!.value,
      })),
    };
  });
  const markdown = lines.join('\n\n') + '\n';
  return {
    markdown,
    document: {
      title: `${manifest.title} draft`,
      notice,
      paragraphs: documentParagraphs,
    },
    sourceMap: {
      templateCode: manifest.code,
      templateVersion: manifest.version,
      publication: manifest.publication,
      synthetic,
      contentSha256: createHash('sha256').update(markdown).digest('hex'),
      missing: [...missing],
      unverified,
      sources: manifest.sources,
      paragraphs,
    },
  };
}
