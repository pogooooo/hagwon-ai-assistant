/**
 * 답변 사후 검사(CiteFix 아이디어의 규칙형 변형, 추가 API 호출 없음).
 * 답변에 등장하는 숫자가 근거 사실·날짜·코드 계산값에서 왔는지, 다른 학생/학원 식별자가
 * 섞이지 않았는지 확인한다. 숫자 일치가 문장 전체의 참을 보장하지는 않는다.
 */
import { toKstDate } from '../text/time.ts';
import type { ApprovedFact } from '../types.ts';
import { accuracyPercent } from './format.ts';

const NUMBER_PATTERN = /(?<![A-Za-z가-힣_\d.])\d[\d,]*(?:\.\d+)?/g;

export function extractNumbers(text: string): number[] {
  return [...text.matchAll(NUMBER_PATTERN)]
    .map((match) => Number(match[0].replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

function addDateParts(target: Set<number>, ms: number | null) {
  if (ms === null) return;
  for (const candidate of [ms, ms - 1]) {
    const { year, month, day } = toKstDate(candidate);
    target.add(year);
    target.add(month);
    target.add(day);
  }
}

export function allowedNumbersFor(input: {
  facts: readonly ApprovedFact[];
  instants: readonly (number | null)[];
  derived?: readonly number[];
  questionNumbers?: readonly number[];
}): Set<number> {
  const allowed = new Set<number>();
  for (const fact of input.facts) {
    addDateParts(allowed, fact.validFrom);
    addDateParts(allowed, fact.validTo);
    if (fact.period) {
      const [year, month] = fact.period.split('-').map(Number);
      allowed.add(year);
      allowed.add(month);
    }
    const value = fact.value;
    switch (value.kind) {
      case 'money':
        allowed.add(value.amount);
        break;
      case 'accuracy':
        allowed.add(value.correct);
        allowed.add(value.total);
        allowed.add(accuracyPercent(value.correct, value.total));
        break;
      case 'holiday':
      case 'schedule':
      case 'text':
        for (const number of extractNumbers(value.text)) allowed.add(number);
        break;
    }
  }
  for (const instant of input.instants) addDateParts(allowed, instant);
  for (const number of input.derived ?? []) allowed.add(number);
  for (const number of input.questionNumbers ?? []) allowed.add(number);
  return allowed;
}

export function findUnsupportedNumbers(
  text: string,
  allowed: Set<number>,
): number[] {
  return extractNumbers(text).filter((number) => !allowed.has(number));
}

/** 답변에 허용 대상 외 식별자(다른 학생 코드·다른 학원명)가 있는지 검사한다. */
export function findForbiddenIdentifiers(
  text: string,
  options: { studentCodePattern: RegExp; allowedCodes: readonly string[] },
): string[] {
  const pattern = new RegExp(options.studentCodePattern.source, 'g');
  const allowed = new Set(
    options.allowedCodes.map((code) => code.toUpperCase()),
  );
  return [...text.toLowerCase().matchAll(pattern)]
    .map((match) => match[1].toUpperCase())
    .filter((code) => !allowed.has(code));
}
