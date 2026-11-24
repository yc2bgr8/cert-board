import { diffArrays } from 'diff';
import {
  humanRevisionDifferenceSchema,
  humanRevisionMaxBytes,
  type HumanRevisionDifference,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

function paragraphs(text: string) {
  return text
    .replace(/\r\n?/gu, '\n')
    .split(/\n(?:[ \t]*\n)+/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function compareHumanRevision(before: string, after: string) {
  const first = paragraphs(before);
  const next = paragraphs(after);
  const limit = () =>
    new AppError(
      413,
      'HUMAN_REVISION_DIFF_LIMIT',
      '正文过长或改动太多，无法比对段落。请拆成较小的文件再上传。',
    );
  if (
    Buffer.byteLength(before) > humanRevisionMaxBytes ||
    Buffer.byteLength(after) > humanRevisionMaxBytes ||
    first.length > 1000 ||
    next.length > 1000
  )
    throw limit();
  const changes = diffArrays(first, next, { timeout: 200, maxEditLength: 1000 });
  if (!changes) throw limit();
  let added = 0;
  let removed = 0;
  let oldNumber = 1;
  let newNumber = 1;
  const difference: HumanRevisionDifference['paragraphs'] = [];
  for (const change of changes) {
    if (!change.added && !change.removed) {
      oldNumber += change.value.length;
      newNumber += change.value.length;
      continue;
    }
    const kind = change.added ? 'added' : 'removed';
    for (const text of change.value) {
      const number = change.added ? newNumber++ : oldNumber++;
      if (change.added) added++;
      else removed++;
      if (difference.length < 80) {
        difference.push({
          kind,
          number,
          text: text.slice(0, 2000).replace(/[\uD800-\uDBFF]$/u, ''),
          truncated: text.length > 2000,
        });
      }
    }
  }
  return humanRevisionDifferenceSchema.parse({
    added,
    removed,
    paragraphs: difference,
    truncated: added + removed > difference.length,
  });
}
