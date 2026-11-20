import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import { skillVersionDraftSchema } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

export function parseSkillDraftMarkdown(source: string) {
  const invalid = () =>
    new AppError(422, 'SKILL_DRAFT_INVALID', '请检查 SKILL.md 的元数据、正文和所需检查项。');
  if (Buffer.byteLength(source, 'utf8') > 32_000) throw invalid();
  const beginning = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!beginning) throw invalid();
  const documents = parseAllDocuments(beginning[1]!, {
    version: '1.2',
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: 'silent',
    merge: false,
    resolveKnownTags: false,
  });
  const header = documents[0];
  if (documents.length !== 1 || !header || header.errors.length || header.warnings.length)
    throw invalid();
  visit(header, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (('anchor' in node && node.anchor) || node.tag)))
      throw invalid();
  });
  const result = skillVersionDraftSchema.safeParse({
    metadata: header.toJS({ maxAliasCount: 0 }),
    body: source.slice(beginning[0].length).trim(),
  });
  if (!result.success) throw invalid();
  return result.data;
}
