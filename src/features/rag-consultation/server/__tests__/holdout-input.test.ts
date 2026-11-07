import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { loadHoldoutSuite, prepareSuite, runCase } from '../eval/harness.ts';
import { scoreV3, type GoldV3 } from '../eval/scoring-v3.ts';
import { scoreV4, type GoldV4 } from '../eval/scoring-v4.ts';
import { auditHoldoutOverlap } from '../eval/holdout-overlap.ts';
import {
  automatedHoldoutGate,
  independentGate,
} from '../eval/holdout-review.ts';
import { readFixtureData } from '../adapters/fixture/load-fixture.ts';
import { VARIANTS } from '../eval/variants.ts';
import { toAcademyAccessScope } from '../adapters/fixture/load-academies.ts';

const academyId = 'AC_LOCAL_HOLDOUT';
const asOf = '2026-11-20T12:00:00+09:00';
const originals = join(
  import.meta.dirname,
  '..',
  '__fixtures__',
  'documents-v1',
  'documents',
);

function dataset(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'axr-holdout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const academy = join(root, academyId);
  const docs = join(academy, 'documents');
  mkdirSync(docs, { recursive: true });
  const json = (name: string, value: unknown) =>
    writeFileSync(join(academy, name), JSON.stringify(value), 'utf8');
  json('academy.json', {
    academy_id: academyId,
    display_name: '새 평가 학원',
    aliases: [],
    classes: [],
    units: [],
    question_types: [],
  });
  json('users.json', [
    {
      user_id: 'LOCAL_VISITOR',
      role: 'visitor',
      academy_id: academyId,
      allowed_student_ids: [],
      allowed_class_ids: [],
    },
  ]);
  json('students.json', []);
  writeFileSync(join(academy, 'facts.jsonl'), '');
  writeFileSync(
    join(academy, 'cases.jsonl'),
    JSON.stringify({
      case_id: 'INPUT-SMOKE',
      split: 'holdout',
      category: 'schedule',
      input: {
        user_id: 'LOCAL_VISITOR',
        query: '한빛초 후문 셔틀 1회차 등원은 몇 시에 와요?',
        as_of: asOf,
        session: {},
        api_state: 'ok',
      },
      expected: {
        status: 'answered',
        source_ids: ['SHUTTLE:r1:body'],
        must_include: ['한빛초 후문', '15:28'],
        must_not_include: ['15:20', '15:40', '17:58'],
        generation_budget_max: 0,
      },
    }) + '\n',
  );
  const manifest = (
    id: string,
    file: string,
    documentType: string,
    options: { visibility?: string; classId?: string } = {},
  ) =>
    json('documents/' + id + '.meta.json', {
      document_id: id,
      revision: 1,
      document_type: documentType,
      title: file,
      status: 'approved_active',
      visibility: options.visibility ?? 'academy_public',
      class_id: options.classId ?? null,
      student_id: null,
      valid_from: '2026-11-01T00:00:00+09:00',
      approved_at: '2026-11-01T00:00:00+09:00',
      valid_to: null,
      source_file: file,
    });
  return { root, docs, manifest };
}

