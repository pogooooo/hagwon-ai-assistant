/**
 * 검색 신뢰도 기반 보류(기술 조사 0절 10번, 12.3.1 E18).
 * 상위 점수의 절대값만 보는 방식과, 1·2위 점수 간격(분포)을 보는 방식을 같은 검색기 안에서 비교한다.
 * 추가 모델 호출 없이 검색 점수만 쓴다. 학생·기간·권한 같은 하드 조건은 이 점수로 상쇄하지 않는다(서버 규칙이 우선).
 */
export interface RetrievalConfidence {
  /** 1위 점수 */
  top: number;
  /** 1위 - 2위 */
  gap: number;
  /** (1위 - 2위) / |1위|. BM25 처럼 점수 범위가 질문마다 다른 검색기용 */
  relativeGap: number;
}

export function retrievalConfidence(
  scores: readonly number[],
): RetrievalConfidence | null {
  if (scores.length === 0) return null;
  const [top, second = Number.NEGATIVE_INFINITY] = scores;
  const gap = Number.isFinite(second) ? top - second : Number.POSITIVE_INFINITY;
  const relativeGap =
    top === 0 ? 0 : Number.isFinite(gap) ? gap / Math.abs(top) : 1;
  return { top, gap, relativeGap };
}

export type AbstainRule =
  | { kind: 'absolute'; threshold: number }
  | { kind: 'relative_gap'; threshold: number };

/** 규칙에 따라 "검색 근거가 불확실하니 답하지 않음"이면 true. 결과가 없으면 항상 보류. */
export function shouldAbstain(
  scores: readonly number[],
  rule: AbstainRule,
): boolean {
  const confidence = retrievalConfidence(scores);
  if (!confidence) return true;
  return rule.kind === 'absolute'
    ? confidence.top < rule.threshold
    : confidence.relativeGap < rule.threshold;
}
