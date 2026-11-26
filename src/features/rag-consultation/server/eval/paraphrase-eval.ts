/**
 * 중학생 표현(유사어) 100문항: "기본 RAG" vs "기술 조사 문서의 검색 기법을 하나씩 적용한 RAG".
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     src/features/rag-consultation/server/eval/paraphrase-eval.ts [결과 이름]
 *
 * 비교하는 검색 구성(같은 저장소·같은 권한/승인/유효기간 필터, 순위 전략만 다름)
 *   R0 BM25(단어 + 한글 2-gram)                     — 기준선
 *   R1 BM25(Kiwi 형태소 + 카탈로그 사용자 사전)       — 조사 5.1절, E03/E25
 *   R2 Dense(multilingual-e5-small)                  — 조사 5.2절(단독은 참고용)
 *   R3 Hybrid RRF(R0 + R2, k=60)                     — 조사 5.3절, E04
 *   R4 Hybrid RRF(R1 + R2, k=60)
 *   R5 R4 상위 20개 → bge-reranker-v2-m3 재정렬       — 조사 6절, E07
 * 보류: 검색 점수 절대값 vs 1·2위 상대 간격(조사 0절 10번, E18). 임곗값은 dev 에서만 고르고 test 로 확인한다.
 *
 * 채점
 * - 검색: 정답 문서가 1위/상위 3·5위 안(hit@1·Recall@3·Recall@5), MRR@10
 * - RAG 답변: 1위 청크를 그대로 답으로 쓸 때 정답 문구 포함·금지 문구 없음. 보류 질문은 보류하면 정답.
 * - 엔진: 같은 검색 구성을 상담 엔진(규칙 라우팅·정형 조회·검증)에 꽂았을 때 상태·문구·인용이 맞는지.
 * - 정답 문서 = source_ids + also_valid_source_ids(작성자가 결과 보기 전에 notes 에 적어 둔 대체 문서).
 * - dev/test 는 문항 ID 의 sha256 으로 미리 나눈다. 이 실험에서 엔진 규칙·사전은 바꾸지 않는다.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACADEMIES_DIR,
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
} from '../adapters/fixture/load-academies.ts';
import {
  createBgeReranker,
  createE5Embedder,
  createKiwiTokenizer,
} from '../adapters/local-models/models.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
} from '../adapters/memory/index.ts';
import { MockGenerationProvider } from '../generation/providers.ts';
import { shouldAbstain, type AbstainRule } from '../retrieval/confidence.ts';
import {
  Bm25Ranker,
  DenseRanker,
  RerankRanker,
  RrfRanker,
  type ChunkRanker,
} from '../retrieval/rankers.ts';
import { createRagConsultationService } from '../service.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';

interface EvalItem {
  id: string;
  academy_id: string;
  user_id: string;
  as_of: string;
  category: string;
  query: string;
  expected: {
    status: 'answered' | 'abstained';
    source_ids: string[];
    also_valid_source_ids?: string[];
    must_include: string[];
    must_not_include?: string[];
  };
}

type Split = 'dev' | 'test';

interface RetrievalRow {
  id: string;
  split: Split;
  category: string;
  expected: 'answered' | 'abstained';
  rankOfGold: number | null;
  top1Correct: boolean;
  oracleTop3: boolean;
  scores: number[];
  top: string[];
  ms: number;
}

interface EngineRow {
  id: string;
  split: Split;
  category: string;
  expected: 'answered' | 'abstained';
  correct: boolean;
  status: string;
  cited: string[];
  answer: string;
  ms: number;
}

export function splitOf(id: string): Split {
  return createHash('sha256').update(id).digest()[0] % 2 === 0 ? 'dev' : 'test';
}

const includesAll = (text: string, phrases: readonly string[]) =>
  phrases.every((phrase) => text.includes(phrase));
const includesNone = (text: string, phrases: readonly string[] = []) =>
  phrases.every((phrase) => !text.includes(phrase));
const pct = (n: number, d: number) =>
  d === 0 ? '-' : `${Math.round((n / d) * 1000) / 10}%`;
const round = (value: number, digits = 3) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

/** dev 에서 맞힌 개수(답할 질문: 보류 안 하고 1위가 정답 / 보류 질문: 보류)가 가장 많은 임곗값. */
function calibrate(
  rows: RetrievalRow[],
  kind: AbstainRule['kind'],
): AbstainRule {
  const feature = (row: RetrievalRow) => {
    const [top = Number.NEGATIVE_INFINITY, second] = row.scores;
    if (kind === 'absolute') return top;
    if (second === undefined || top === 0) return 1;
    return (top - second) / Math.abs(top);
  };
  const candidates = [
    Number.NEGATIVE_INFINITY,
    ...new Set(rows.map(feature).filter(Number.isFinite)),
  ].sort((a, b) => a - b);
  let best: { threshold: number; correct: number } = {
    threshold: Number.NEGATIVE_INFINITY,
    correct: -1,
  };
  for (const threshold of candidates) {
    const rule = { kind, threshold } as AbstainRule;
    const correct = rows.filter((row) =>
      decide(row, rule) ? row.expected === 'abstained' : row.top1Correct,
    ).length;
    if (correct > best.correct) best = { threshold, correct };
  }
  return { kind, threshold: best.threshold } as AbstainRule;
}

