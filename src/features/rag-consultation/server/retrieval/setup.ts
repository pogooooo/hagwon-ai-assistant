/**
 * 운영 검색기 구성. 모델이 없거나 불러오지 못하면 BM25 만으로 동작한다(정형 상담은 계속 가능).
 * - dense: multilingual-e5-small(q8, 로컬 CPU). 사용자 원문 호출에만 하이브리드로 쓴다.
 * - reranker: bge-reranker-v2-m3(q8). 'auto' 면 1차 순위가 애매한 원문 호출에서만 돈다(무겁기 때문).
 */
import {
  Bm25Ranker,
  HybridRanker,
  RerankRanker,
  DenseRanker,
  type ChunkRanker,
} from './rankers.ts';

export interface RetrieverOptions {
  dense?: 'off' | 'on';
  reranker?: 'off' | 'on';
  semanticWeight?: number;
}

export interface RetrieverSetup {
  ranker: ChunkRanker;
  dense: boolean;
  reranker: boolean;
  loadMs: number;
  errors: string[];
}

export async function createRetriever(
  options: RetrieverOptions = {},
): Promise<RetrieverSetup> {
  const started = Date.now();
  const errors: string[] = [];
  const bm25 = new Bm25Ranker();
  let ranker: ChunkRanker = bm25;
  let dense = false;
  let reranker = false;
  if (options.dense === 'on') {
    try {
      const { createE5Embedder } =
        await import('../adapters/local-models/models.ts');
      ranker = new HybridRanker(
        bm25,
        new DenseRanker(await createE5Embedder()),
        {
          semanticWeight: options.semanticWeight ?? 2,
        },
      );
      dense = true;
    } catch (error) {
      errors.push(`dense: ${(error as Error).message}`);
    }
  }
  if (options.reranker === 'on') {
    try {
      const { createBgeReranker } =
        await import('../adapters/local-models/models.ts');
      ranker = new RerankRanker(ranker, await createBgeReranker(), 20);
      reranker = true;
    } catch (error) {
      errors.push(`reranker: ${(error as Error).message}`);
    }
  }
  return { ranker, dense, reranker, loadMs: Date.now() - started, errors };
}
