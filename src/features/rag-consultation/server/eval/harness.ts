/**
 * RAG 상담 평가 실행기(개발·평가 전용). 모든 평가 자료를 같은 채점·안전 게이트·오류 단계 분류로 돌린다.
 *
 * 채점(문항 정답 = 아래 모두 만족)
 *  - 상태: 기대 상태 또는 alternatives 중 하나(문항 형식이 answered/abstained 만 쓰는 v1 유사어 100문항은 "보류 계열"을 하나로 본다)
 *  - must_include 전부 포함, must_not_include 없음(alternatives 의 must_include 는 그 대안에만 적용)
 *  - 답변·일부 답변이면 정답 근거 문서(source_ids) 중 하나 이상을 인용
 *  - 생성 호출 수 ≤ generation_budget_max
 * 안전 게이트(정답과 별도로 0건이어야 함): 다른 학원·미승인 초안·권한 밖 원생 자료가 검색 후보·모델 입력·인용에 있거나,
 *  답변에 권한 밖 원생 이름이 나오면 위반.
 * 오류 단계(틀린 문항만): guard(보안·정책 규칙 오탐), interpretation(질문 해석·주제 선택), retrieval(근거 미검색),
 *  sufficiency(근거를 찾고도 보류), selection(다른 문서 인용), binding(정답 문서지만 다른 행·반·기간 값),
 *  over_answer(답하면 안 되는데 답함), status(상태만 다름), verification(사후 검사 차단), generation(생성 예산).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACADEMIES_DIR,
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
  toAcademyDocumentInput,
  type AcademiesDataset,
  type AcademyCase,
  type BuildStoreOptions,
} from '../adapters/fixture/load-academies.ts';
import { toConversationState } from '../adapters/fixture/load-fixture.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
} from '../adapters/memory/index.ts';
import {
  GuardedGenerationProvider,
  MockGenerationProvider,
} from '../generation/providers.ts';
import type { CatalogPort, GenerationPort } from '../ports.ts';
import type { ObservationV2 } from './scoring-v2.ts';
import { mentionsName } from '../query/parse-query.ts';
import type { ChunkRanker } from '../retrieval/rankers.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import {
  createRagConsultationService,
  type RagConsultationDeps,
} from '../service.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { normalizeText } from '../text/normalize.ts';
import { parseInstant, toKstDate } from '../text/time.ts';

export const V2_DIR = join(ACADEMIES_DIR, '..', 'academies-v2');

export type NonAnswerMode = 'exact' | 'any_non_answer';

export interface EvalCase {
  id: string;
  suite: string;
  split: string;
  category: string;
  tags: string[];
  userId: string;
  query: string;
  asOf: string;
  history: string[];
  session: Record<string, unknown>;
  apiState: AcademyCase['input']['api_state'];
  expected: {
    status: string;
    alternatives: Array<{ status: string; mustInclude?: string[] }>;
    sourceIds: string[];
    mustInclude: string[];
    mustNotInclude: string[];
    generationBudgetMax: number;
  };
  nonAnswerMode: NonAnswerMode;
}

export interface Suite {
  name: string;
  dataset: AcademiesDataset;
  cases: EvalCase[];
}

const NON_ANSWER = new Set(['abstained', 'clarify', 'denied', 'handoff']);

function fromAcademyCase(suite: string, c: AcademyCase): EvalCase {
  return {
    id: c.case_id,
    suite,
    split: c.split,
    category: c.category,
    tags: c.tags ?? [],
    userId: c.input.user_id,
    query: c.input.query,
    asOf: c.input.as_of,
    history: (c.input.history ?? []).map((turn) => turn.query),
    session: c.input.session ?? {},
    apiState: c.input.api_state ?? 'ok',
    expected: {
      status: c.expected.status,
      alternatives: (c.expected.alternatives ?? []).map((alt) => ({
        status: alt.status,
        mustInclude: alt.must_include,
      })),
      sourceIds: c.expected.source_ids ?? [],
      mustInclude: c.expected.must_include ?? [],
      mustNotInclude: c.expected.must_not_include ?? [],
      generationBudgetMax: c.expected.generation_budget_max ?? 0,
    },
    nonAnswerMode: 'exact',
  };
}

interface ParaphraseItem {
  id: string;
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

export function loadHoldoutSuite(root: string): Suite {
  const name = 'holdout';
  const dataset = readAcademiesDataset(root);
  const cases = dataset.cases.map((entry) => fromAcademyCase(name, entry));
  if (!cases.length || cases.some((entry) => entry.split !== 'holdout'))
    throw new Error('Holdout requires nonempty case files with split=holdout');
  if (new Set(cases.map(({ id }) => id)).size !== cases.length)
    throw new Error('Holdout case IDs must be unique across academies');
  return { name, dataset, cases };
}

export function loadSuite(name: string): Suite {
  if (name === 'v1-90') {
    const dataset = readAcademiesDataset();
    return {
      name,
      dataset,
      cases: dataset.cases.map((c) => fromAcademyCase(name, c)),
    };
  }
  if (name === 'v1-paraphrase-100') {
    const dataset = readAcademiesDataset();
    const items = readFileSync(
      join(ACADEMIES_DIR, 'eval', 'middle-school-paraphrase.jsonl'),
      'utf-8',
    )
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ParaphraseItem);
    return {
      name,
      dataset,
      cases: items.map((item) => ({
        id: item.id,
        suite: name,
        split: 'dev',
        category: item.category,
        tags: [],
        userId: item.user_id,
        query: item.query,
        asOf: item.as_of,
        history: [],
        session: {},
        apiState: 'ok',
        expected: {
          status: item.expected.status,
          alternatives: [],
          sourceIds: [
            ...item.expected.source_ids,
            ...(item.expected.also_valid_source_ids ?? []),
          ],
          mustInclude: item.expected.must_include,
          mustNotInclude: item.expected.must_not_include ?? [],
          generationBudgetMax: 1,
        },
        nonAnswerMode: 'any_non_answer',
      })),
    };
  }
  if (name.startsWith('v2-')) {
    // v2-dev = 개발용 학원, v2-test = 미공개 평가 학원, v2-<ACADEMY_ID> = 학원 하나.
    // 다른 split 의 학원 폴더는 읽지도 않는다(개발 중 미공개 평가 자료를 건드리지 않기 위해).
    const split =
      name === 'v2-dev' ? 'dev' : name === 'v2-test' ? 'test' : null;
    const folders = readdirSync(V2_DIR)
      .filter((folder) => existsSync(join(V2_DIR, folder, 'cases.jsonl')))
      .filter((folder) => {
        if (!split) return folder === name.slice(3);
        const first = readFileSync(join(V2_DIR, folder, 'cases.jsonl'), 'utf-8')
          .split('\n')
          .find((line) => line.trim());
        return first
          ? (JSON.parse(first) as AcademyCase).split === split
          : false;
      });
    const dataset = readAcademiesDataset(V2_DIR, { folders });
    return {
      name,
      dataset,
      cases: dataset.cases.map((c) => fromAcademyCase(name, c)),
    };
  }
  throw new Error(`unknown suite ${name}`);
}

export interface Variant {
  id: string;
  /** rag: 검색 1위 청크를 그대로 답으로(생성·보류 없음) / engine: 상담 엔진 */
  kind: 'rag' | 'engine';
  engine?: RagConsultationDeps['engine'];
  ranker?: () => Promise<ChunkRanker> | ChunkRanker;
  config?: RagConsultationDeps['config'];
  /** rag 변형의 보류 규칙(없으면 검색 결과가 없을 때만 보류) */
  abstain?: (scores: number[]) => boolean;
}

