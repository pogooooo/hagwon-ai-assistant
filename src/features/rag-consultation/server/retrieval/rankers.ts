/**
 * 검색 순위 전략(기술 조사 5~6절). 저장소가 권한·승인·유효기간 필터를 통과시킨 후보만 받아 순위를 매긴다.
 * 후보를 고르는 일(보안)은 저장소가, 순서를 정하는 일(품질)은 여기서 한다 — 어떤 전략도 후보를 늘리지 않는다.
 *
 * - Bm25Ranker: 기본(단어 + 한글 2-gram) 또는 주입한 토크나이저(예: Kiwi 형태소)로 BM25 (5.1절, E03)
 * - DenseRanker: 임베딩 코사인 유사도, 허용 후보 안에서 정확 계산(벡터 DB 없음, 5.2·5.4절)
 * - RrfRanker: 여러 순위의 Reciprocal Rank Fusion, k=60(조사 문서의 초기값, 5.3절, E04)
 * - RerankRanker: 앞 단계 상위 N개만 Cross-Encoder 로 재정렬(6절, E07/E17)
 *
 * 모델 실행 코드는 여기 없다(adapters/local-models). 이 파일은 외부 의존성이 없다.
 */
import { tokenize } from '../text/normalize.ts';
import type { RagChunk } from '../types.ts';
import { bm25Rank } from './bm25.ts';

/** 순위를 정한 근거 신호(근거 신뢰도 판단용). */
export interface RankSignals {
  lexicalRank?: number;
  denseRank?: number;
  /** 임베딩 코사인 유사도 */
  denseScore?: number;
  /** Cross-Encoder 로짓 */
  rerankScore?: number;
}

export interface RankedChunk {
  chunk: RagChunk;
  score: number;
  signals?: RankSignals;
}

/** 검색 호출 맥락: 의미 검색·재정렬은 사용자 원문(question)을, BM25 는 키워드 질의(query)를 쓴다. */
export interface RankContext {
  question?: string;
  rerank?: 'never' | 'auto' | 'always';
}

export interface ChunkRanker {
  /** 실험 기록용 이름 */
  readonly id: string;
  rank(
    candidates: readonly RagChunk[],
    query: string,
    context?: RankContext,
  ): Promise<RankedChunk[]>;
}

export interface TextTokenizer {
  readonly id: string;
  tokenize(text: string): string[];
}

/** BM25. 토크나이저를 주지 않으면 색인 시 만든 기본 토큰(chunk.tokens)을 그대로 쓴다. */
export class Bm25Ranker implements ChunkRanker {
  readonly id: string;
  private readonly cache = new WeakMap<RagChunk, string[]>();
  private readonly tokenizer: TextTokenizer | undefined;

  constructor(tokenizer?: TextTokenizer) {
    this.tokenizer = tokenizer;
    this.id = tokenizer ? `bm25:${tokenizer.id}` : 'bm25:default';
  }

  private tokensOf(chunk: RagChunk): readonly string[] {
    if (!this.tokenizer) return chunk.tokens;
    let tokens = this.cache.get(chunk);
    if (!tokens) {
      tokens = this.tokenizer.tokenize(chunk.contextualText);
      this.cache.set(chunk, tokens);
    }
    return tokens;
  }

  async rank(
    candidates: readonly RagChunk[],
    query: string,
  ): Promise<RankedChunk[]> {
    const queryTokens = this.tokenizer
      ? this.tokenizer.tokenize(query)
      : tokenize(query);
    return bm25Rank(
      candidates.map((chunk) => ({
        id: chunk.chunkId,
        tokens: this.tokensOf(chunk),
        chunk,
      })),
      queryTokens,
    ).map(({ document, score }) => ({ chunk: document.chunk, score }));
  }
}

export interface TextEmbedder {
  readonly id: string;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: readonly string[]): Promise<Float32Array[]>;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** 임베딩 코사인 유사도(벡터는 정규화되어 있다고 가정). 청크 객체별로 임베딩을 재사용한다. */
export class DenseRanker implements ChunkRanker {
  readonly id: string;
  private readonly cache = new WeakMap<RagChunk, Float32Array>();
  private readonly embedder: TextEmbedder;

  constructor(embedder: TextEmbedder) {
    this.embedder = embedder;
    this.id = `dense:${embedder.id}`;
  }

  async rank(
    candidates: readonly RagChunk[],
    query: string,
    context?: RankContext,
  ): Promise<RankedChunk[]> {
    if (candidates.length === 0) return [];
    const missing = candidates.filter((chunk) => !this.cache.has(chunk));
    if (missing.length > 0) {
      const vectors = await this.embedder.embedPassages(
        missing.map((chunk) => chunk.contextualText),
      );
      missing.forEach((chunk, index) => this.cache.set(chunk, vectors[index]));
    }
    const queryVector = await this.embedder.embedQuery(
      context?.question ?? query,
    );
    return candidates
      .map((chunk) => ({
        chunk,
        score: dot(queryVector, this.cache.get(chunk) as Float32Array),
      }))
      .sort(
        (a, b) =>
          b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId),
      );
  }
}

/** RRF(d) = Σ 1 / (k + rank_i(d)). 각 순위는 1부터 센다. */
export class RrfRanker implements ChunkRanker {
  readonly id: string;
  private readonly rankers: readonly ChunkRanker[];
  private readonly k: number;

  constructor(rankers: readonly ChunkRanker[], k = 60) {
    this.rankers = rankers;
    this.k = k;
    this.id = `rrf(${rankers.map((r) => r.id).join('+')};k=${k})`;
  }

