import { isValidTimezone } from '../../timezone.js';

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const LIMITS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(raw: string, min: number, max: number): CronField {
  const values = new Set<number>();
  const wildcard = raw === '*';
  for (const segment of raw.split(',')) {
    const [rangePart, stepPart] = segment.split('/');
    if (!rangePart || (stepPart !== undefined && !/^\d+$/.test(stepPart))) {
      throw new Error(`Invalid cron field: ${raw}`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${raw}`);

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (/^\d+$/.test(rangePart)) {
      start = end = Number(rangePart);
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangePart);
      if (!match) throw new Error(`Invalid cron range: ${raw}`);
      start = Number(match[1]);
      end = Number(match[2]);
    }
    if (start < min || end > max || start > end) throw new Error(`Cron field outside range: ${raw}`);
    for (let value = start; value <= end; value += step) {
      values.add(value === 7 && max === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new Error(`Empty cron field: ${raw}`);
  return { values, wildcard };
}

function parseCron(expression: string): CronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron expressions must have five fields');
  return {
    minute: parseField(parts[0], ...LIMITS[0]),
    hour: parseField(parts[1], ...LIMITS[1]),
    dayOfMonth: parseField(parts[2], ...LIMITS[2]),
    month: parseField(parts[3], ...LIMITS[3]),
    dayOfWeek: parseField(parts[4], ...LIMITS[4]),
  };
}

function localTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  return {
    minute: value('minute'),
    hour: value('hour'),
    dayOfMonth: day,
    month,
    // This constructs a calendar date, so UTC is only used to obtain its weekday.
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

function matches(cron: CronExpression, date: Date, timezone: string): boolean {
  const local = localTime(date, timezone);
  if (!cron.minute.values.has(local.minute) || !cron.hour.values.has(local.hour)) return false;
  if (!cron.month.values.has(local.month)) return false;

  const dayOfMonthMatches = cron.dayOfMonth.values.has(local.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(local.dayOfWeek);
  // Cron's conventional DOM/DOW semantics: when both are restricted, either may match.
  const dayMatches =
    cron.dayOfMonth.wildcard || cron.dayOfWeek.wildcard
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return dayMatches;
}

/** Validate the supported five-field cron grammar and timezone. */
export function validateCron(expression: string, timezone: string): void {
  if (!isValidTimezone(timezone)) throw new Error(`Invalid IANA timezone: ${timezone}`);
  parseCron(expression);
}

/** Return the first matching minute strictly after `after`. */
export function nextCronOccurrence(expression: string, timezone: string, after: Date): Date {
  validateCron(expression, timezone);
  const cron = parseCron(expression);
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // A one-year bound prevents malformed but syntactically valid schedules from looping forever.
  for (let minute = 0; minute < 366 * 24 * 60; minute++) {
    if (matches(cron, candidate, timezone)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`No matching occurrence within one year: ${expression}`);
}
