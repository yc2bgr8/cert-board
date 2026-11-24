import { createHash } from 'node:crypto';
import { isAlias, isNode, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { documentCitationSchema } from '@cert-board/shared';

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
  sources: authority.array().min(1).max(12),
  paragraphs: paragraph.array().min(1).max(24),
});
const fieldSchema = z.strictObject({
  value: z.string().trim().min(1).max(300).refine(singleLine),
  source: documentCitationSchema,
});
const fieldsSchema = z.record(key, fieldSchema);
type Reference = z.infer<typeof documentCitationSchema>;
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
]);
const escaped = (value: string) =>
  [...value]
    .map((character) => (markdownPunctuation.has(character) ? '\\' + character : character))
    .join('');

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
  return value;
}

export async function renderK05Draft(template: string, input: unknown, readPage: ReadPage) {
  const manifest = parseK05Draft(template);
  const fields = fieldsSchema.parse(input);
  const used = new Set(
    manifest.paragraphs.flatMap(({ text }) => [...text.matchAll(slot)].map((match) => match[1]!)),
  );
  const pages = new Map<string, Promise<string | null>>();
  for (const [field, entry] of Object.entries(fields)) {
    if (!used.has(field) || !entry.source.quote.includes(entry.value))
      throw new Error('K05 字段需由模板声明，并在所引原文中逐字出现。');
    const ref = entry.source;
    const pageKey = JSON.stringify([ref.documentId, ref.version, ref.page]);
    const reading = pages.get(pageKey) ?? readPage(ref);
    pages.set(pageKey, reading);
    if (!(await reading)?.includes(ref.quote)) throw new Error('K05 依据与资料库原文不一致。');
  }
  const missing = new Set<string>();
  const lines = [`# ${escaped(manifest.title)} — draft`, 'For internal review.'];
  const paragraphs = manifest.paragraphs.map((item, index) => {
    const evidence = new Map<string, Reference>();
    const text = item.text.replace(slot, (_match, field: string) => {
      const entry = Object.hasOwn(fields, field) ? fields[field] : undefined;
      if (!entry) {
        missing.add(field);
        return `[TO VERIFY: ${field}]`;
      }
      evidence.set(field, entry.source);
      return escaped(entry.value);
    });
    lines.push(text);
    return {
      id: item.id,
      number: index + 1,
      sources: item.sources,
      evidence: [...evidence].map(([field, source]) => ({ field, source })),
    };
  });
  const markdown = lines.join('\n\n') + '\n';
  return {
    markdown,
    sourceMap: {
      templateCode: manifest.code,
      templateVersion: manifest.version,
      publication: manifest.publication,
      contentSha256: createHash('sha256').update(markdown).digest('hex'),
      missing: [...missing],
      sources: manifest.sources,
      paragraphs,
    },
  };
}
