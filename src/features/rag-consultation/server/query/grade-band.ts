import { compactText } from '../text/normalize.ts';

function grade(level: string, value: string): number | undefined {
  const number = Number(value);
  if (!number || number > (level === '초' ? 6 : 3)) return;
  return number + { 초: 0, 중: 6, 고: 9 }[level as '초' | '중' | '고'];
}

/** Expand public target labels such as 초3·4, 중2~고1 or 고1·고2. */
export function gradeBand(label: string): number[] {
  const value = compactText(label)
    .replace(/\([^()]*\)$/, '')
    .replace(/학년/g, '');
  const range = /^([초중고])([1-6])(?:~|–|〜|-)([초중고])?([1-6])$/.exec(value);
  if (range) {
    const from = grade(range[1], range[2]);
    const to = grade(range[3] ?? range[1], range[4]);
    return from !== undefined && to !== undefined && from <= to
      ? Array.from({ length: to - from + 1 }, (_, index) => from + index)
      : [];
  }
  const parts = value.split(/[·,/]/);
  let level = '';
  const grades: number[] = [];
  for (const part of parts) {
    const match = /^([초중고])?([1-6])$/.exec(part);
    if (!match) return [];
    level = match[1] ?? level;
    if (!level) return [];
    const parsed = grade(level, match[2]);
    if (parsed === undefined) return [];
    grades.push(parsed);
  }
  return grades;
}