test('외부 평가에서 DOCX·HWPX·Markdown 원본을 실제 등록 파서로 처리한다', async (t) => {
  const { root, docs, manifest } = dataset(t);
  copyFileSync(
    join(originals, 'PX_DOCX_SHUTTLE__r1.docx'),
    join(docs, '셔틀 원본.docx'),
  );
  copyFileSync(
    join(originals, 'PX_HWPX_REFUND__r1.hwpx'),
    join(docs, '환불 원본.hwpx'),
  );
  writeFileSync(
    join(docs, '자습실 원본.md'),
    '## 자습실 이용\n\n자습실 운영 시간은 15:00~18:00입니다.\n',
  );
  manifest('SHUTTLE', '셔틀 원본.docx', 'schedule');
  manifest('REFUND', '환불 원본.hwpx', 'policy');
  manifest('STUDY', '자습실 원본.md', 'facility');
  const suite = loadHoldoutSuite(root);
  assert.deepEqual(
    suite.dataset.documents.map((document) => document.source?.format).sort(),
    ['docx', 'hwpx', 'markdown'],
  );
  const variant = VARIANTS['engine-planned'];
  const prepared = await prepareSuite(suite, variant, {
    cache: false,
    ocr: null,
  });
  const { store } = prepared;
  const access = toAcademyAccessScope(suite.dataset.users[0], []);
  for (const [query, id, expected] of [
    ['한빛초 후문 15:28', 'SHUTTLE', /한빛초 후문.*15:28/],
    ['수강료 2/3 환불', 'REFUND', /수강료의 2\/3/],
    ['자습실 운영 시간', 'STUDY', /15:00~18:00/],
  ] as const) {
    const hits = await store.searchApprovedChunks({
      access,
      studentIds: [],
      asOf: Date.parse(asOf),
      query,
      limit: 25,
    });
    assert.ok(
      hits.some(
        ({ chunk }) => chunk.documentId === id && expected.test(chunk.text),
      ),
    );
  }
  const gold: GoldV3 = {
    status: 'answered',
    maxGenerationCalls: 0,
    forbidden: ['15:20', '15:40', '17:58'],
    slots: [
      {
        id: 'arrival',
        claim: ['한빛초 후문', '15:28'],
        answerSpans: ['정류장: 한빛초 후문 / 1회차 등원: 15:28'],
        evidence: [
          [
            {
              sourceId: 'SHUTTLE:r1:body',
              location: '1쪽 · 1. 노선별 시각 · 표 1 · 2행',
              columns: ['정류장', '1회차 등원'],
              witness: ['한빛초 후문', '15:28'],
            },
          ],
        ],
      },
    ],
  };
  const completeGold: GoldV4 = {
    ...gold,
    contextLines: [],
    slots: [
      ...gold.slots,
      {
        id: 'service_days',
        claim: ['평일에만', '토요일에는 운행하지'],
        answerSpans: [
          '셔틀버스는 평일에만 운행하며 토요일에는 운행하지 않습니다.',
        ],
        evidence: [
          [
            {
              sourceId: 'SHUTTLE:r1:body',
              location: '1쪽 · 1. 노선별 시각 · 문단 1',
              witness: ['평일에만', '토요일에는 운행하지'],
            },
          ],
        ],
      },
    ],
  };
  let strictResult: ReturnType<typeof scoreV3> | undefined;
  let completeResult: ReturnType<typeof scoreV4> | undefined;
  const result = await runCase(prepared, variant, suite.cases[0], {
    captureWitnesses: true,
    observe: (observation) => {
      strictResult = scoreV3(gold, observation);
      completeResult = scoreV4(completeGold, observation);
    },
  });
  assert.equal(result.correct, true, result.answer);
  assert.equal(strictResult?.correct, true, JSON.stringify(strictResult));
  assert.equal(
    completeResult?.correct,
    true,
    JSON.stringify({ completeResult, answer: result.answer }),
  );

  const out = mkdtempSync(join(tmpdir(), 'axr-holdout-results-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const labels = join(out, 'reviewed.json');
  writeFileSync(labels, JSON.stringify({ 'INPUT-SMOKE': completeGold }));
  const networkBlock = join(out, 'no-network.mjs');
  writeFileSync(
    networkBlock,
    "globalThis.fetch = async () => { throw Error('External network disabled in test'); };\n",
  );
  const runEvaluation = (label: string, key: string, ...options: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import',
        pathToFileURL(networkBlock).href,
        join(import.meta.dirname, '..', 'eval', 'run-eval.ts'),
        '--holdout-root',
        root,
        '--gold-v4',
        labels,
        '--out',
        out,
        '--label',
        label,
        '--no-ocr',
        ...options,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          RAG_MODEL_CACHE_DIR: join(out, 'cache'),
          RAG_GEMINI_API_KEY: key,
        },
        timeout: 30_000,
      },
    );
  const run = runEvaluation('smoke', '');
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  assert.match(run.stdout, /slot-v4 1\/1/);
  const summary = JSON.parse(
    readFileSync(join(out, 'smoke', 'summary.json'), 'utf8'),
  );
  assert.equal(summary.holdoutInputs.scoring, 'slot-v4');
  assert.equal(summary.holdoutInputs.generation, 'mock');
  assert.match(summary.holdoutInputs.goldSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(summary.runs[0].slotV4, { annotated: 1, correct: 1 });
  assert.equal(summary.runs[0].automatedGate.passed, true);
  assert.equal(summary.runs[0].automatedGate.inputStatus, 'known_overlap');
  assert.equal(summary.runs[0].independentGate.passed, false);
  assert.ok(summary.runs[0].independentGate.blockers.includes('known_overlap'));
  assert.ok(
    summary.runs[0].independentGate.blockers.includes('missing_review'),
  );
  const { overlap } = summary.holdoutInputs;
  assert.equal(overlap.status, 'known_overlap');
  assert.deepEqual(overlap.matchedAcademyIds, []);
  assert.deepEqual(overlap.matchedCaseIds, []);
  assert.ok(
    overlap.matchedDocuments.some(
      ({ sourceId, references }: { sourceId: string; references: string[] }) =>
        sourceId === 'SHUTTLE:r1:body' &&
        references.includes('documents-v1/documents/PX_DOCX_SHUTTLE__r1.docx'),
    ),
  );

  const rejected = runEvaluation(
    'overlap-rejected',
    '',
    '--reject-known-overlap',
  );
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(
    rejected.stderr,
    /reuses known academy IDs, case IDs or document content/,
  );
  assert.equal(existsSync(join(out, 'overlap-rejected')), false);

  const unsafe = runEvaluation(
    'synthetic-rejected',
    '',
    '--generation',
    'gemini-synthetic',
    '--max-live-calls',
    '1',
  );
  assert.equal(unsafe.status, 1, unsafe.stderr);
  assert.match(unsafe.stderr, /only accepts repository synthetic suites/);
  assert.equal(existsSync(join(out, 'synthetic-rejected')), false);

  const missingKey = runEvaluation(
    'missing-key',
    '',
    '--generation',
    'gemini',
    '--max-live-calls',
    '1',
  );
  assert.equal(missingKey.status, 1, missingKey.stderr);
  assert.match(missingKey.stderr, /requires RAG_GEMINI_API_KEY/);
  assert.equal(existsSync(join(out, 'missing-key')), false);

  const operational = runEvaluation(
    'gemini-policy',
    'fixture-transport-token',
    '--generation',
    'gemini',
    '--max-live-calls',
    '1',
  );
  assert.equal(operational.status, 0, operational.stderr);
  assert.match(operational.stdout, /slot-v4 1\/1/);
  const policy = JSON.parse(
    readFileSync(join(out, 'gemini-policy', 'summary.json'), 'utf8'),
  );
  assert.equal(policy.holdoutInputs.generation, 'gemini');
  assert.equal(policy.runs[0].generation.liveRequests, 0);
  assert.equal(policy.runs[0].generation.casesWithoutGeneration, 1);
  assert.equal(policy.runs[0].automatedGate.inputStatus, 'known_overlap');
});

test('독립 평가 사전 점검은 검수 기록을 원본·정답 해시에 묶고 중간에 바뀐 정답을 거부한다', (t) => {
  const { root, docs, manifest } = dataset(t);
  writeFileSync(
    join(docs, '새 셔틀 안내.md'),
    '<!-- page 1 -->\n\n## 노선표\n\n| 정류장 | 1회차 등원 |\n| --- | --- |\n| 한빛초 후문 | 15:28 |\n| 작은숲 도서관 | 15:44 |\n',
  );
  manifest('SHUTTLE', '새 셔틀 안내.md', 'schedule');
  const sourceManifest = join(docs, 'SHUTTLE.meta.json');
  const source = JSON.parse(readFileSync(sourceManifest, 'utf8'));
  delete source.student_id;
  delete source.class_id;
  writeFileSync(sourceManifest, JSON.stringify(source));
  const out = mkdtempSync(join(tmpdir(), 'axr-reviewed-holdout-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const labels = join(out, 'gold.json');
  const reviewed = join(out, 'review.json');
  const gold: GoldV4 = {
    status: 'answered',
    maxGenerationCalls: 0,
    contextLines: [],
    slots: [
      {
        id: 'arrival',
        claim: ['한빛초 후문', '15:28'],
        answerSpans: ['정류장: 한빛초 후문 / 1회차 등원: 15:28'],
        evidence: [
          [
            {
              sourceId: 'SHUTTLE:r1:body',
              location: '1쪽 · 노선표 · 표 1 · 1행',
              columns: ['정류장', '1회차 등원'],
              witness: ['한빛초 후문', '15:28'],
              exactWitness: ['정류장: 한빛초 후문 / 1회차 등원: 15:28'],
            },
          ],
        ],
      },
    ],
  };
  const run = (...options: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        join(import.meta.dirname, '..', 'eval', 'run-eval.ts'),
        '--holdout-root',
        root,
        '--gold-v4',
        labels,
        ...options,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, RAG_MODEL_CACHE_DIR: join(out, 'cache') },
        timeout: 30_000,
      },
    );

  writeFileSync(
    labels,
    JSON.stringify({ 'INPUT-SMOKE': { ...gold, slots: [] } }),
  );
  const invalid = run('--holdout-preflight');
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /invalid slot-v4 annotation for INPUT-SMOKE/i);
  assert.equal(existsSync(join(out, 'cache')), false);

  writeFileSync(labels, JSON.stringify({ 'INPUT-SMOKE': gold }));
  const preflight = run('--holdout-preflight');
  assert.equal(
    preflight.status,
    0,
    preflight.stderr || preflight.error?.message,
  );
  const inputs = JSON.parse(preflight.stdout);
  assert.deepEqual(inputs.caseIds, ['INPUT-SMOKE']);
  assert.equal(inputs.overlap.status, 'human_review_required');
  assert.equal(existsSync(join(out, 'cache')), false);
  const review = {
    version: 1,
    datasetSha256: inputs.datasetSha256,
    goldSha256: inputs.goldSha256,
    engineSha256: inputs.engineSha256,
    reviewedBy: 'fixture-review',
    reviewedAt: '2026-11-20T13:00:00+09:00',
    reviewedCaseIds: inputs.caseIds,
    reviewedRepeatedCaseIds: inputs.overlap.repeatedConversationCaseIds,
    independentInputs: true,
  };
  writeFileSync(reviewed, JSON.stringify(review));

  const complete = run(
    '--review-manifest',
    reviewed,
    '--out',
    out,
    '--label',
    'reviewed',
    '--variant',
    'engine,engine-planned',
  );
  assert.equal(complete.status, 0, complete.stderr || complete.error?.message);
  const summary = JSON.parse(
    readFileSync(join(out, 'reviewed', 'summary.json'), 'utf8'),
  );
  const baseline = summary.runs[0];
  const candidate = summary.runs[1];
  assert.equal(candidate.automatedGate.passed, true);
  assert.deepEqual(candidate.independentGate, {
    passed: false,
    blockers: ['insufficient_cases', 'insufficient_academies'],
  });
  assert.equal(summary.holdoutComparison.cases, 1);
  assert.equal(
    summary.holdoutComparison.correctDelta,
    1 - baseline.slotV4.correct,
  );
  assert.equal(summary.holdoutInputs.review.reviewedBy, 'fixture-review');
  assert.deepEqual(summary.holdoutInputs.caseCountsByAcademy, {
    [academyId]: 1,
  });

  writeFileSync(
    reviewed,
    JSON.stringify({ ...review, engineSha256: '0'.repeat(64) }),
  );
  const staleCode = run(
    '--review-manifest',
    reviewed,
    '--out',
    out,
    '--label',
    'stale-code',
  );
  assert.equal(staleCode.status, 1, staleCode.stderr);
  assert.match(
    staleCode.stderr,
    /does not match the frozen evaluation code hash/,
  );
  assert.equal(existsSync(join(out, 'stale-code')), false);

  writeFileSync(
    reviewed,
    JSON.stringify({ ...review, reviewedCaseIds: ['UNRELATED'] }),
  );
  const incomplete = run(
    '--review-manifest',
    reviewed,
    '--out',
    out,
    '--label',
    'incomplete',
  );
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.match(incomplete.stderr, /cover every holdout case/);
  assert.equal(existsSync(join(out, 'incomplete')), false);
  writeFileSync(reviewed, JSON.stringify(review));

  writeFileSync(labels, JSON.stringify({ 'INPUT-SMOKE': gold }) + '\n');
  const changed = run(
    '--review-manifest',
    reviewed,
    '--out',
    out,
    '--label',
    'changed',
  );
  assert.equal(changed.status, 1, changed.stderr);
  assert.match(
    changed.stderr,
    /does not match the frozen holdout and gold hashes/,
  );
  assert.equal(existsSync(join(out, 'changed')), false);
});

