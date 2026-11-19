import {
  deadlineCalculationResultSchema,
  deadlineCalculationSchema,
  deadlineDateSchema,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';

const hour = 60 * 60 * 1000;
const beijing = formatter('Asia/Shanghai');

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function wallClock(timestamp: number, display: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(
    display.formatToParts(timestamp).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

function atLocalDayEnd(date: string, display: Intl.DateTimeFormat) {
  const last = `${date}T23:59:59.999`;
  const wall = Date.parse(`${last}Z`);
  const offsets = new Set<number>();
  // Sample both sides of the cutoff so offset changes and repeated wall times are distinguishable.
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = wall + hours * hour;
    offsets.add(Date.parse(`${wallClock(instant, display)}Z`) - instant);
  }
  const matching = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => wallClock(instant, display) === last);
  if (matching.length) return Math.max(...matching);

  // A forward shift at the end of a day can skip 23:59 without skipping the whole date.
  const step = hour / 4;
  const onDate = (instant: number) => wallClock(instant, display).startsWith(`${date}T`);
  for (let instant = wall + 36 * hour; instant >= wall - 36 * hour; instant -= step) {
    if (!onDate(instant)) continue;
    let low = instant;
    let high = instant + step;
    while (high - low > 1) {
      const midpoint = low + Math.floor((high - low) / 2);
      if (onDate(midpoint)) low = midpoint;
      else high = midpoint;
    }
    return low;
  }
  throw new AppError(
    422,
    'DEADLINE_LOCAL_TIME_INVALID',
    '该法域没有这个当地日期，请核对起算日和时区。',
  );
}

export function calculateDeadline(input: unknown) {
  const parsed = deadlineCalculationSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      400,
      'DEADLINE_CALCULATION_INVALID',
      '请填写有效的起算日、时区和按天或按月的加减数量。',
    );
  const { startDate, quantity, unit, jurisdictionTz } = parsed.data;
  let jurisdiction: Intl.DateTimeFormat;
  try {
    // IANA names and UTC keep downstream PostgreSQL scans and Node calculations in the same time zone.
    if (jurisdictionTz !== 'UTC' && !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u.test(jurisdictionTz))
      throw new RangeError('invalid time zone name');
    jurisdiction = formatter(jurisdictionTz);
  } catch {
    throw new AppError(
      400,
      'DEADLINE_TIMEZONE_INVALID',
      '请填写明确的 IANA 法域时区，例如 America/New_York。',
    );
  }

  const civil = new Date(`${startDate}T00:00:00Z`);
  if (unit === 'calendar_days') civil.setUTCDate(civil.getUTCDate() + quantity);
  else {
    const day = civil.getUTCDate();
    civil.setUTCMonth(civil.getUTCMonth() + quantity, 1);
    const monthEnd = new Date(Date.UTC(civil.getUTCFullYear(), civil.getUTCMonth() + 1, 0));
    civil.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  }
  const dueDate = civil.toISOString().slice(0, 10);
  if (!deadlineDateSchema.safeParse(dueDate).success)
    throw new AppError(
      422,
      'DEADLINE_RANGE_INVALID',
      '计算日期超出支持范围，请核对起算日和加减数量。',
    );
  const instant = atLocalDayEnd(dueDate, jurisdiction);
  return deadlineCalculationResultSchema.parse({
    calculation: { ...parsed.data, jurisdictionTz: jurisdiction.resolvedOptions().timeZone },
    dueDate,
    dueAt: new Date(instant).toISOString(),
    beijingTime: wallClock(instant, beijing).slice(0, 19).replace('T', ' '),
  });
}
