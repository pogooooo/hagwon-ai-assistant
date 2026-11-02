/**
 * 검색 순위 전략(기술 조사 5~6절: Kiwi 토크나이저 주입 BM25, Dense, RRF, 재정렬, 점수 기반 보류) 단위 테스트.
 * 실제 모델 대신 가짜 임베더·Cross-Encoder 를 써서 모델 파일 없이 실행한다.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildAcademiesStore,
  readAcademiesDataset,
  toAcademyAccessScope,
} from '../adapters/fixture/load-academies.ts';
import { retrievalConfidence, shouldAbstain } from '../retrieval/confidence.ts';
import {
  Bm25Ranker,
  DenseRanker,
  RerankRanker,
  RrfRanker,
  type ChunkRanker,
  type CrossEncoder,
  type TextEmbedder,
} from '../retrieval/rankers.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';
import type { RagChunk } from '../types.ts';

function chunk(id: string, text: string): RagChunk {
  return {
    chunkId: id,
    sourceId: `${id}:r1:body`,
    documentId: id,
    revision: 1,
    academyId: 'AC_T',
    studentId: null,
    classId: null,
    documentType: 'academy_info',
    visibility: 'academy_public',
    validFrom: 0,
    validTo: null,
    title: id,
    location: { kind: 'paragraph', label: '문단 1' },
    text,
    contextualText: text,
    tokens: [],
    suspicious: false,
  };
}

/** 글자 집합 기반 가짜 임베딩(정규화) — 같은 글자가 많을수록 유사. */
const fakeEmbedder: TextEmbedder = {
  id: 'fake',
  async embedQuery(text) {
    return vectorOf(text);
  },
  async embedPassages(texts) {
    return texts.map(vectorOf);
  },
};
function vectorOf(text: string): Float32Array {
  const vector = new Float32Array(64);
  for (const char of text) vector[char.charCodeAt(0) % 64] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

const fixedRanker = (id: string, order: string[]): ChunkRanker => ({
  id,
  async rank(candidates) {
    return order
      .map((chunkId) => candidates.find((c) => c.chunkId === chunkId))
      .filter((c): c is RagChunk => Boolean(c))
      .map((c, index) => ({ chunk: c, score: 10 - index }));
  },
});

const candidates = [
  chunk('fee', '셔틀버스 이용료 왕복 35,000원'),
  chunk('route', '셔틀버스 A노선 정류장 시각표'),
  chunk('study', '자습실 운영 평일 14:00~22:00'),
];

describe('검색 순위 전략', () => {
  test('토크나이저를 주입한 BM25 는 같은 토크나이저로 질문과 문서를 자른다', async () => {
    const ranker = new Bm25Ranker({
      id: 'split',
      tokenize: (text) => text.split(/\s+/).filter(Boolean),
    });
    const ranked = await ranker.rank(candidates, '자습실 운영');
    assert.equal(ranked[0].chunk.chunkId, 'study');
    assert.equal(ranker.id, 'bm25:split');
  });

  test('Dense 는 허용 후보만 점수화하고 청크 임베딩을 한 번만 계산한다', async () => {
    let passageCalls = 0;
    const counting: TextEmbedder = {
      ...fakeEmbedder,
      async embedPassages(texts) {
        passageCalls += texts.length;
        return texts.map(vectorOf);
      },
    };
    const ranker = new DenseRanker(counting);
    await ranker.rank(candidates, '셔틀 이용료');
    const ranked = await ranker.rank(candidates.slice(0, 2), '셔틀 이용료');
    assert.equal(passageCalls, 3);
    assert.deepEqual(ranked.map((entry) => entry.chunk.chunkId).sort(), [
      'fee',
      'route',
    ]);
  });

  test('RRF 는 두 순위에서 모두 위에 있는 문서를 1위로 올린다(k=60)', async () => {
    // fee: 1/(60+2) + 1/(60+1), route: 1/(60+1) + 1/(60+3), study: 1/(60+3) + 1/(60+2)
    const rrf = new RrfRanker([
      fixedRanker('a', ['route', 'fee', 'study']),
      fixedRanker('b', ['fee', 'study', 'route']),
    ]);
    const ranked = await rrf.rank(candidates, 'q');
    assert.deepEqual(
      ranked.map((entry) => entry.chunk.chunkId),
      ['fee', 'route', 'study'],
    );
    assert.ok(Math.abs(ranked[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  });

  test('재정렬은 상위 N개만 다시 매기고 나머지 순서는 유지한다', async () => {
    const encoder: CrossEncoder = {
      id: 'fake-ce',
      async score(_query, passages) {
        return passages.map((text) => (text.includes('이용료') ? 5 : 0));
      },
    };
    const reranked = await new RerankRanker(
      fixedRanker('base', ['route', 'study', 'fee']),
      encoder,
      2,
    ).rank(candidates, '셔틀 요금');
    assert.deepEqual(
      reranked.map((entry) => entry.chunk.chunkId),
      ['route', 'study', 'fee'],
    );
    const all = await new RerankRanker(
      fixedRanker('base', ['route', 'study', 'fee']),
      encoder,
      3,
    ).rank(candidates, '셔틀 요금');
    assert.equal(all[0].chunk.chunkId, 'fee');
  });

  test('점수 기반 보류: 결과 없음은 항상 보류, 절대값·상대 간격 규칙', () => {
    assert.equal(shouldAbstain([], { kind: 'absolute', threshold: 0 }), true);
    assert.equal(
      shouldAbstain([3, 1], { kind: 'absolute', threshold: 2 }),
      false,
    );
    assert.equal(
      shouldAbstain([1.5], { kind: 'absolute', threshold: 2 }),
      true,
    );
    assert.deepEqual(retrievalConfidence([4, 3]), {
      top: 4,
      gap: 1,
      relativeGap: 0.25,
    });
    assert.equal(
      shouldAbstain([4, 3.9], { kind: 'relative_gap', threshold: 0.1 }),
      true,
    );
  });
});

describe('순위 전략을 바꿔도 권한 범위는 그대로', () => {
  test('주입한 전략은 권한 필터를 통과한 후보만 받는다', async () => {
    const seen: RagChunk[] = [];
    const spy: ChunkRanker = {
      id: 'spy',
      async rank(list) {
        seen.push(...list);
        return list.map((c) => ({ chunk: c, score: 1 }));
      },
    };
    const dataset = readAcademiesDataset();
    const store = await buildAcademiesStore(
      dataset,
      new InMemoryRagStore({ ranker: spy }),
    );
    const user = dataset.users.find((u) => u.user_id === 'GA_STUDENT_DOYUN');
    assert.ok(user);
    const access = toAcademyAccessScope(user, dataset.students);
    await store.searchApprovedChunks({
      access,
      studentIds: access.allowedStudentIds,
      asOf: parseInstant('2026-11-10T18:00:00+09:00'),
      query: '학원비 성적 리포트 셔틀',
      limit: 50,
    });
    assert.ok(seen.length > 0);
    assert.ok(seen.every((c) => c.academyId === 'AC_GAON'));
    assert.ok(
      seen.every(
        (c) =>
          c.studentId === null ||
          access.allowedStudentIds.includes(c.studentId),
      ),
    );
    assert.ok(seen.every((c) => !c.documentId.includes('DRAFT')));
  });
});