test('독립 판정은 3개 학원과 300문항에서 95% 이상이어야 한다', () => {
  const eligible = {
    slotV4: true,
    caseCount: 300,
    academyCount: 3,
    knownOverlap: false,
    reviewed: true,
    mockGeneration: false,
    violations: 0,
    correct: 285,
    minimumCorrect: 285,
  };
  assert.deepEqual(independentGate(eligible), { passed: true, blockers: [] });
  assert.deepEqual(independentGate({ ...eligible, reviewed: false }), {
    passed: false,
    blockers: ['missing_review'],
  });
  assert.deepEqual(automatedHoldoutGate(eligible), {
    passed: true,
    blockers: [],
  });
  assert.deepEqual(
    automatedHoldoutGate({ ...eligible, correct: 284, knownOverlap: true }),
    { passed: false, blockers: ['known_overlap', 'below_target'] },
  );
  assert.deepEqual(independentGate({ ...eligible, correct: 284 }), {
    passed: false,
    blockers: ['below_target'],
  });
  assert.deepEqual(
    independentGate({ ...eligible, mockGeneration: true, violations: 1 }),
    {
      passed: false,
      blockers: ['mock_generation_used', 'safety_violation'],
    },
  );
});

test('평가 안전 게이트는 권한 밖 반과 교직원 전용 자료가 검색 결과에 섞이면 검출한다', async (t) => {
  const { root, docs, manifest } = dataset(t);
  for (const [id, visibility, classId] of [
    ['HIDDEN_CLASS', 'class_members', 'CL_RESTRICTED'],
    ['HIDDEN_STAFF', 'staff_only', undefined],
  ] as const) {
    const file = id + '.md';
    writeFileSync(join(docs, file), '비공개 운영 시각은 18:20입니다.');
    manifest(id, file, 'schedule', { visibility, classId });
  }
  const suite = loadHoldoutSuite(root);
  const variant = { id: 'audit-probe', kind: 'rag' } as const;
  const prepared = await prepareSuite(suite, variant, {
    cache: false,
    ocr: null,
  });
  const visitor = toAcademyAccessScope(suite.dataset.users[0], []);
  const unsafeResults = await prepared.store.searchApprovedChunks({
    access: { ...visitor, role: 'admin', allowedClassIds: ['CL_RESTRICTED'] },
    studentIds: [],
    asOf: Date.parse(asOf),
    query: '비공개 운영 시각',
    limit: 10,
  });
  assert.equal(unsafeResults.length, 2);
  for (const hit of unsafeResults) {
    prepared.store.searchApprovedChunks = async () => [hit];
    const result = await runCase(prepared, variant, suite.cases[0]);
    assert.deepEqual(result.violations, [
      'unauthorized_document:' + hit.chunk.sourceId,
    ]);
    assert.equal(result.correct, false);
  }
});

