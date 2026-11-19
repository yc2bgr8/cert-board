import {
  deadlineClaimInstantSchema,
  type CheckReport,
  type StructuredSubmission,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { calculateDeadline } from '../deadlines/calendar.js';

type Issue = CheckReport['checks'][number]['issues'][number];
const deadlineLanguage =
  /截止|截至|到期|有效期(?:至|到)|限期|最迟|期限|逾期|(?:须|必须|需要).{0,60}(?:之前|前完成)|\bdue\b|\bdeadlines?\b|\bexpir(?:e|es|y|ation)\b|\bvalid until\b|\bno later than\b|\bwithin\s+\d/iu;
const datedLanguage =
  /\d{4}[-/.年]\s*\d{1,2}(?:[-/.月]\s*\d{1,2})?|\b\d{8}\b|\d{1,2}月\s*\d{1,2}日|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|(?:今|明|后)天|(?:本|下)(?:周|月|年)|\d+\s*(?:个?月|天|日|周|年|hours?\b|days?\b|months?\b|weeks?\b)|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,4}\b/iu;

export function checkDeadlineClaims(submission: StructuredSubmission) {
  const issues: Issue[] = [];
  let ran = false;
  const prose = (text: string, path: string) => {
    if (deadlineLanguage.test(text) && datedLanguage.test(text)) {
      ran = true;
      issues.push({ code: 'deadline_unstructured', path });
    }
  };
  prose(submission.conclusion, 'conclusion');
  prose(submission.nextStep, 'nextStep');
  for (const [index, decision] of submission.decisions.entries()) {
    if (
      [decision.choice, decision.reason, ...decision.alternatives].some(
        (value) => deadlineLanguage.test(value) && datedLanguage.test(value),
      )
    ) {
      ran = true;
      issues.push({ code: 'deadline_unstructured', path: `decisions[${index}]` });
    }
  }

  for (const [index, claim] of submission.claims.entries()) {
    const path = `claims[${index}].value`;
    if (!claim.deadlineCalculation) {
      prose(`${claim.object} ${claim.field} ${claim.value}`, path);
      continue;
    }
    ran = true;
    const stated = deadlineClaimInstantSchema.safeParse(claim.value);
    if (!stated.success || !deadlineLanguage.test(claim.field)) {
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