export interface CaseResult {
  id: string;
  suite: string;
  split: string;
  category: string;
  tags: string[];
  expectedStatus: string;
  status: string;
  correct: boolean;
  checks: {
    status: boolean;
    mustInclude: boolean;
    mustNotInclude: boolean;
    citation: boolean;
    generation: boolean;
  };
  errorStage: string | null;
  violations: string[];
  cited: string[];
  goldRetrieved: boolean;
  sourceCoverage: {
    listed: string[];
    retrieved: string[];
    missingFromRetrieval: string[];
    missingFromCitations: string[];
    citedLocations: Array<{ sourceId: string; location?: string }>;
  };
  intent: string;
  internalErrors: string[];
  generationCalls: number;
  liveRequests?: number;
  generationPolicyBlocked?: boolean;
  generationMode?: 'gemini' | 'gemini-synthetic' | 'simulated_failure';
  latencyMs: number;
  answer: string;
}

function generationFor(apiState: EvalCase['apiState'], now: number) {
  const mock = new MockGenerationProvider(
    apiState === 'timeout' ? 'timeout' : 'ok',
  );
  const guarded = new GuardedGenerationProvider(mock);
  if (apiState === '429') guarded.block('rate_limited', now + 60_000);
  if (apiState === '5xx') guarded.block('unavailable', now + 60_000);
  if (apiState === 'quota_exhausted')
    guarded.block('quota_exhausted', now + 86_400_000);
  return guarded;
}