test('같은 질문은 문항 이름을 바꿔도 표시하고 원본 신규성은 별도로 확인한다', (t) => {
  const { root, docs, manifest } = dataset(t);
  writeFileSync(
    join(docs, '단독 안내.md'),
    '그루터기반 설명회는 별빛관 서재에서 진행합니다.',
  );
  manifest('NEW_NOTICE', '단독 안내.md', 'announcement');
  const suite = loadHoldoutSuite(root);
  const known = readFixtureData();
  const copied = known.cases[0];
  suite.cases[0].query = copied.input.query.replace(/[?？.!]+$/, '') + ' ?';
  const fixtures = join(import.meta.dirname, '..', '__fixtures__');
  const result = auditHoldoutOverlap(suite, fixtures);
  assert.equal(result.status, 'human_review_required');
  assert.deepEqual(result.repeatedConversationCaseIds, ['INPUT-SMOKE']);
  assert.deepEqual(result.matchedDocuments, []);

  suite.cases[0].id = copied.case_id;
  const identified = auditHoldoutOverlap(suite, fixtures);
  assert.equal(identified.status, 'known_overlap');
  assert.deepEqual(identified.matchedCaseIds, [copied.case_id]);

  const copiedText = known.documents[0];
  writeFileSync(
    join(docs, '새 문서.markdown'),
    copiedText.text.replace(/\s+/g, '  '),
  );
  manifest('RENAMED', '새 문서.markdown', 'policy');
  const byBody = auditHoldoutOverlap(loadHoldoutSuite(root), fixtures);
  assert.equal(byBody.status, 'known_overlap');
  assert.deepEqual(byBody.matchedCaseIds, []);
  assert.ok(
    byBody.matchedDocuments.some(
      ({ sourceId, references }) =>
        sourceId === 'RENAMED:r1:body' &&
        references.includes('axr-synthetic-v1/' + copiedText.document_id),
    ),
  );
});

test('외부 평가 파일 지정은 documents 폴더 밖 경로를 허용하지 않는다', (t) => {
  const { root, manifest } = dataset(t);
  manifest('INVALID', '../other.docx', 'schedule');
  assert.throws(() => loadHoldoutSuite(root), /지원되는 원본 파일 이름/);
});
