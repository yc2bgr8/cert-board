import { readFile } from 'node:fs/promises';
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import { reviewPolicySchema, type ReviewPolicy } from '@cert-board/shared';
import { AppError } from '../api/errors.js';

const invalid = () =>
  new AppError(
    403,
    'REVIEW_POLICY_UNAVAILABLE',
    '当前审核技能仍为开发草稿或配置无效，不能用于生产审核；请联系注册负责人确认发布版本。',
  );
export function requireReviewPolicy(
  input: unknown,
  environment = process.env.NODE_ENV ?? 'production',
): ReviewPolicy {
  if (process.env.NODE_ENV === 'production' || !['development', 'test'].includes(environment))
    throw invalid();
  const parsed = reviewPolicySchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
export function parseReviewPolicy(
  markdown: string,
  environment = process.env.NODE_ENV ?? 'production',
): ReviewPolicy {
  try {
    if (Buffer.byteLength(markdown, 'utf8') > 32000) throw invalid();
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!frontmatter) throw invalid();
    const documents = parseAllDocuments(frontmatter[1]!, {
      version: '1.2',
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
      merge: false,
      resolveKnownTags: false,
    });
    const document = documents[0];
    if (documents.length !== 1 || !document || document.errors.length || document.warnings.length)
      throw invalid();
    visit(document, (_key, node) => {
      if (isAlias(node) || (isNode(node) && (('anchor' in node && node.anchor) || node.tag)))
        throw invalid();
    });
    return requireReviewPolicy(document.toJS({ maxAliasCount: 0 }), environment);
  } catch {
    throw invalid();
  }
}
export async function loadReviewPolicy(
  environment = process.env.NODE_ENV ?? 'production',
): Promise<ReviewPolicy> {
  try {
    const source = await readFile(
      new URL('../../../../skills/R09-一致性检查/SKILL.md', import.meta.url),
      'utf8',
    );
    return parseReviewPolicy(source, environment);
  } catch {
    throw invalid();
  }
}
