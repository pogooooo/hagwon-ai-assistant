/**
 * 평가용 엔진 구성(개발·평가 전용). 같은 평가 자료·채점으로 비교한다.
 * - rag-bm25: 기본 RAG(BM25 검색 1위 청크를 그대로 답, 생성·보류 없음) — 기준선
 * - engine: 상담 엔진 기본 구성
 */
import type { Variant } from './harness.ts';

export const VARIANTS: Record<string, Variant> = {
  'rag-bm25': { id: 'rag-bm25', kind: 'rag' },
  engine: { id: 'engine', kind: 'engine' },
};
