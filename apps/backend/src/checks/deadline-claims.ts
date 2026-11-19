import {
  deadlineClaimInstantSchema,
  type CheckReport,
  type StructuredSubmission,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { calculateDeadline } from '../deadlines/calendar.js';

type Issue = CheckReport['checks'][number]['issues'][number];
const deadlineFields = new Set([
  '截止日',
  '截止日期',
  '截止时间',
  '到期日',
  '到期日期',
  '到期时间',
  '有效期至',
  'deadline',
  'due date',
  'expiration date',
]);
const plainDateFields = new Set(['日', '日期', '时间', '时点', '时刻', 'date', 'time']);
const namedDeadline = (object: string) => {
  const label = object.normalize('NFKC').trim().toLowerCase();
  return Array.from(deadlineFields).some((suffix) => {
    if (!label.endsWith(suffix)) return false;
    return !/^[a-z]/u.test(suffix) || !/\w/u.test(label.at(-(suffix.length + 1)) ?? '');
  });
};

export function checkDeadlineClaims(submission: StructuredSubmission) {
  const issues: Issue[] = [];
  let ran = false;
  for (const [index, claim] of submission.claims.entries()) {
    const path = `claims[${index}].value`;
    if (!claim.deadlineCalculation) {
      const field = claim.field.normalize('NFKC').toLowerCase();
      const declared =
        deadlineFields.has(field) || (plainDateFields.has(field) && namedDeadline(claim.object));
      if (claim.status !== 'unverified' && declared) {
        ran = true;
        issues.push({ code: 'deadline_unstructured', path });
      }
      continue;
    }
    ran = true;
    const stated = deadlineClaimInstantSchema.safeParse(claim.value);
    if (!stated.success) {
      issues.push({ code: 'deadline_invalid', path });
      continue;
    }
    try {
      if (
        Date.parse(stated.data) !== Date.parse(calculateDeadline(claim.deadlineCalculation).dueAt)
      )
        issues.push({ code: 'deadline_mismatch', path });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      issues.push({ code: 'deadline_invalid', path });
    }
  }
  return { ran, issues };
}
