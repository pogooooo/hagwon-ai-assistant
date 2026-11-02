/**
 * 중학생 표현(유사어) 질문 비교 실험: "검색만 하는 기본 RAG" vs "현재 상담 엔진".
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     src/features/rag-consultation/server/eval/paraphrase-eval.ts [결과 이름]
 *
 * 공정 비교 조건
 * - 두 방식 모두 같은 저장소·같은 권한/승인/유효기간 필터·같은 BM25(단어 + 한글 2-gram)를 쓴다.
 * - 기본 RAG: 질문 원문으로 상위 3개 청크 검색 → 1위 청크 원문을 답으로 사용(생성 모델 없음, 보류 기능 없음).
 *   참고 상한(oracle reader): 상위 3개 중 정답 문서 청크에 정답 문구가 모두 들어 있으면 "완벽한 생성 모델이면 맞힐 수 있었다"로 본다.
 * - 현재 엔진: 질의 해석·운영 사전·정형 사실·표 칸 선택·보류 판단·사후 검사 전체.
 * - 정답 문서: source_ids(작성 시 지정) + also_valid_source_ids(작성자가 notes 에 "같은 문구가 다른 문서에도 있음"이라 적은 경우).
 * - dev/test 는 문항 ID 해시로 미리 나눈다(결과를 보기 전에 고정). 사전 보완은 dev 실패만 보고 한다.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  ACADEMIES_DIR,
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
} from '../adapters/fixture/load-academies.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
} from '../adapters/memory/index.ts';
import { MockGenerationProvider } from '../generation/providers.ts';
import { createRagConsultationService } from '../service.ts';
import { parseInstant } from '../text/time.ts';

interface EvalItem {
  id: string;
  academy_id: string;
  user_id: string;
  as_of: string;
  category: string;
  canonical: string;
  variant_terms: string[];
  query: string;
  expected: {
    status: 'answered' | 'abstained';
    source_ids: string[];
    must_include: string[];
    must_not_include?: string[];
    also_valid_source_ids?: string[];
  };
}

interface Outcome {
  id: string;
  split: 'dev' | 'test';
  category: string;
  expected: string;
  baseline: {
    correct: boolean;
    hit1: boolean;
    hit3: boolean;
    oracle3: boolean;
    top1?: string;
  };
  system: {
    correct: boolean;
    containsAnswer: boolean;
    status: string;
    cited: string[];
    answer: string;
  };
}

const EVAL_FILE = join(ACADEMIES_DIR, 'eval', 'middle-school-paraphrase.jsonl');

export function splitOf(id: string): 'dev' | 'test' {
  return createHash('sha256').update(id).digest()[0] % 2 === 0 ? 'dev' : 'test';
}

const includesAll = (text: string, phrases: readonly string[]) =>
  phrases.every((phrase) => text.includes(phrase));
const includesNone = (text: string, phrases: readonly string[] = []) =>
  phrases.every((phrase) => !text.includes(phrase));

async function main() {
  const label = process.argv[2] ?? 'latest';
  const items = readFileSync(EVAL_FILE, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalItem);
  const dataset = readAcademiesDataset();
  const store = await buildAcademiesStore(dataset);
  const catalog = createAcademyCatalogPort(dataset);

  const outcomes: Outcome[] = [];
  for (const item of items) {
    const user = dataset.users.find(
      (candidate) => candidate.user_id === item.user_id,
    );
    if (!user) throw new Error(`unknown user ${item.user_id}`);
    const access = toAcademyAccessScope(user, dataset.students);
    const asOf = parseInstant(item.as_of);
    const answered = item.expected.status === 'answered';
    const acceptable = [
      ...item.expected.source_ids,
      ...(item.expected.also_valid_source_ids ?? []),
    ];

    // 기본 RAG
    const results = await store.searchApprovedChunks({
      access,
      studentIds: access.allowedStudentIds,
      asOf,
      query: item.query,
      limit: 3,
    });
    const top = results.map((result) => result.chunk);
    const top1 = top[0];
    const hit1 = Boolean(top1 && acceptable.includes(top1.sourceId));
    const hit3 = top.some((chunk) => acceptable.includes(chunk.sourceId));
    const oracleText = top
      .filter((chunk) => acceptable.includes(chunk.sourceId))
      .map((chunk) => chunk.text)
      .join('\n');
    const oracle3 =
      answered && hit3 && includesAll(oracleText, item.expected.must_include);
    const baselineCorrect = answered
      ? hit1 &&
        includesAll(top1?.text ?? '', item.expected.must_include) &&
        includesNone(top1?.text ?? '', item.expected.must_not_include)
      : top.length === 0;

    // 현재 엔진
    const service = createRagConsultationService({
      facts: store,
      documents: store,
      catalog,
      generation: new MockGenerationProvider('ok'),
      handoff: new InMemoryHandoffStore(),
      conversations: new InMemoryConversationStore(),
      clock: new FixedClock(asOf),
    });
    const { answer } = await service.query({
      access,
      question: item.query,
      conversationId: item.id,
    });
    const cited = answer.citations.map((citation) => citation.sourceId);
    const gave = answer.status === 'answered' || answer.status === 'partial';
    const containsAnswer =
      gave &&
      includesAll(answer.answer, item.expected.must_include) &&
      includesNone(answer.answer, item.expected.must_not_include);
    const systemCorrect = answered
      ? answer.status === 'answered' &&
        containsAnswer &&
        cited.some((id) => acceptable.includes(id))
      : !gave;

    outcomes.push({
      id: item.id,
      split: splitOf(item.id),
      category: item.category,
      expected: item.expected.status,
      baseline: {
        correct: baselineCorrect,
        hit1,
        hit3,
        oracle3,
        top1: top1?.sourceId,
      },
      system: {
        correct: systemCorrect,
        containsAnswer,
        status: answer.status,
        cited,
        answer: answer.answer,
      },
    });
  }

  const summarize = (rows: Outcome[]) => {
    const answeredRows = rows.filter((row) => row.expected === 'answered');
    const pct = (n: number, d: number) =>
      d === 0 ? '-' : `${Math.round((n / d) * 1000) / 10}%`;
    return {
      n: rows.length,
      baselineCorrect: pct(
        rows.filter((row) => row.baseline.correct).length,
        rows.length,
      ),
      baselineHit1: pct(
        answeredRows.filter((row) => row.baseline.hit1).length,
        answeredRows.length,
      ),
      baselineHit3: pct(
        answeredRows.filter((row) => row.baseline.hit3).length,
        answeredRows.length,
      ),
      baselineOracleTop3: pct(
        answeredRows.filter((row) => row.baseline.oracle3).length,
        answeredRows.length,
      ),
      systemCorrect: pct(
        rows.filter((row) => row.system.correct).length,
        rows.length,
      ),
      systemContainsAnswer: pct(
        answeredRows.filter((row) => row.system.containsAnswer).length,
        answeredRows.length,
      ),
      counts: {
        baseline: rows.filter((row) => row.baseline.correct).length,
        system: rows.filter((row) => row.system.correct).length,
      },
    };
  };
  const categories = [...new Set(outcomes.map((row) => row.category))].sort();
  const report = {
    label,
    total: summarize(outcomes),
    dev: summarize(outcomes.filter((row) => row.split === 'dev')),
    test: summarize(outcomes.filter((row) => row.split === 'test')),
    answered: summarize(outcomes.filter((row) => row.expected === 'answered')),
    abstained: summarize(
      outcomes.filter((row) => row.expected === 'abstained'),
    ),
    byCategory: Object.fromEntries(
      categories.map((category) => [
        category,
        summarize(outcomes.filter((row) => row.category === category)),
      ]),
    ),
    failures: outcomes
      .filter((row) => !row.system.correct)
      .map((row) => ({
        id: row.id,
        split: row.split,
        category: row.category,
        status: row.system.status,
        answer: row.system.answer.slice(0, 160),
      })),
  };
  const outDir = join(ACADEMIES_DIR, 'eval', 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${label}.json`),
    `${JSON.stringify({ ...report, outcomes }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      {
        label,
        total: report.total,
        dev: report.dev,
        test: report.test,
        answered: report.answered,
        abstained: report.abstained,
      },
      null,
      2,
    ),
  );
  console.log('byCategory', JSON.stringify(report.byCategory));
  console.log(`system failures: ${report.failures.length}`);
  for (const failure of report.failures)
    console.log(
      `  ${failure.id} [${failure.split}/${failure.category}] ${failure.status}: ${failure.answer.replace(/\n/g, ' ')}`,
    );
}

await main();