  async rank(
    candidates: readonly RagChunk[],
    query: string,
    context?: RankContext,
  ): Promise<RankedChunk[]> {
    const fused = new Map<string, RankedChunk>();
    for (const ranker of this.rankers) {
      const ranked = await ranker.rank(candidates, query, context);
      ranked.forEach((entry, index) => {
        const previous = fused.get(entry.chunk.chunkId);
        const add = 1 / (this.k + index + 1);
        fused.set(entry.chunk.chunkId, {
          chunk: entry.chunk,
          score: (previous?.score ?? 0) + add,
        });
      });
    }
    return [...fused.values()].sort(
      (a, b) =>
        b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId),
    );
  }
}

export interface CrossEncoder {
  readonly id: string;
  /** (질문, 문서) 쌍의 관련도 점수. 클수록 관련 있음. */
  score(query: string, passages: readonly string[]): Promise<number[]>;
}

/**
 * 1차 순위가 애매한지(1·2위 점수 차가 작음): auto 재정렬은 이때만 무거운 Cross-Encoder 를 돌린다.
 * RRF 점수 기준 차이 0.002 ≈ 두 목록 순위가 한두 칸 차이인 경우.
 */
export function isAmbiguous(ranked: readonly RankedChunk[]): boolean {
  if (ranked.length < 2) return false;
  const [first, second] = ranked;
  if (
    first.chunk.sourceId === second.chunk.sourceId &&
    first.chunk.location.section === second.chunk.location.section
  )
    return false;
  return (
    first.score - second.score < Math.max(0.002, Math.abs(first.score) * 0.08)
  );
}

/** 앞 단계 상위 topN 만 Cross-Encoder 로 재정렬하고, 나머지는 원래 순서대로 뒤에 둔다. */
export class RerankRanker implements ChunkRanker {
  readonly id: string;
  private readonly base: ChunkRanker;
  private readonly encoder: CrossEncoder;
  private readonly topN: number;

  constructor(base: ChunkRanker, encoder: CrossEncoder, topN = 20) {
    this.base = base;
    this.encoder = encoder;
    this.topN = topN;
    this.id = `rerank(${base.id}→${encoder.id};top=${topN})`;
  }

  async rank(
    candidates: readonly RagChunk[],
    query: string,
    context?: RankContext,
  ): Promise<RankedChunk[]> {
    const ranked = await this.base.rank(candidates, query, context);
    const mode = context?.rerank ?? 'never';
    if (mode === 'never') return ranked;
    if (mode === 'auto' && !isAmbiguous(ranked)) return ranked;
    const head = ranked.slice(0, this.topN);
    if (head.length === 0) return ranked;
    // 재정렬 모델에는 키워드 묶음이 아니라 사용자 원문을 넣는다.
    const scores = await this.encoder.score(
      context?.question ?? query,
      head.map((entry) => entry.chunk.contextualText),
    );
    const reranked = head
      .map((entry, index) => ({
        chunk: entry.chunk,
        score: scores[index],
        signals: { ...entry.signals, rerankScore: scores[index] },
      }))
      .sort(
        (a, b) =>
          b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId),
      );
    return [...reranked, ...ranked.slice(this.topN)];
  }
}

/**
 * 하이브리드 순위(운영 기본 후보): 사용자 원문이 있는 호출(검색 기반 의도 판별·근거 답변)에서만 BM25(키워드)와
 * 임베딩(원문)을 가중 RRF 로 합친다. 원문이 없는 내부 키워드 검색은 BM25 그대로(기존 동작 유지).
 */
export class HybridRanker implements ChunkRanker {
  readonly id: string;
  private readonly lexical: ChunkRanker;
  private readonly semantic: ChunkRanker;
  private readonly semanticWeight: number;
  private readonly k: number;

  constructor(
    lexical: ChunkRanker,
    semantic: ChunkRanker,
    options: { semanticWeight?: number; k?: number } = {},
  ) {
    this.lexical = lexical;
    this.semantic = semantic;
    this.semanticWeight = options.semanticWeight ?? 1;
    this.k = options.k ?? 60;
    this.id = `hybrid(${lexical.id}+${semantic.id}×${this.semanticWeight};k=${this.k})`;
  }

  async rank(
    candidates: readonly RagChunk[],
    query: string,
    context?: RankContext,
  ): Promise<RankedChunk[]> {
    if (!context?.question)
      return this.lexical.rank(candidates, query, context);
    const fused = new Map<string, RankedChunk>();
    const add = (
      ranked: RankedChunk[],
      weight: number,
      kind: 'lexical' | 'dense',
    ) =>
      ranked.forEach((entry, index) => {
        const previous = fused.get(entry.chunk.chunkId);
        const signals: RankSignals = { ...previous?.signals };
        if (kind === 'lexical') signals.lexicalRank = index + 1;
        else {
          signals.denseRank = index + 1;
          signals.denseScore = entry.score;
        }
        fused.set(entry.chunk.chunkId, {
          chunk: entry.chunk,
          score: (previous?.score ?? 0) + weight / (this.k + index + 1),
          signals,
        });
      });
    add(
      await this.lexical.rank(
        candidates,
        `${query} ${context.question}`,
        context,
      ),
      1,
      'lexical',
    );
    add(
      await this.semantic.rank(candidates, query, context),
      this.semanticWeight,
      'dense',
    );
    return [...fused.values()].sort(
      (a, b) =>
        b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId),
    );
  }
}
