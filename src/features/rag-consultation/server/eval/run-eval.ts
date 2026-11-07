/**
 * 평가 실행 CLI(개발·평가 전용).
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/run-eval.ts \
 *     --suite v1-paraphrase-100,v1-90,v2-dev --variant rag-bm25,engine --label baseline [--out <폴더>] [--no-ocr]
 *
 * 결과: <out>/<label>/<suite>__<variant>.json(요약+문항별) · .csv(문항별) · summary.json(전체 요약, CPU·RAM 포함)
 * --gold-v2 <json>: 평가 문항 ID를 키로 하는 GoldV2 레코드. 각 슬롯에서 안쪽 배열은 모두 필요한 출처, 바깥 배열은 대체 가능한 출처 묶음이다.
 * 주석이 있는 문항만 별도의 __slot-v2.json에 채점하며 기존 요약과 CSV는 그대로 계산한다.
 * --gold-v3 <json>: 검수자가 기록한 답변 구간과 인용 위치·원문을 함께 검사한다.
 * --gold-v4 <json>: 검수된 답변 줄과 실제 인용 근거를 확인한다. exactWitness 로 원문 전체도 검사할 수 있다.
 * --holdout-root <folder>: 외부 학원 데이터셋. --gold-v2, --gold-v3, --gold-v4 중 하나와 --out 이 필수다.
 * --holdout-preflight: 외부 입력과 v4 라벨 검사 및 해시 출력. 모델 호출과 결과 파일 작성 없이 끝난다.
 * --review-manifest <json>: 외부 입력과 v4 라벨을 검수한 기록. 독립 평가 판정에 필요하다.
 * --automated-holdout: 사람 검수 없는 외부 합성 평가. v4와 --reject-known-overlap이 필수다.
 * --contract-state: v4의 근거 검사에 abstained 응답의 공개 API 계약을 적용하는 slot-v4.1로 채점한다.
 * --generation gemini | gemini-synthetic: 명시적으로 외부 공급자 사용. --max-live-calls, --out 필수.
 * --reject-known-overlap: 외부 평가에서 기존 학원 ID, 문항 ID 또는 문서가 일치하면 실행을 중단한다.
 * 기본 out = src/features/rag-consultation/server/__fixtures__/eval-results
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  loadHoldoutSuite,
  loadSuite,
  prepareSuite,
  runCase,
  summarize,
  toCsv,
  type CaseResult,
  type Variant,
} from './harness.ts';
import { scoreV2, type GoldV2 } from './scoring-v2.ts';
import { scoreV3, type GoldV3 } from './scoring-v3.ts';
import { scoreV4, type GoldV4 } from './scoring-v4.ts';
import { auditHoldoutOverlap } from './holdout-overlap.ts';
import {
  automatedHoldoutGate,
  datasetDigest,
  evaluationCodeDigest,
  HOLDOUT_MIN_ACADEMIES,
  HOLDOUT_MIN_CASES,
  holdoutCoverage,
  independentGate,
  sha256,
  validateHoldoutGoldV4,
  validateHoldoutReview,
} from './holdout-review.ts';
import { VARIANTS } from './variants.ts';
import { createEvalGemini } from './live-generation.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const goldOptions = (['gold-v2', 'gold-v3', 'gold-v4'] as const).filter(
  (name) => args.includes('--' + name),
);
if (goldOptions.length > 1)
  throw new Error('Select one slot scoring version per run');
const goldOption = goldOptions[0] ?? 'gold-v2';
const strict = goldOption !== 'gold-v2';
const contractState = args.includes('--contract-state');
if (contractState && goldOption !== 'gold-v4')
  throw new Error('--contract-state requires --gold-v4');
const witnessVersion = contractState ? 'slot-v4.1' : 'slot-v4';
const slotVersion =
  goldOption === 'gold-v4'
    ? witnessVersion
    : goldOption.replace('gold-', 'slot-');
const slotKey =
  goldOption === 'gold-v4'
    ? contractState
      ? 'slotV41'
      : 'slotV4'
    : strict
      ? 'slotV3'
      : 'slotV2';
const goldPath = option(goldOption);
if (
  args.includes('--' + goldOption) &&
  (!goldPath || goldPath.startsWith('--'))
)
  throw new Error('--' + goldOption + ' requires an annotation file');
const holdoutOption = option('holdout-root');
if (
  args.includes('--holdout-root') &&
  (!holdoutOption || holdoutOption.startsWith('--'))
)
  throw new Error('--holdout-root requires a dataset folder');
const holdoutPreflight = args.includes('--holdout-preflight');
const reviewOption = option('review-manifest');
const automatedHoldout = args.includes('--automated-holdout');
if (
  automatedHoldout &&
  (reviewOption ||
    !holdoutOption ||
    goldOption !== 'gold-v4' ||
    !args.includes('--reject-known-overlap'))
)
  throw new Error(
    'Automated holdout requires --holdout-root, --gold-v4 and --reject-known-overlap, without --review-manifest',
  );
if (
  args.includes('--review-manifest') &&
  (!reviewOption || reviewOption.startsWith('--'))
)
  throw new Error('--review-manifest requires a JSON file');
if (
  (holdoutPreflight || reviewOption) &&
  (!holdoutOption || goldOption !== 'gold-v4')
)
  throw new Error(
    'Holdout preflight and review require --holdout-root and --gold-v4',
  );
if (
  holdoutOption &&
  (args.includes('--suite') ||
    !goldPath ||
    (!holdoutPreflight && !option('out')))
)
  throw new Error(
    '--holdout-root requires one --gold-v2, --gold-v3 or --gold-v4, and --out, without --suite',
  );
const generationMode = option('generation', 'mock');
if (
  generationMode !== 'mock' &&
  generationMode !== 'gemini' &&
  generationMode !== 'gemini-synthetic'
)
  throw new Error('--generation must be mock, gemini, or gemini-synthetic');
const liveMode = generationMode !== 'mock';
if (generationMode === 'gemini-synthetic' && holdoutOption)
  throw new Error('gemini-synthetic only accepts repository synthetic suites');
if (liveMode && (!option('out') || option('out')?.startsWith('--')))
  throw new Error('Gemini evaluation requires an explicit --out directory');
if (!liveMode && args.includes('--max-live-calls'))
  throw new Error('--max-live-calls requires Gemini evaluation');
const holdoutRoot = holdoutOption ? realpathSync(holdoutOption) : undefined;
const rejectOverlap = args.includes('--reject-known-overlap');
if (rejectOverlap && !holdoutRoot)
  throw new Error('--reject-known-overlap requires --holdout-root');
const suites = holdoutRoot
  ? ['holdout']
  : (option('suite') ?? 'v1-paraphrase-100').split(',');
const variantIds = (
  option('variant') ?? (holdoutRoot ? 'engine-planned' : 'engine')
).split(',');
if (liveMode && variantIds.some((id) => VARIANTS[id]?.kind !== 'engine'))
  throw new Error('Gemini evaluation requires engine variants');
const label = option('label') ?? 'latest';
const outRoot =
  option('out') ??
  join(import.meta.dirname, '..', '__fixtures__', 'eval-results');
const goldBytes = goldPath ? readFileSync(goldPath) : undefined;
const gold = goldBytes
  ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(goldBytes))
  : undefined;
if (goldBytes && (!gold || typeof gold !== 'object' || Array.isArray(gold)))
  throw new Error('Gold annotations must be a JSON object keyed by case ID');
const goldByCase = gold
  ? new Map(Object.entries(gold as Record<string, GoldV2 | GoldV3 | GoldV4>))
  : undefined;
const noOcr = args.includes('--no-ocr');
if (
  (holdoutRoot || liveMode) &&
  (!/^[a-z0-9._-]+$/i.test(label) || label === '.' || label === '..')
)
  throw new Error(
    'Use a single folder name for the holdout or Gemini result label',
  );
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
};
const fixtureRoot = realpathSync(
  join(import.meta.dirname, '..', '__fixtures__'),
);
if (
  holdoutRoot &&
  (inside(fixtureRoot, holdoutRoot) || inside(holdoutRoot, fixtureRoot))
)
  throw new Error('Use an external folder for holdout data');
const featureRoot = join(import.meta.dirname, '..', '..');
const codeDigest = () =>
  evaluationCodeDigest(
    featureRoot,
    join(featureRoot, '..', '..', '..', 'package-lock.json'),
  );
const frozen =
  holdoutRoot && goldBytes
    ? {
        datasetSha256: datasetDigest(holdoutRoot),
        goldSha256: sha256(goldBytes),
        engineSha256: codeDigest(),
        generation: generationMode,
        scoring: slotVersion,
      }
    : undefined;
const externalSuite = holdoutRoot ? loadHoldoutSuite(holdoutRoot) : undefined;
if (
  externalSuite &&
  (!goldByCase ||
    goldByCase.size !== externalSuite.cases.length ||
    externalSuite.cases.some(({ id }) => !goldByCase.has(id)))
)
  throw new Error(
    'Holdout requires exactly one ' +
      slotVersion +
      ' annotation for every case ID',
  );
const inputOverlap = externalSuite
  ? auditHoldoutOverlap(externalSuite, fixtureRoot)
  : undefined;
if (rejectOverlap && inputOverlap?.status === 'known_overlap')
  throw new Error(
    'Holdout reuses known academy IDs, case IDs or document content',
  );

if (externalSuite && goldOption === 'gold-v4' && goldByCase)
  validateHoldoutGoldV4(externalSuite, goldByCase);
const reviewPath = reviewOption ? realpathSync(reviewOption) : undefined;
if (holdoutRoot && reviewPath && inside(holdoutRoot, reviewPath))
  throw new Error('Keep the review manifest outside the frozen holdout folder');
const reviewBytes = reviewPath ? readFileSync(reviewPath) : undefined;
const caseIds = externalSuite?.cases.map(({ id }) => id) ?? [];
const coverage = externalSuite ? holdoutCoverage(externalSuite) : undefined;
const holdoutInputs = frozen
  ? {
      ...frozen,
      overlap:
        automatedHoldout && inputOverlap?.status === 'human_review_required'
          ? { ...inputOverlap, status: 'no_known_overlap' }
          : inputOverlap,
      caseCountsByAcademy: coverage,
      minimumCases: HOLDOUT_MIN_CASES,
      minimumAcademies: HOLDOUT_MIN_ACADEMIES,
      ...(automatedHoldout ? { assessmentMode: 'automated_holdout' } : {}),
    }
  : undefined;
const review =
  reviewBytes && frozen && inputOverlap
    ? validateHoldoutReview(
        reviewBytes,
        frozen,
        caseIds,
        inputOverlap.repeatedConversationCaseIds,
      )
    : undefined;
if (holdoutPreflight) {
  writeFileSync(
    1,
    JSON.stringify({ ...holdoutInputs, caseIds, review }, null, 2) + '\n',
  );
  process.exit(0);
}

const outDir = join(
  holdoutRoot || liveMode ? realpathSync(outRoot) : outRoot,
  label,
);
if ((holdoutRoot || liveMode) && inside(fixtureRoot, resolve(outDir)))
  throw new Error(
    'Write holdout or Gemini results outside the repository fixtures',
  );
if (holdoutRoot && inside(holdoutRoot, resolve(outDir)))
  throw new Error('Write holdout results outside the frozen inputs');

const live =
  generationMode === 'mock'
    ? undefined
    : createEvalGemini(
        generationMode,
        Number(option('max-live-calls')),
        process.env,
      );

if (holdoutRoot || live) mkdirSync(outDir);
else mkdirSync(outDir, { recursive: true });

const overall: Record<string, unknown> = {
  label,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  holdoutInputs: holdoutInputs ? { ...holdoutInputs, review } : undefined,
  runs: [],
};
const holdoutSlotV4 = new Map<string, number>();
const syntheticAcademies = new Set([
  'AC_DAON',
  'AC_GAON',
  'AC_SAESOL',
  'AC_ANCHOR_EVAL',
  'AC_ARCH_1',
  'AC_ARCH_2',
  'AC_ARCH_3',
  'AC_HANGYEOL',
  'AC_NURI',
  'AC_ONSAEM',
  'AC_SEODAM',
]);
for (const suiteName of suites) {
  const suite = externalSuite ?? loadSuite(suiteName);
  if (
    generationMode === 'gemini-synthetic' &&
    (!suite.cases.length ||
      suite.dataset.academies.some(
        ({ academy_id }) => !syntheticAcademies.has(academy_id),
      ))
  )
    throw new Error(
      'gemini-synthetic only accepts repository synthetic academies',
    );
  for (const variantId of variantIds) {
    const variant: Variant | undefined = VARIANTS[variantId];
    if (!variant) throw new Error(`unknown variant ${variantId}`);
    const memoryBefore = process.memoryUsage().rss;
    const buildStarted = performance.now();
    const prepared = await prepareSuite(
      suite,
      variant,
      noOcr ? { ocr: null } : {},
    );
    const buildMs = performance.now() - buildStarted;
    const cpuBefore = process.cpuUsage();
    let peakRss = process.memoryUsage().rss;
    const results: CaseResult[] = [];
    const liveRequestsBefore = live?.report().liveRequests ?? 0;
    const slotResults: Array<{
      id: string;
      score:
        | ReturnType<typeof scoreV2>
        | ReturnType<typeof scoreV3>
        | ReturnType<typeof scoreV4>;
    }> = [];
    for (const c of suite.cases) {
      const gold = goldByCase?.get(c.id);
      if (gold && variant.kind !== 'engine')
        throw new Error(
          'Slot scoring requires an engine variant for annotated cases',
        );
      const requestsBefore = live?.report().liveRequests ?? 0;
      const result = await runCase(
        prepared,
        variant,
        c,
        gold || live
          ? {
              generation: live?.provider,
              captureWitnesses: Boolean(gold && strict),
              observe: gold
                ? (observation) => {
                    slotResults.push({
                      id: c.id,
                      score:
                        goldOption === 'gold-v4'
                          ? scoreV4(gold as GoldV4, observation, witnessVersion)
                          : strict
                            ? scoreV3(gold as GoldV3, observation)
                            : scoreV2(gold, observation),
                    });
                  }
                : undefined,
            }
          : undefined,
      );
      if (live && generationMode !== 'mock') {
        result.liveRequests = live.report().liveRequests - requestsBefore;
        result.generationMode =
          c.apiState === 'ok' ? generationMode : 'simulated_failure';
      }
      results.push(result);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    if (
      holdoutRoot &&
      (datasetDigest(holdoutRoot) !== frozen?.datasetSha256 ||
        codeDigest() !== frozen?.engineSha256 ||
        !goldPath ||
        !goldBytes?.equals(readFileSync(goldPath)) ||
        (reviewPath && !reviewBytes?.equals(readFileSync(reviewPath))))
    )
      throw new Error(
        'Holdout inputs, annotations, review or evaluation code changed during evaluation',
      );
    const cpu = process.cpuUsage(cpuBefore);
    if (externalSuite && slotResults.length !== suite.cases.length)
      throw new Error('Incomplete holdout observations');
    const stats = summarize(results);
    const slotCorrect = slotResults.filter(({ score }) => score.correct).length;
    const slotSummary = { annotated: slotResults.length, correct: slotCorrect };
    const minimumCorrect = Math.ceil((95 * suite.cases.length) / 100);
    if (externalSuite && goldOption === 'gold-v4')
      holdoutSlotV4.set(variantId, slotCorrect);
    const gateInput = {
      slotV4: goldOption === 'gold-v4',
      caseCount: suite.cases.length,
      academyCount: Object.keys(coverage ?? {}).length,
      knownOverlap: inputOverlap?.status === 'known_overlap',
      mockGeneration:
        generationMode === 'mock' &&
        results.some(
          (result, index) =>
            suite.cases[index].apiState === 'ok' && result.generationCalls > 0,
        ),
      violations: stats.violations,
      correct: slotCorrect,
      minimumCorrect,
    };
    const summary = {
      suite: suiteName,
      variant: variantId,
      ...stats,
      ...(live
        ? {
            generation: {
              mode: generationMode,
              providerId: live.provider.providerId,
              liveRequests: live.report().liveRequests - liveRequestsBefore,
              casesWithLiveRequests: results.filter(
                (r) => (r.liveRequests ?? 0) > 0,
              ).length,
              casesWithoutGeneration: results.filter(
                (r) => r.generationCalls === 0,
              ).length,
              casesBlockedByPrivacyPolicy: results.filter(
                (r) => r.generationPolicyBlocked,
              ).length,
              simulatedFailureCases: results.filter(
                (r) => r.generationMode === 'simulated_failure',
              ).length,
            },
          }
        : {}),
      ...(externalSuite
        ? {
            automatedGate: {
              inputStatus: holdoutInputs?.overlap?.status,
              minimumCorrect,
              correct: slotCorrect,
              passed: slotCorrect >= minimumCorrect && stats.violations === 0,
            },
            automatedHoldoutGate: automatedHoldout
              ? automatedHoldoutGate(gateInput)
              : undefined,
            independentGate: automatedHoldout
              ? undefined
              : independentGate({ ...gateInput, reviewed: Boolean(review) }),
          }
        : {}),
      ...(goldByCase ? { [slotKey]: slotSummary } : {}),
      resources: {
        indexBuildMs: Math.round(buildMs),
        cpuMsTotal: Math.round((cpu.user + cpu.system) / 1000),
        cpuMsPerCase: Math.round(
          (cpu.user + cpu.system) / 1000 / Math.max(1, results.length),
        ),
        rssBeforeMb: Math.round(memoryBefore / 1048576),
        rssPeakMb: Math.round(peakRss / 1048576),
      },
    };
    writeFileSync(
      join(outDir, `${suiteName}__${variantId}.json`),
      `${JSON.stringify({ summary, results }, null, 2)}\n`,
    );
    writeFileSync(
      join(outDir, `${suiteName}__${variantId}.csv`),
      toCsv(results),
    );
    if (goldByCase)
      writeFileSync(
        join(outDir, `${suiteName}__${variantId}__${slotVersion}.json`),
        `${JSON.stringify({ summary: slotSummary, results: slotResults }, null, 2)}\n`,
      );
    (overall.runs as unknown[]).push(summary);
    console.log(
      [
        suiteName.padEnd(18),
        variantId.padEnd(18),
        `정답 ${summary.correct}/${summary.n} (${summary.accuracy}%)`,
        ...(goldByCase
          ? [`${slotVersion} ${slotCorrect}/${slotResults.length}`]
          : []),
        ...(summary.automatedHoldoutGate
          ? [
              `합성 자동 판정 ${summary.automatedHoldoutGate.passed ? 'pass' : summary.automatedHoldoutGate.blockers.join(',')}`,
            ]
          : []),
        ...(summary.independentGate
          ? [
              `독립 판정 ${summary.independentGate.passed ? 'pass' : summary.independentGate.blockers.join(',')}`,
            ]
          : []),
        `잘못된보류 ${summary.falseAbstainRate}%`,
        `잘못된응답 ${summary.falseAnswerRate}%`,
        `인용 ${summary.citationAccuracy}%`,
        `위반 ${summary.violations}`,
        `생성 ${summary.generationCalls}`,
        ...(summary.generation
          ? [`Gemini 요청 ${summary.generation.liveRequests}`]
          : []),
        `p50/p95 ${summary.latencyMs.p50}/${summary.latencyMs.p95}ms`,
        `RSS ${summary.resources.rssPeakMb}MB`,
        `오류 ${JSON.stringify(summary.errorStages)}`,
      ].join(' | '),
    );
  }
}
if (externalSuite) {
  const baseline = holdoutSlotV4.get('engine');
  const candidate = holdoutSlotV4.get('engine-planned');
  if (baseline !== undefined && candidate !== undefined) {
    const correctDelta = candidate - baseline;
    overall.holdoutComparison = {
      cases: externalSuite.cases.length,
      baseline: { variant: 'engine', correct: baseline },
      candidate: { variant: 'engine-planned', correct: candidate },
      correctDelta,
      percentagePointDelta:
        Math.round((1000 * correctDelta) / externalSuite.cases.length) / 10,
    };
  }
}
if (live) overall.generation = live.report();
writeFileSync(
  join(outDir, 'summary.json'),
  `${JSON.stringify(overall, null, 2)}\n`,
);
