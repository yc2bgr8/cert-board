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

export function checkDeadlineClaims(submission: StructuredSubmission) {
  const issues: Issue[] = [];
  let ran = false;
  for (const [index, claim] of submission.claims.entries()) {
    const path = `claims[${index}].value`;
    if (!claim.deadlineCalculation) {
      if (
        claim.status !== 'unverified' &&
        deadlineFields.has(claim.field.normalize('NFKC').toLowerCase())
      ) {
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
