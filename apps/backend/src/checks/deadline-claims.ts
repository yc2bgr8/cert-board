import {
  deadlineClaimInstantSchema,
  type CheckReport,
  type StructuredSubmission,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { calculateDeadline } from '../deadlines/calendar.js';

type Issue = CheckReport['checks'][number]['issues'][number];
const deadlineLanguage =
  /截止|截至|到期|有效期(?:至|到)|限期|最迟|最晚|不晚于|期限|逾期|(?<!提)前(?:提交|申报|完成|办理|回复|续证|登记|生效|支付|缴费|交付)|(?:须|必须|需要|应于|请于).{0,60}(?:之前|以前)|\bdue\b|\bdeadlines?\b|\bexpir(?:e|es|y|ation)\b|\bvalid until\b|\bno later than\b|\bwithin\s+\d/iu;
const datedLanguage =
  /\d{4}[-/.年]\s*\d{1,2}(?:[-/.月]\s*\d{1,2})?|\b\d{8}\b|\d{1,2}月\s*\d{1,2}日|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|(?:今|明|后)天|(?:本|下)(?:周|月|年)|\d+\s*(?:个?月|天|日|周|年|hours?\b|days?\b|months?\b|weeks?\b)|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,4}\b/iu;

const explicitDeadlineObject =
  /(?:截止(?:日(?:期)?|时间|点)?|到期(?:日(?:期)?|时间)?|最后期限|\bdeadline|\bdue date)\s*$/iu;
const genericDateField = /^(?:日|日期|时间|时点|时刻|date|time)$/iu;
const earlySubmissionDirective =
  /(?:请于|应于|须于|必须在)([^，。；！？,;!?\n]{0,60}?)提前(?:提交|申报|办理)/giu;
const acceptanceCutoff = new RegExp(
  `(?:${datedLanguage.source})\\s*(?:之后|以后|起)\\s*(?:将\\s*)?不再受理`,
  'iu',
);

export function checkDeadlineClaims(submission: StructuredSubmission) {
  const issues: Issue[] = [];
  let ran = false;
  const assertsDeadline = (text: string) => {
    const normalized = text.normalize('NFKC').replace(/:\s*\n\s*/gu, ': ');
    return normalized.split(/[，。；！？,;!?\n]/u).some((clause) => {
      return (
        (deadlineLanguage.test(clause) && datedLanguage.test(clause)) ||
        acceptanceCutoff.test(clause) ||
        Array.from(clause.matchAll(earlySubmissionDirective)).some((match) =>
          datedLanguage.test(match[1] ?? ''),
        )
      );
    });
  };
  const prose = (text: string, path: string) => {
    if (assertsDeadline(text)) {
      ran = true;
      issues.push({ code: 'deadline_unstructured', path });
    }
  };
  prose(submission.conclusion, 'conclusion');
  prose(submission.nextStep, 'nextStep');
  for (const [index, decision] of submission.decisions.entries()) {
    if (
      [decision.subject, decision.choice, decision.reason, ...decision.alternatives].some(
        assertsDeadline,
      )
    ) {
      ran = true;
      issues.push({ code: 'deadline_unstructured', path: `decisions[${index}]` });
    }
  }

  for (const [index, claim] of submission.claims.entries()) {
    const path = `claims[${index}].value`;
    if (!claim.deadlineCalculation) {
      const field = claim.field.normalize('NFKC');
      const label =
        genericDateField.test(field) && explicitDeadlineObject.test(claim.object.normalize('NFKC'))
          ? claim.object
          : field;
      prose(`${label} ${claim.value}`, path);
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
