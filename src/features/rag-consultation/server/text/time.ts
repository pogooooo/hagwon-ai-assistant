/**
 * 학원 시간대(Asia/Seoul, UTC+9 고정·서머타임 없음) 기준 날짜 처리.
 * 유효 기간은 [validFrom, validTo) 반열린 구간으로 해석한다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface KstDate {
  year: number;
  month: number;
  day: number;
}

export function parseInstant(iso: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid ISO-8601 instant: ${iso}`);
  }
  return value;
}

export function parseOptionalInstant(
  iso: string | null | undefined,
): number | null {
  return iso ? parseInstant(iso) : null;
}

export function toKstDate(ms: number): KstDate {
  const date = new Date(ms + KST_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function kstStartOfDay({ year, month, day }: KstDate): number {
  return Date.UTC(year, month - 1, day) - KST_OFFSET_MS;
}

export function isSameKstDay(a: number, b: number): boolean {
  const da = toKstDate(a);
  const db = toKstDate(b);
  return da.year === db.year && da.month === db.month && da.day === db.day;
}

export function isValidAt(
  validFrom: number,
  validTo: number | null,
  at: number,
): boolean {
  return validFrom <= at && (validTo === null || at < validTo);
}

export function toIsoDate({ year, month, day }: KstDate): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function makePeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function shiftPeriod(period: string, deltaMonths: number): string {
  const [yearText, monthText] = period.split('-');
  const index = Number(yearText) * 12 + (Number(monthText) - 1) + deltaMonths;
  return makePeriod(Math.floor(index / 12), (index % 12) + 1);
}

export function comparePeriods(a: string, b: string): number {
  return a.localeCompare(b);
}

export function formatKstDate(ms: number): string {
  const { year, month, day } = toKstDate(ms);
  return `${year}년 ${month}월 ${day}일`;
}

export function formatIsoDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${year}년 ${month}월 ${day}일`;
}

export function formatPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return `${year}년 ${month}월`;
}

/** [from, to) 구간을 사람이 읽는 형태로. to 는 배타적이므로 표시 종료일은 하루 전. */
export function formatValidity(
  validFrom: number,
  validTo: number | null,
): string {
  if (validTo === null) {
    return `${formatKstDate(validFrom)}부터 적용`;
  }
  const lastDay = kstStartOfDay(toKstDate(validTo - 1));
  return `${formatKstDate(validFrom)} ~ ${formatKstDate(lastDay)} 적용`;
}
