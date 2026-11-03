/**
 * 평가용 엔진 구성(개발·평가 전용). 같은 평가 자료·채점으로 비교한다.
 * - rag-bm25: 기본 RAG(BM25 검색 1위 청크를 그대로 답, 생성·보류 없음) — 기준선
 * - engine: 상담 엔진, 검색은 BM25 만(모델 없음)
 * - engine-dense: + multilingual-e5-small 하이브리드(사용자 원문 검색에만)
 * - engine-dense-rerank: + bge-reranker-v2-m3 조건부 재정렬(순위가 애매한 원문 검색에만)
 * 모델은 실행마다 한 번만 불러온다.
 */
import { createRetriever, type RetrieverSetup } from '../retrieval/setup.ts';
import type { Variant } from './harness.ts';

const cache = new Map<string, Promise<RetrieverSetup>>();
const retriever =
  (key: string, options: Parameters<typeof createRetriever>[0]) => async () => {
    if (!cache.has(key)) cache.set(key, createRetriever(options));
    const setup = await (cache.get(key) as Promise<RetrieverSetup>);
    if (setup.errors.length) throw new Error(setup.errors.join('; '));
    return setup.ranker;
  };

export const VARIANTS: Record<string, Variant> = {
  'rag-bm25': { id: 'rag-bm25', kind: 'rag' },
  engine: { id: 'engine', kind: 'engine' },
  'engine-planned': { id: 'engine-planned', kind: 'engine', engine: 'planned' },
  'engine-dense': {
    id: 'engine-dense',
    kind: 'engine',
    ranker: retriever('dense', { dense: 'on' }),
  },
  'engine-dense-rerank': {
    id: 'engine-dense-rerank',
    kind: 'engine',
    ranker: retriever('dense-rerank', { dense: 'on', reranker: 'on' }),
  },
};
