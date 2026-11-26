/**
 * Development-only A/B/C/D probe. Labels are independent of the legacy cases.
 * B/D replace only the manually annotated intent and class slots. C/D rank
 * only labeled original rows among the store's already-authorized candidates.
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_RAG_CONFIG } from '../config.ts';
import { toAcademyAccessScope } from '../adapters/fixture/load-academies.ts';
import { Bm25Ranker, type ChunkRanker } from '../retrieval/rankers.ts';
import { compactText } from '../text/normalize.ts';
import { parseInstant } from '../text/time.ts';
import { loadSuite, prepareSuite, runCase, type Variant } from './harness.ts';
import { scoreV2, type GoldV2, type ObservationV2 } from './scoring-v2.ts';
import type { RagChunk } from '../types.ts';

interface RowLabel {
  sourceId: string;
  terms: string[];
  columns?: string[];
}

interface Annotation {
  id: string;
  topics: string[];
  classes: string[];
  slots: Array<{ id: string; claim: string[]; rows: RowLabel[] }>;
}

const row = (
  doc: string,
  terms: string[],
  columns?: string[],
  revision = 1,
): RowLabel => ({ sourceId: doc + ':r' + revision + ':body', terms, columns });

// Human-readable anchors refer to original development documents. No gold
// strings are appended to the query or copied into the answer.
const annotations: Annotation[] = [
  {
    id: 'HK-D-001',
    topics: ['location'],
    classes: [],
    slots: [
      {
        id: 'address',
        claim: ['은행나무로 45'],
        rows: [row('HK_INFO', ['항목: 주소', '은행나무로 45'])],
      },
      {
        id: 'subway',
        claim: ['3번 출구'],
        rows: [row('HK_INFO', ['항목: 지하철', '3번 출구'])],
      },
    ],
  },
  {
    id: 'HK-D-003',
    topics: ['hours'],
    classes: [],
    slots: [
      {
        id: 'sunday-closed',
        claim: ['일요일', '휴무'],
        rows: [row('HK_INFO', ['일요일·법정 공휴일', '휴무'])],
      },
    ],
  },
  {
    id: 'HK-D-009',
    topics: [],
    classes: ['HK_SCIHS'],
    slots: [
      {
        id: 'capacity',
        claim: ['과학고 대비반', '8명'],
        rows: [row('HK_INFO', ['과정: 과학고 대비반', '정원: 8명'], ['정원'])],
      },
      {
        id: 'entrance',
        claim: ['과학고 대비반', '선발 테스트'],
        rows: [row('HK_INFO', ['과학고 대비반은 선발 테스트를 거쳐'])],
      },
    ],
  },
  {
    id: 'HK-D-010',
    topics: [],
    classes: ['HK_E5_LAB', 'HK_E6_LAB'],
    slots: [
      {
        id: 'frequency-duration',
        claim: ['주 2회', '90분'],
        rows: [row('HK_FEE_2026', ['초등 실험탐구반', '주 2회', '90분'])],
      },
    ],
  },
  {
    id: 'HK-D-024',
    topics: [],
    classes: [],
    slots: [
      {
        id: 'period-and-return',
        claim: ['12월 18일', '12월 21일'],
        rows: [
          row('HK_TIMETABLE_EXAM', [
            '중1·중2 내신반',
            '12월 18일',
            '12월 21일',
          ]),
        ],
      },
    ],
  },
  {
    id: 'HK-D-050',
    topics: ['teacher'],
    classes: ['HK_M2_B'],
    slots: [
      {
        id: 'october-unit-result',
        claim: ['수권과 해수의 순환', '16문항'],
        rows: [
          row(
            'HK_RPT_S003_202610',
            ['수권과 해수의 순환', '16문항', '26문항'],
            undefined,
            2,
          ),
        ],
      },
      {
        id: 'class-teacher',
        claim: ['서지원'],
        rows: [row('HK_TEACHERS', ['중2 내신B반', '서지원', '화학'])],
      },
    ],
  },
  {
    id: 'HK-D-072',
    topics: ['fee'],
    classes: ['HK_M3_A', 'HK_M3_B', 'HK_SCIHS'],
    slots: [
      {
        id: 'two-fees',
        claim: ['수강료', '290,000원'],
        rows: [row('HK_FEE_2026', ['중3', '290,000원', '420,000원'])],
      },
      {
        id: 'science-fee',
        claim: ['수강료', '420,000원'],
        rows: [row('HK_FEE_2026', ['중3', '290,000원', '420,000원'])],
      },
    ],
  },
  {
    id: 'HK-D-121',
    topics: [],
    classes: ['HK_GIFTED'],
    slots: [
      {
        id: 'duration',
        claim: ['180분', '12시간'],
        rows: [row('HK_FEE_2026', ['영재원 대비반', '180분', '12시간'])],
      },
    ],
  },
];

const suite = loadSuite('v2-dev');
const bm25 = new Bm25Ranker();
let probe = false;
let goldIds: Set<string> | undefined;
let injectedCalls = 0;
const oracle: ChunkRanker = {
  id: 'dev-oracle',
  async rank(candidates, query) {
    if (probe) return candidates.map((chunk) => ({ chunk, score: 1 }));
    const selected =
      goldIds && candidates.filter((chunk) => goldIds?.has(chunk.chunkId));
    if (!selected?.length) return bm25.rank(candidates, query);
    injectedCalls += 1;
    // Use the ordinary ranker on the oracle set; retain a hit if BM25 has no
    // terms in common, without attaching semantic scores or changing content.
    const ranked = await bm25.rank(selected, query);
    const seen = new Set(ranked.map(({ chunk }) => chunk.chunkId));
    return [
      ...ranked,
      ...selected
        .filter((chunk) => !seen.has(chunk.chunkId))
        .map((chunk) => ({ chunk, score: 1 })),
    ];
  },
};
const planned = process.argv.includes('--planned');
const variant: Variant = {
  id: planned ? 'engine-planned' : 'engine',
  kind: 'engine',
  engine: planned ? 'planned' : 'legacy',
  ranker: () => oracle,
};
const prepared = await prepareSuite(suite, variant);
const results: Array<{
  id: string;
  mode: 'A' | 'B' | 'C' | 'D';
  injectedCalls: number;
  legacy: Awaited<ReturnType<typeof runCase>>;
  strict: ReturnType<typeof scoreV2>;
  citations: ObservationV2['answer']['citations'];
  gold: GoldV2;
}> = [];
for (const annotation of annotations) {
  const item = suite.cases.find((entry) => entry.id === annotation.id);
  if (!item) throw new Error('Unknown dev case ' + annotation.id);
  const user = suite.dataset.users.find(
    (entry) => entry.user_id === item.userId,
  );
  if (!user) throw new Error('Missing dev user ' + item.userId);
  const access = toAcademyAccessScope(user, suite.dataset.students);
  probe = true;
  const candidates = await prepared.store.searchApprovedChunks({
    access,
    studentIds: access.allowedStudentIds,
    asOf: parseInstant(item.asOf),
    query: item.query,
    limit: Number.MAX_SAFE_INTEGER,
  });
  probe = false;
  const resolve = (ref: RowLabel) => {
    const matches = candidates.filter(
      ({ chunk }) =>
        chunk.sourceId === ref.sourceId &&
        ref.terms.every((term) =>
          compactText(chunk.text).includes(compactText(term)),
        ),
    );
    if (matches.length !== 1)
      throw new Error(
        annotation.id +
          ' non-unique row ' +
          JSON.stringify(ref) +
          ' -> ' +
          matches.map(({ chunk }) => chunk.location.label).join(', '),
      );
    const chunk: RagChunk = matches[0].chunk;
    return {
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      location: chunk.location.label,
      columns: ref.columns,
    };
  };
  const gold: GoldV2 = {
    status: 'answered',
    forbidden: item.expected.mustNotInclude,
    maxGenerationCalls: item.expected.generationBudgetMax,
    slots: annotation.slots.map(({ id, claim, rows }) => ({
      id,
      claim,
      evidence: [rows.map(resolve)],
    })),
  };
  for (const mode of ['A', 'B', 'C', 'D'] as const) {
    injectedCalls = 0;
    goldIds =
      mode === 'C' || mode === 'D'
        ? new Set(
            gold.slots.flatMap((slot) =>
              slot.evidence.flatMap((set) =>
                set.flatMap((ref) => (ref.chunkId ? [ref.chunkId] : [])),
              ),
            ),
          )
        : undefined;
    let observed: ObservationV2 | undefined;
    const legacy = await runCase(prepared, variant, item, {
      observe: (value) => {
        observed = value;
      },
      refineFrame:
        mode === 'B' || mode === 'D'
          ? () => ({
              classIds: annotation.classes,
              topics: DEFAULT_RAG_CONFIG.topics.filter((topic) =>
                annotation.topics.includes(topic.id),
              ),
            })
          : undefined,
    });
    if (!observed) throw new Error('Missing engine observation');
    results.push({
      id: item.id,
      mode,
      injectedCalls,
      legacy,
      strict: scoreV2(gold, observed),
      citations: observed.answer.citations,
      gold,
    });
  }
}
const summary = ['A', 'B', 'C', 'D'].map((mode) => {
  const cases = results.filter((result) => result.mode === mode);
  return {
    mode,
    cases: cases.length,
    v1: cases.filter((result) => result.legacy.correct).length,
    v2: cases.filter((result) => result.strict.correct).length,
    fulfilled: cases
      .flatMap((result) => result.strict.slots)
      .filter((slot) => slot.fulfilled).length,
    retrieved: cases
      .flatMap((result) => result.strict.slots)
      .filter((slot) => slot.retrieved).length,
    slots: cases.flatMap((result) => result.strict.slots).length,
    violations: cases.flatMap((result) => result.legacy.violations).length,
    casesWithInjection: cases.filter((result) => result.injectedCalls > 0)
      .length,
  };
});
console.table(summary);
writeFileSync(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    'oracle-results.json',
  JSON.stringify({ summary, results }, null, 2) + '\n',
);