function decide(row: RetrievalRow, rule: AbstainRule): boolean {
  return shouldAbstain(row.scores, rule);
}

async function main() {
  const label = process.argv[2] ?? 'techniques';
  const items = readFileSync(
    join(ACADEMIES_DIR, 'eval', 'middle-school-paraphrase.jsonl'),
    'utf-8',
  )
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalItem);
  const dataset = readAcademiesDataset();
  const catalogPort = createAcademyCatalogPort(dataset);

  // 카탈로그 기반 Kiwi 사용자 사전(반 이름·별칭·단원·유형을 띄어쓰기 단위로)
  const userWords: string[] = [];
  for (const academy of dataset.academies) {
    const catalog = await catalogPort.getAcademyCatalog(academy.academy_id);
    if (!catalog) continue;
    for (const name of [
      ...catalog.classes.flatMap((klass) => [klass.name, ...klass.aliases]),
      ...catalog.units,
      ...(catalog.questionTypes ?? []),
    ])
      userWords.push(...name.split(/[\s·,/()]+/));
  }

  const setup: Record<string, number> = {};
  let started = Date.now();
  const kiwi = await createKiwiTokenizer({ userWords });
  setup.kiwiBuildMs = kiwi.buildMs;
  started = Date.now();
  const embedder = await createE5Embedder();
  setup.e5LoadMs = Date.now() - started;
  started = Date.now();
  const reranker = await createBgeReranker();
  setup.rerankerLoadMs = Date.now() - started;

  const bm25 = new Bm25Ranker();
  const bm25Kiwi = new Bm25Ranker(kiwi);
  const dense = new DenseRanker(embedder);
  const configs: Array<{ key: string; name: string; ranker: ChunkRanker }> = [
    { key: 'R0', name: 'BM25(단어+2-gram, 기준선)', ranker: bm25 },
    { key: 'R1', name: 'BM25(Kiwi 형태소+사용자 사전)', ranker: bm25Kiwi },
    { key: 'R2', name: 'Dense(e5-small) 단독', ranker: dense },
    {
      key: 'R3',
      name: 'Hybrid RRF(R0+R2)',
      ranker: new RrfRanker([bm25, dense]),
    },
    {
      key: 'R4',
      name: 'Hybrid RRF(R1+R2)',
      ranker: new RrfRanker([bm25Kiwi, dense]),
    },
    {
      key: 'R5',
      name: 'R4 + bge 재정렬(상위 20)',
      ranker: new RerankRanker(new RrfRanker([bm25Kiwi, dense]), reranker, 20),
    },
  ];

  const report: Record<string, unknown> = { label, setup, configs: {} };
  const summaryLines: string[] = [];

  for (const config of configs) {
    const store = await buildAcademiesStore(
      dataset,
      new InMemoryRagStore({ ranker: config.ranker }),
    );
    const retrieval: RetrievalRow[] = [];
    const engine: EngineRow[] = [];
    for (const item of items) {
      const user = dataset.users.find((u) => u.user_id === item.user_id);
      if (!user) throw new Error(`unknown user ${item.user_id}`);
      const access = toAcademyAccessScope(user, dataset.students);
      const asOf = parseInstant(item.as_of);
      const answerable = item.expected.status === 'answered';
      const gold = [
        ...item.expected.source_ids,
        ...(item.expected.also_valid_source_ids ?? []),
      ];

      // 1) 기본 RAG 파이프라인(검색 → 1위 청크)
      let t = performance.now();
      const results = await store.searchApprovedChunks({
        access,
        studentIds: access.allowedStudentIds,
        asOf,
        query: item.query,
        limit: 10,
      });
      const retrievalMs = performance.now() - t;
      const top = results.map((result) => result.chunk);
      const goldIndex = top.findIndex((chunk) => gold.includes(chunk.sourceId));
      const top1 = top[0];
      retrieval.push({
        id: item.id,
        split: splitOf(item.id),
        category: item.category,
        expected: item.expected.status,
        rankOfGold: answerable && goldIndex >= 0 ? goldIndex + 1 : null,
        top1Correct:
          answerable &&
          Boolean(top1) &&
          gold.includes(top1.sourceId) &&
          includesAll(top1.text, item.expected.must_include) &&
          includesNone(top1.text, item.expected.must_not_include),
        oracleTop3:
          answerable &&
          includesAll(
            top
              .slice(0, 3)
              .filter((chunk) => gold.includes(chunk.sourceId))
              .map((chunk) => chunk.text)
              .join('\n'),
            item.expected.must_include,
          ) &&
          top.slice(0, 3).some((chunk) => gold.includes(chunk.sourceId)),
        scores: results.map((result) => result.score),
        top: top.slice(0, 3).map((chunk) => chunk.sourceId),
        ms: retrievalMs,
      });

      // 2) 같은 검색 구성을 꽂은 상담 엔진
      const service = createRagConsultationService({
        facts: store,
        documents: store,
        catalog: catalogPort,
        generation: new MockGenerationProvider('ok'),
        handoff: new InMemoryHandoffStore(),
        conversations: new InMemoryConversationStore(),
        clock: new FixedClock(asOf),
      });
      t = performance.now();
      const { answer } = await service.query({
        access,
        question: item.query,
        conversationId: item.id,
      });
      const engineMs = performance.now() - t;
      const cited = answer.citations.map((citation) => citation.sourceId);
      const gave = answer.status === 'answered' || answer.status === 'partial';
      engine.push({
        id: item.id,
        split: splitOf(item.id),
        category: item.category,
        expected: item.expected.status,
        correct: answerable
          ? answer.status === 'answered' &&
            includesAll(answer.answer, item.expected.must_include) &&
            includesNone(answer.answer, item.expected.must_not_include) &&
            cited.some((id) => gold.includes(id))
          : !gave,
        status: answer.status,
        cited,
        answer: answer.answer,
        ms: engineMs,
      });
    }

    // 보류 규칙(E18): dev 에서 임곗값을 고르고 전체·dev·test 에 적용
    const devRows = retrieval.filter((row) => row.split === 'dev');
    const rules = {
      none: null,
      absolute: calibrate(devRows, 'absolute'),
      relative_gap: calibrate(devRows, 'relative_gap'),
    };
    const ragCorrect = (row: RetrievalRow, rule: AbstainRule | null) => {
      const abstain = rule ? decide(row, rule) : row.scores.length === 0;
      return abstain ? row.expected === 'abstained' : row.top1Correct;
    };

    const answerableRows = retrieval.filter(
      (row) => row.expected === 'answered',
    );
    const retrievalMetrics = (rows: RetrievalRow[]) => {
      const answerableSubset = rows.filter(
        (row) => row.expected === 'answered',
      );
      const n = answerableSubset.length;
      const within = (k: number) =>
        answerableSubset.filter(
          (row) => row.rankOfGold !== null && row.rankOfGold <= k,
        ).length;
      return {
        answerable: n,
        hit1: within(1),
        recall3: within(3),
        recall5: within(5),
        mrr10: round(
          answerableSubset.reduce(
            (sum, row) => sum + (row.rankOfGold ? 1 / row.rankOfGold : 0),
            0,
          ) / (n || 1),
        ),
        top1Answer: answerableSubset.filter((row) => row.top1Correct).length,
        oracleTop3: answerableSubset.filter((row) => row.oracleTop3).length,
      };
    };
    const ragScores = (rows: RetrievalRow[]) =>
      Object.fromEntries(
        Object.entries(rules).map(([name, rule]) => [
          name,
          {
            correct: rows.filter((row) => ragCorrect(row, rule)).length,
            abstainedCorrect: rows.filter(
              (row) =>
                row.expected === 'abstained' &&
                (rule ? decide(row, rule) : row.scores.length === 0),
            ).length,
            falseAbstain: rows.filter(
              (row) =>
                row.expected === 'answered' &&
                rule !== null &&
                decide(row, rule),
            ).length,
          },
        ]),
      );
    const engineScores = (rows: EngineRow[]) => ({
      correct: rows.filter((row) => row.correct).length,
      answerableCorrect: rows.filter(
        (row) => row.expected === 'answered' && row.correct,
      ).length,
      abstainedCorrect: rows.filter(
        (row) => row.expected === 'abstained' && row.correct,
      ).length,
    });
    const bySplit = <T>(fn: (rows: RetrievalRow[]) => T) => ({
      total: fn(retrieval),
      dev: fn(retrieval.filter((row) => row.split === 'dev')),
      test: fn(retrieval.filter((row) => row.split === 'test')),
    });
    const engineBySplit = {
      total: engineScores(engine),
      dev: engineScores(engine.filter((row) => row.split === 'dev')),
      test: engineScores(engine.filter((row) => row.split === 'test')),
    };
    const categories = [...new Set(items.map((item) => item.category))].sort();
    const byCategory = Object.fromEntries(
      categories.map((category) => {
        const rows = answerableRows.filter((row) => row.category === category);
        return [
          category,
          {
            n: retrieval.filter((row) => row.category === category).length,
            recall3: rows.filter(
              (row) => row.rankOfGold !== null && row.rankOfGold <= 3,
            ).length,
            top1Answer: rows.filter((row) => row.top1Correct).length,
            engine: engine.filter(
              (row) => row.category === category && row.correct,
            ).length,
          },
        ];
      }),
    );
    const latency = {
      retrievalP50: round(
        percentile(
          retrieval.map((r) => r.ms),
          50,
        ),
        1,
      ),
      retrievalP95: round(
        percentile(
          retrieval.map((r) => r.ms),
          95,
        ),
        1,
      ),
      engineP50: round(
        percentile(
          engine.map((r) => r.ms),
          50,
        ),
        1,
      ),
      engineP95: round(
        percentile(
          engine.map((r) => r.ms),
          95,
        ),
        1,
      ),
    };
    (report.configs as Record<string, unknown>)[config.key] = {
      name: config.name,
      rankerId: config.ranker.id,
      retrieval: bySplit(retrievalMetrics),
      abstainRules: rules,
      rag: bySplit(ragScores),
      engine: engineBySplit,
      byCategory,
      latencyMs: latency,
      retrievalRows: retrieval,
      engineRows: engine.map((row) => ({
        ...row,
        answer: row.answer.slice(0, 400),
      })),
    };
    const r = retrievalMetrics(retrieval);
    const rag = ragScores(retrieval);
    const testRag = ragScores(retrieval.filter((row) => row.split === 'test'));
    summaryLines.push(
      [
        config.key.padEnd(3),
        config.name.padEnd(30),
        `hit@1 ${pct(r.hit1, r.answerable).padStart(6)}`,
        `R@3 ${pct(r.recall3, r.answerable).padStart(6)}`,
        `R@5 ${pct(r.recall5, r.answerable).padStart(6)}`,
        `MRR ${r.mrr10.toFixed(3)}`,
        `RAG(보류없음) ${rag.none.correct}`,
        `RAG+절대값 ${rag.absolute.correct}(test ${testRag.absolute.correct})`,
        `RAG+간격 ${rag.relative_gap.correct}(test ${testRag.relative_gap.correct})`,
        `엔진 ${engineBySplit.total.correct}(test ${engineBySplit.test.correct})`,
        `검색p95 ${latency.retrievalP95}ms 엔진p95 ${latency.engineP95}ms`,
      ].join(' | '),
    );
    console.log(summaryLines.at(-1));
  }
  report.e5 = embedder.stats();
  const outDir = join(ACADEMIES_DIR, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${label}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log('setup', JSON.stringify(setup), 'e5', JSON.stringify(report.e5));
}

await main();