export interface PreparedSuite {
  suite: Suite;
  store: InMemoryRagStore;
  catalog: CatalogPort;
}

export async function prepareSuite(
  suite: Suite,
  variant: Variant,
  build: BuildStoreOptions = {},
): Promise<PreparedSuite> {
  const store = await buildAcademiesStore(
    suite.dataset,
    new InMemoryRagStore(
      variant.ranker ? { ranker: await variant.ranker() } : {},
    ),
    build,
  );
  return { suite, store, catalog: createAcademyCatalogPort(suite.dataset) };
}

const sourceOfChunk = (chunkId: string) => chunkId.split('#')[0];

export async function runCase(
  prepared: PreparedSuite,
  variant: Variant,
  c: EvalCase,
  diagnostics?: {
    refineFrame?: NonNullable<
      Parameters<typeof createRagConsultationService>[1]
    >['refineFrame'];
    observe?: (observation: ObservationV2) => void;
    captureWitnesses?: boolean;
    generation?: GenerationPort;
  },
): Promise<CaseResult> {
  const { dataset } = prepared.suite;
  const user = dataset.users.find((u) => u.user_id === c.userId);
  if (!user) throw new Error(`unknown user ${c.userId} (${c.id})`);
  const access = toAcademyAccessScope(user, dataset.students);
  const now = parseInstant(c.asOf);
  let status: string;
  let answer: string;
  let cited: string[];
  let touched: string[];
  let intent = variant.kind;
  let internalErrors: string[] = [];
  let generationPolicyBlocked: boolean | undefined;
  const generationInputs: string[] = [];
  const generationSources = new Set<string>();
  let latencyMs: number;
  let observed:
    | Pick<
        ObservationV2,
        | 'answer'
        | 'citationLocations'
        | 'citationWitnesses'
        | 'retrievedChunkIds'
        | 'retrievedSourceIds'
      >
    | undefined;

  if (variant.kind === 'rag') {
    const started = performance.now();
    const results = await prepared.store.searchApprovedChunks({
      access,
      studentIds: access.allowedStudentIds,
      asOf: now,
      query: c.query,
      limit: 10,
    });
    latencyMs = performance.now() - started;
    const scores = results.map((r) => r.score);
    const abstain =
      results.length === 0 || (variant.abstain?.(scores) ?? false);
    status = abstain ? 'abstained' : 'answered';
    answer = abstain ? '' : results[0].chunk.text;
    cited = abstain ? [] : [results[0].chunk.sourceId];
    touched = results.map((r) => r.chunk.sourceId);
  } else {
    const provider =
      (c.apiState === 'ok' ? diagnostics?.generation : undefined) ??
      generationFor(c.apiState, now);
    const conversations = new InMemoryConversationStore();
    if (Object.keys(c.session).length > 0) {
      const state = toConversationState(c.session, toKstDate(now).year);
      if (state) await conversations.save(access.actorId, c.id, state);
    }
    let citationLocations: ObservationV2['citationLocations'];
    let citationWitnesses: ObservationV2['citationWitnesses'];
    const service = createRagConsultationService(
      {
        facts: prepared.store,
        documents: prepared.store,
        catalog: prepared.catalog,
        generation: {
          providerId: provider.providerId,
          isExternal: provider.isExternal,
          personalDataApproved: provider.personalDataApproved,
          availability: (at) => provider.availability(at),
          generateGroundedAnswer(input, options) {
            generationInputs.push(JSON.stringify(input));
            for (const { sourceId } of [...input.facts, ...input.sources])
              generationSources.add(sourceId);
            return provider.generateGroundedAnswer(input, options);
          },
        },
        handoff: new InMemoryHandoffStore(),
        conversations,
        clock: new FixedClock(now),
        config: variant.config,
        engine: variant.engine,
      },
      diagnostics && {
        refineFrame: diagnostics.refineFrame,
        observeLocations: (citations) => {
          citationLocations = citations;
        },
        observeWitnesses: diagnostics.captureWitnesses
          ? (witnesses) => {
              citationWitnesses = witnesses;
            }
          : undefined,
      },
    );
    for (const turn of c.history) {
      await service.query({ access, question: turn, conversationId: c.id });
    }
    citationLocations = undefined;
    citationWitnesses = undefined;
    const started = performance.now();
    const output = await service.query({
      access,
      question: c.query,
      conversationId: c.id,
    });
    latencyMs = performance.now() - started;
    status = output.answer.status;
    answer = output.answer.answer;
    cited = output.answer.citations.map((citation) => citation.sourceId);
    const factSource = (id: string) => {
      const fact = dataset.facts.find((f) => f.fact_id === id);
      return fact
        ? `${fact.document_id}:r${fact.revision}:body`
        : `UNKNOWN_FACT:${id}`;
    };
    touched = [
      ...output.trace.retrievedChunkIds.map(sourceOfChunk),
      ...output.trace.retrievedFactIds.map(factSource),
      ...output.trace.generationInputSourceIds,
      ...generationSources,
      ...cited,
    ];
    observed = {
      answer: output.answer,
      citationLocations,
      citationWitnesses,
      retrievedChunkIds: output.trace.retrievedChunkIds,
      retrievedSourceIds: [
        ...output.trace.retrievedChunkIds.map(sourceOfChunk),
        ...output.trace.retrievedFactIds.map(factSource),
      ],
    };
    intent = output.trace.intent as typeof intent;
    internalErrors = output.trace.internalErrors;
    if (diagnostics?.generation && c.apiState === 'ok')
      generationPolicyBlocked =
        output.answer.handoff?.reasonCode ===
        'PERSONAL_DATA_TRANSFER_NOT_APPROVED';
  }
  const generationCalls = generationInputs.length;

  // 안전 게이트
  const violations: string[] = [];
  const documents = new Map(
    dataset.documents.map((d) => [
      `${d.meta.document_id}:r${d.meta.revision}:body`,
      d,
    ]),
  );
  for (const sourceId of new Set(touched)) {
    const document = documents.get(sourceId);
    if (!document) {
      violations.push(`unknown_source:${sourceId}`);
      continue;
    }
    const { academyId, visibility, studentId, classId } =
      toAcademyDocumentInput(document);
    if (academyId !== access.academyId)
      violations.push(`cross_academy:${sourceId}`);
    if (document.meta.status !== 'approved_active')
      violations.push(`draft:${sourceId}`);
    if (
      academyId === access.academyId &&
      !canReadRecord(
        access,
        {
          academyId,
          visibility,
          studentId: studentId ?? null,
          classId: classId ?? null,
        },
        access.allowedStudentIds,
      )
    ) {
      const violation = studentId
        ? 'unauthorized_student_doc'
        : 'unauthorized_document';
      violations.push(violation + ':' + sourceId);
    }
  }
  const normalized = normalizeText(answer);
  for (const student of dataset.students) {
    if (
      student.academy_id !== access.academyId ||
      access.allowedStudentIds.includes(student.student_id)
    )
      continue;
    for (const name of [student.name, ...student.aliases]) {
      if (name.length >= 2 && mentionsName(normalized, name))
        violations.push(`unauthorized_name:${student.student_id}`);
    }
    for (const input of generationInputs)
      if (input.includes(student.name))
        violations.push(`generation_input_name:${student.student_id}`);
  }

  if (observed)
    diagnostics?.observe?.({ ...observed, generationCalls, violations });

  // 채점
  const e = c.expected;
  const statusOptions = [
    { status: e.status, mustInclude: e.mustInclude },
    ...e.alternatives.map((alt) => ({
      status: alt.status,
      mustInclude: alt.mustInclude ?? [],
    })),
  ];
  const statusMatches = (expected: string) =>
    status === expected ||
    (c.nonAnswerMode === 'any_non_answer' &&
      NON_ANSWER.has(expected) &&
      NON_ANSWER.has(status));
  const option = statusOptions.find((o) => statusMatches(o.status));
  const gave = status === 'answered' || status === 'partial';
  const checks = {
    status: Boolean(option),
    mustInclude: option
      ? (option.mustInclude ?? []).every((p) => answer.includes(p))
      : e.mustInclude.every((p) => answer.includes(p)),
    mustNotInclude: e.mustNotInclude.every((p) => !answer.includes(p)),
    citation:
      !gave ||
      e.sourceIds.length === 0 ||
      cited.some((id) => e.sourceIds.includes(id)),
    generation: generationCalls <= e.generationBudgetMax,
  };
  const correct =
    violations.length === 0 && Object.values(checks).every(Boolean);
  const goldRetrieved = e.sourceIds.some((id) => touched.includes(id));

  let errorStage: string | null = null;
  if (!correct) {
    const expectsAnswer = e.status === 'answered' || e.status === 'partial';
    if (violations.length > 0) errorStage = 'guard';
    else if (
      internalErrors.some((x) =>
        ['NUMBER_UNSUPPORTED', 'CITATION_UNSUPPORTED', 'WRONG_ENTITY'].includes(
          x,
        ),
      )
    )
      errorStage = 'verification';
    else if (!checks.generation) errorStage = 'generation';
    else if (expectsAnswer && !gave) {
      if (
        status === 'denied' ||
        /causal|prediction|misattribution|citation_forgery/.test(intent)
      )
        errorStage = 'guard';
      else if (goldRetrieved) errorStage = 'sufficiency';
      else if (/general_info|unknown/.test(intent) || status === 'clarify')
        errorStage = 'interpretation';
      else errorStage = 'retrieval';
    } else if (expectsAnswer && gave) {
      if (!checks.citation)
        errorStage = goldRetrieved ? 'selection' : 'interpretation';
      else if (!checks.mustInclude || !checks.mustNotInclude)
        errorStage = 'binding';
      else errorStage = 'status';
    } else if (!expectsAnswer && gave) errorStage = 'over_answer';
    else errorStage = 'status';
  }
  return {
    id: c.id,
    suite: c.suite,
    split: c.split,
    category: c.category,
    tags: c.tags,
    expectedStatus: e.status,
    status,
    correct,
    checks,
    errorStage,
    violations: [...new Set(violations)],
    cited,
    goldRetrieved,
    sourceCoverage: {
      listed: e.sourceIds,
      retrieved: [...new Set(observed?.retrievedSourceIds ?? touched)],
      missingFromRetrieval: e.sourceIds.filter(
        (id) => !(observed?.retrievedSourceIds ?? touched).includes(id),
      ),
      missingFromCitations: e.sourceIds.filter((id) => !cited.includes(id)),
      citedLocations:
        observed?.answer.citations.map(({ sourceId, location }) => ({
          sourceId,
          location,
        })) ?? [],
    },
    intent,
    internalErrors,
    generationCalls,
    ...(generationPolicyBlocked !== undefined
      ? { generationPolicyBlocked }
      : {}),
    latencyMs,
    answer,
  };
}

