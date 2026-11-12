/**
 * 날짜·시각 도우미. 날짜는 KST 기준 'YYYY-MM-DD', 시각은 'HH:MM' 문자열로 다룬다.
 * 브라우저·서버 시간대와 무관하게 같은 결과가 나오도록 UTC 자정으로 계산한다.
 */

const DAY_NAMES = '일월화수목금토';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export function isTime(value: string): boolean {
  return TIME_RE.test(value);
}

function parseDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** 0=일요일 … 6=토요일 */
export function dayOfWeek(value: string): number {
  return parseDate(value).getUTCDay();
}

export function dayName(day: number): string {
  return DAY_NAMES[day];
}

export function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 2026년 11월 11일 수요일 */
export function longDate(value: string): string {
  const date = parseDate(value);
  return `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 ${DAY_NAMES[date.getUTCDay()]}요일`;
}

/** 11/11(수) */
export function shortDate(value: string): string {
  const date = parseDate(value);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}(${DAY_NAMES[date.getUTCDay()]})`;
}

/** 시각(ms) → KST ISO-8601 문자열(예: 2026-11-09T10:00:00+09:00) */
export function toKstIso(instant: number): string {
  const kst = new Date(instant + 9 * 60 * 60 * 1000);
  return `${kst.toISOString().slice(0, 19)}+09:00`;
}

/** 시각(ms) → KST 날짜 */
export function kstDateOf(instant: number): string {
  return toKstIso(instant).slice(0, 10);
}

/** 지금 시각의 KST ISO-8601 문자열(화면 이벤트 처리용) */
export function nowKstIso(): string {
  return toKstIso(Date.now());
}
