/**
 * 개발용: 평가 문항 하나를 돌려 답변과 검색 상위 청크를 출력한다(개발 자료 전용 — 미공개 평가 문항에는 쓰지 않는다).
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/debug-case.ts \
 *     --suite v2-dev --case HK-D-014 [--query "질문 덮어쓰기"] [--variant engine]
 */
import { toAcademyAccessScope } from '../adapters/fixture/load-academies.ts';
import { parseInstant } from '../text/time.ts';
import { loadSuite, prepareSuite, runCase } from './harness.ts';
import { VARIANTS } from './variants.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const suiteName = option('suite', 'v2-dev') as string;
if (suiteName === 'v2-test' || /^v2-AC_(NURI|SEODAM|ONSAEM)$/.test(suiteName))
  throw new Error('미공개 평가 자료는 디버깅 도구로 열지 않습니다.');
const caseId = option('case');
const override = option('query');
const variant = VARIANTS[option('variant', 'engine') as string];
const suite = loadSuite(suiteName);
const found = suite.cases.find((c) => c.id === caseId);
if (!found) throw new Error(`case not found: ${caseId}`);
const c = override ? { ...found, query: override } : found;
const prepared = await prepareSuite(suite, variant, { ocr: null });
const result = await runCase(prepared, variant, c);
console.log(`Q: ${c.query}`);
console.log(
  `expected ${c.expected.status} / got ${result.status} (${result.intent}) correct=${result.correct} stage=${result.errorStage}`,
);
console.log(`A: ${result.answer}`);
console.log(`cited: ${result.cited.join(', ')}`);
const user = suite.dataset.users.find((u) => u.user_id === c.userId);
if (user) {
  const access = toAcademyAccessScope(user, suite.dataset.students);
  const top = await prepared.store.searchApprovedChunks({
    access,
    studentIds: access.allowedStudentIds,
    asOf: parseInstant(c.asOf),
    query: c.query,
    question: c.query,
    limit: 8,
  });
  console.log('\n검색 상위(원문 질문):');
  for (const { chunk, score } of top)
    console.log(
      `  ${score.toFixed(3)} ${chunk.chunkId} [${chunk.location.section ?? ''}] ${chunk.text.slice(0, 90).replace(/\n/g, ' ')}`,
    );
}