const pct = (n: number, d: number) =>
  d === 0 ? null : Math.round((n / d) * 1000) / 10;
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(
      sorted[
        Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
      ] * 10,
    ) / 10
  );
}

export function summarize(results: CaseResult[]) {
  const count = (fn: (r: CaseResult) => boolean) => results.filter(fn).length;
  const answerable = results.filter(
    (r) => r.expectedStatus === 'answered' || r.expectedStatus === 'partial',
  );
  const unanswerable = results.filter(
    (r) => !(r.expectedStatus === 'answered' || r.expectedStatus === 'partial'),
  );
  const gave = (r: CaseResult) =>
    r.status === 'answered' || r.status === 'partial';
  const group = (key: (r: CaseResult) => string) => {
    const out: Record<
      string,
      { n: number; correct: number; accuracy: number | null }
    > = {};
    for (const r of results) {
      const k = key(r);
      out[k] ??= { n: 0, correct: 0, accuracy: null };
      out[k].n += 1;
      if (r.correct) out[k].correct += 1;
    }
    for (const v of Object.values(out)) v.accuracy = pct(v.correct, v.n);
    return out;
  };
  const stages: Record<string, number> = {};
  for (const r of results)
    if (r.errorStage) stages[r.errorStage] = (stages[r.errorStage] ?? 0) + 1;
  return {
    n: results.length,
    correct: count((r) => r.correct),
    accuracy: pct(
      count((r) => r.correct),
      results.length,
    ),
    answerable: answerable.length,
    falseAbstainRate: pct(
      answerable.filter((r) => !gave(r)).length,
      answerable.length,
    ),
    unanswerable: unanswerable.length,
    falseAnswerRate: pct(unanswerable.filter(gave).length, unanswerable.length),
    citationAccuracy: pct(
      answerable.filter((r) => gave(r) && r.checks.citation).length,
      answerable.filter(gave).length,
    ),
    contentAccuracy: pct(
      answerable.filter(
        (r) => gave(r) && r.checks.mustInclude && r.checks.mustNotInclude,
      ).length,
      answerable.filter(gave).length,
    ),
    violations: results.reduce((sum, r) => sum + r.violations.length, 0),
    violatingCases: results
      .filter((r) => r.violations.length > 0)
      .map((r) => `${r.id}:${r.violations.join(',')}`),
    generationCalls: results.reduce((sum, r) => sum + r.generationCalls, 0),
    latencyMs: {
      p50: percentile(
        results.map((r) => r.latencyMs),
        50,
      ),
      p95: percentile(
        results.map((r) => r.latencyMs),
        95,
      ),
    },
    errorStages: stages,
    byCategory: group((r) => r.category),
    byExpectedStatus: group((r) => r.expectedStatus),
    bySplit: group((r) => r.split),
  };
}

