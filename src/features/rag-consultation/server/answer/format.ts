/** 템플릿 답변용 표기 함수(값은 모두 코드에서 확정된 사실에서만 가져온다). */
import type { ApprovedFact, FactValue } from '../types.ts';

export function formatKrw(amount: number): string {
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

/** 리포트 표기와 같게 정수 %로 반올림한다(비교 차이는 원값으로 계산 후 반올림). */
export function accuracyPercent(correct: number, total: number): number {
  return Math.round((correct / total) * 100);
}

export function exactPercent(correct: number, total: number): number {
  return (correct / total) * 100;
}

export function formatAccuracy(
  value: Extract<FactValue, { kind: 'accuracy' }>,
): string {
  return `${value.total}문항 중 ${value.correct}문항 정답(정답률 ${accuracyPercent(value.correct, value.total)}%)`;
}

export function factText(fact: ApprovedFact): string {
  switch (fact.value.kind) {
    case 'money':
      return formatKrw(fact.value.amount);
    case 'accuracy':
      return formatAccuracy(fact.value);
    case 'schedule':
    case 'text':
    case 'enrollment':
    case 'schedule_change':
      return fact.value.text;
    case 'weak_area':
      return `${fact.value.unit}: ${fact.value.text}`;
    default:
      return '';
  }
}

/** 받침 유무에 따라 조사를 고른다(은/는, 이/가, 과/와). */
export function josa(
  word: string,
  withBatchim: string,
  withoutBatchim: string,
): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 === 0 ? withoutBatchim : withBatchim;
  }
  if (/[0-9]$/.test(last)) {
    return /[013678]$/.test(last) ? withBatchim : withoutBatchim;
  }
  return withBatchim;
}
