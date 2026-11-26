import { kstStartOfDay, toKstDate } from '../text/time.ts';
import type { QueryFrame } from '../query/parse-query.ts';
import type { FactValue } from '../types.ts';

const weekdays = '일월화수목금토';
const dayMs = 24 * 60 * 60 * 1000;

export function weekdayAt(at: number): string {
  const { year, month, day } = toKstDate(at);
  return weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** Resolve one weekday in an explicitly named week in the academy time zone. */
export function weekdayInNamedWeek(frame: QueryFrame, asOf: number) {
  const days = [
    ...new Set(
      [...frame.normalized.matchAll(/([월화수목금토일])요일/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (
    !frame.relativeWeek ||
    days.length !== 1 ||
    frame.explicitDates.length ||
    frame.relativeDay !== null ||
    frame.months.length ||
    frame.relativePeriod
  )
    return;
  const mondayOffset = (day: string) => (weekdays.indexOf(day) + 6) % 7;
  const week = { last_week: -1, this_week: 0, next_week: 1 }[
    frame.relativeWeek
  ];
  return (
    kstStartOfDay(toKstDate(asOf)) +
    (week * 7 + mondayOffset(days[0]) - mondayOffset(weekdayAt(asOf))) * dayMs
  );
}

interface TableDate {
  year?: number;
  month: number;
  day: number;
  weekday?: string;
}

function parseTableDate(value: string): TableDate | undefined {
  const text = value.normalize('NFKC').trim();
  const korean =
    /^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(?:\(([월화수목금토일])(?:요일)?\))?$/.exec(
      text,
    );
  const numeric = /^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})$/.exec(text);
  const match = korean ?? numeric;
  if (!match) return;
  const [, year, month, day, weekday] = match;
  return {
    year: year ? Number(year) : undefined,
    month: Number(month),
    day: Number(day),
    weekday,
  };
}

export function tableDateAt(
  value: string,
  inferredYear: number,
): number | undefined {
  const date = parseTableDate(value);
  return date && checkedDate(date, date.year ?? inferredYear);
}

/** The event interval is separate from the lifetime of the approved announcement. */
export function scheduleChangeInterval(
  value: Extract<FactValue, { kind: 'schedule_change' }>,
) {
  const day = tableDateAt(value.date, 0);
  if (day === undefined) return;
  const { event } = value;
  if (event) {
    const { startsAt, endsAt } = event;
    return Number.isSafeInteger(startsAt) &&
      Number.isSafeInteger(endsAt) &&
      startsAt >= day &&
      startsAt < day + dayMs &&
      startsAt < endsAt
      ? { start: startsAt, end: endsAt }
      : undefined;
  }
  const time = /^(\d{2}):(\d{2})\s*[~–-]\s*(\d{2}):(\d{2})$/.exec(
    value.time ?? '',
  );
  if (!time) return { start: day, end: day + dayMs };
  const [, startHour, startMinute, endHour, endMinute] = time.map(Number);
  const start = day + (startHour * 60 + startMinute) * 60_000;
  const end = day + (endHour * 60 + endMinute) * 60_000;
  return startHour < 24 &&
    endHour < 24 &&
    startMinute < 60 &&
    endMinute < 60 &&
    start < end
    ? { start, end }
    : undefined;
}

function checkedDate(date: TableDate, year: number): number | undefined {
  const { month, day, weekday } = date;
  const instant = kstStartOfDay({ year, month, day });
  const actual = toKstDate(instant);
  if (actual.year !== year || actual.month !== month || actual.day !== day)
    return;
  if (weekday && weekday !== weekdayAt(instant)) return;
  return instant;
}

/** A yearless cross-year range can start in the request year or the one before. */
export function tablePeriodOverlapping(
  value: string,
  window: { from: number; to: number },
): { from: number; to: number } | undefined {
  const parts = value.normalize('NFKC').split(/\s*[~–—]\s*|\s+-\s+/);
  if (parts.length !== 2) return;
  const start = parseTableDate(parts[0]);
  const end = parseTableDate(parts[1]);
  if (!start || !end) return;
  const rollover = Number(end.month < start.month);
  const firstYear = toKstDate(window.from).year - rollover;
  const lastYear = toKstDate(window.to).year;
  const startYears =
    start.year !== undefined
      ? [start.year]
      : end.year !== undefined
        ? [end.year - rollover]
        : Array.from(
            { length: lastYear - firstYear + 1 },
            (_, index) => firstYear + index,
          );
  for (const startYear of startYears) {
    const from = checkedDate(start, startYear);
    const to = checkedDate(end, end.year ?? startYear + rollover);
    if (
      from !== undefined &&
      to !== undefined &&
      from <= to &&
      window.from <= to &&
      from <= window.to
    )
      return { from, to };
  }
}

export function tablePeriodAt(value: string, day: number) {
  return tablePeriodOverlapping(value, { from: day, to: day });
}

export function tablePeriodContains(value: string, day: number): boolean {
  return tablePeriodAt(value, day) !== undefined;
}