export function toCsv(results: CaseResult[]): string {
  const live = results.some(
    ({ generationMode }) => generationMode !== undefined,
  );
  const header = [
    'suite',
    'id',
    'split',
    'category',
    'expected_status',
    'status',
    'correct',
    'error_stage',
    'status_ok',
    'must_include_ok',
    'must_not_include_ok',
    'citation_ok',
    'generation_ok',
    'violations',
    'generation_calls',
    ...(live
      ? ['generation_mode', 'live_requests', 'generation_policy_blocked']
      : []),
    'latency_ms',
    'cited',
    'answer',
  ];
  const escape = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (
    [
      header.join(','),
      ...results.map((r) =>
        [
          r.suite,
          r.id,
          r.split,
          r.category,
          r.expectedStatus,
          r.status,
          r.correct,
          r.errorStage,
          r.checks.status,
          r.checks.mustInclude,
          r.checks.mustNotInclude,
          r.checks.citation,
          r.checks.generation,
          r.violations.join(' '),
          r.generationCalls,
          ...(live
            ? [r.generationMode, r.liveRequests, r.generationPolicyBlocked]
            : []),
          Math.round(r.latencyMs * 10) / 10,
          r.cited.join(' '),
          r.answer.replace(/\s+/g, ' ').slice(0, 300),
        ]
          .map(escape)
          .join(','),
      ),
    ].join('\n') + '\n'
  );
}
