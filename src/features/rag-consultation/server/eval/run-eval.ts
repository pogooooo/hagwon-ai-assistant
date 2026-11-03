/**
 * 평가 실행 CLI(개발·평가 전용).
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/run-eval.ts \
 *     --suite v1-paraphrase-100,v1-90,v2-dev --variant rag-bm25,engine --label baseline [--out <폴더>] [--no-ocr]
 *
 * 결과: <out>/<label>/<suite>__<variant>.json(요약+문항별) · .csv(문항별) · summary.json(전체 요약, CPU·RAM 포함)
 * --gold-v2 <json>: 평가 문항 ID를 키로 하는 GoldV2 레코드. 각 슬롯에서 안쪽 배열은 모두 필요한 출처, 바깥 배열은 대체 가능한 출처 묶음이다.
 * 주석이 있는 문항만 별도의 __slot-v2.json에 채점하며 기존 요약과 CSV는 그대로 계산한다.
 * 기본 out = src/features/rag-consultation/server/__fixtures__/eval-results
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  loadSuite,
  prepareSuite,
  runCase,
  summarize,
  toCsv,
  type CaseResult,
  type Variant,
} from './harness.ts';
import { scoreV2, type GoldV2 } from './scoring-v2.ts';
import { VARIANTS } from './variants.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const suites = (option('suite') ?? 'v1-paraphrase-100').split(',');
const variantIds = (option('variant') ?? 'engine').split(',');
const label = option('label') ?? 'latest';
const outRoot =
  option('out') ??
  join(import.meta.dirname, '..', '__fixtures__', 'eval-results');
const goldPath = option('gold-v2');
if (args.includes('--gold-v2') && !goldPath)
  throw new Error('--gold-v2 requires an annotation file');
const goldByCase = goldPath
  ? new Map(
      Object.entries(
        JSON.parse(readFileSync(goldPath, 'utf8')) as Record<string, GoldV2>,
      ),
    )
  : undefined;
const noOcr = args.includes('--no-ocr');
const outDir = join(outRoot, label);
mkdirSync(outDir, { recursive: true });

const overall: Record<string, unknown> = {
  label,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  runs: [],
};
for (const suiteName of suites) {
  const suite = loadSuite(suiteName);
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
    const slotResults: Array<{
      id: string;
      score: ReturnType<typeof scoreV2>;
    }> = [];
    for (const c of suite.cases) {
      const gold = goldByCase?.get(c.id);
      if (gold && variant.kind !== 'engine')
        throw new Error(
          '--gold-v2 requires an engine variant for annotated cases',
        );
      results.push(
        await runCase(
          prepared,
          variant,
          c,
          gold
            ? {
                observe(observation) {
                  slotResults.push({
                    id: c.id,
                    score: scoreV2(gold, observation),
                  });
                },
              }
            : undefined,
        ),
      );
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const cpu = process.cpuUsage(cpuBefore);
    const summary = {
      suite: suiteName,
      variant: variantId,
      ...summarize(results),
      ...(goldByCase
        ? {
            slotV2: {
              annotated: slotResults.length,
              correct: slotResults.filter(({ score }) => score.correct).length,
            },
          }
        : {}),
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
        join(outDir, `${suiteName}__${variantId}__slot-v2.json`),
        `${JSON.stringify({ summary: summary.slotV2, results: slotResults }, null, 2)}\n`,
      );
    (overall.runs as unknown[]).push(summary);
    console.log(
      [
        suiteName.padEnd(18),
        variantId.padEnd(18),
        `정답 ${summary.correct}/${summary.n} (${summary.accuracy}%)`,
        `잘못된보류 ${summary.falseAbstainRate}%`,
        `잘못된응답 ${summary.falseAnswerRate}%`,
        `인용 ${summary.citationAccuracy}%`,
        `위반 ${summary.violations}`,
        `생성 ${summary.generationCalls}`,
        `p50/p95 ${summary.latencyMs.p50}/${summary.latencyMs.p95}ms`,
        `RSS ${summary.resources.rssPeakMb}MB`,
        `오류 ${JSON.stringify(summary.errorStages)}`,
      ].join(' | '),
    );
  }
}
writeFileSync(
  join(outDir, 'summary.json'),
  `${JSON.stringify(overall, null, 2)}\n`,
);
