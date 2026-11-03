import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';
import { runQuery } from './helpers.ts';

const asOf = '2026-11-03T12:00:00+09:00';
const scope: RagAccessScope = {
  actorId: 'visitor',
  academyId: 'AC_COST',
  role: 'visitor',
  allowedStudentIds: [],
  allowedClassIds: [],
  studentRefs: [],
  canViewPublicHistory: false,
};
const catalog: AcademyCatalog = {
  academyId: scope.academyId,
  displayName: '해솔공방',
  aliases: [],
  classes: [
    { classId: 'METAL', name: '금속 조형반', aliases: [] },
    { classId: 'WOOD', name: '목재 조형반', aliases: [] },
  ],
  units: [],
};
const table =
  '| 항목 | 금액 |\n|---|---|\n| 6주 교습비 | 190,000원 |\n| 실습 재료비 | 23,000원 |';
const question = '금속 조형반 교습비랑 재료비 각각 얼마죠?';

async function createFixture() {
  const store = new InMemoryRagStore();
  const register = async (
    documentId: string,
    text: string,
    classId: string | null = 'METAL',
    approve = true,
    validTo: string | null = null,
  ) => {
    await store.upsertIndexedRevision({
      approve,
      document: {
        academyId: scope.academyId,
        documentId,
        classId,
        revision: 1,
        documentType: 'fee',
        visibility: 'academy_public',
        title: '조형 수업 비용',
        validFrom: '2026-08-01T00:00:00+09:00',
        approvedAt: '2026-08-01T00:00:00+09:00',
        validTo,
        text,
      },
    });
  };
  const ask = (query = question) =>
    runQuery(
      {
        store,
        catalog: {
          async getAcademyCatalog() {
            return catalog;
          },
        },
        resolveScope: () => scope,
      },
      { engine: 'planned', userId: scope.actorId, asOf, question: query },
    );
  return { register, ask };
}

test('비용 행의 기간·값·열을 보존하고 미승인·만료·다른 반 자료를 제외한다', async () => {
  const { register, ask } = await createFixture();
  await register('ACTIVE', table);
  const distractor = table
    .replace('190,000', '999,000')
    .replace('23,000', '99,000');
  await register('OTHER_CLASS', distractor, 'WOOD');
  await register('UNAPPROVED', distractor, 'METAL', false);
  await register(
    'EXPIRED',
    distractor,
    'METAL',
    true,
    '2026-10-01T00:00:00+09:00',
  );
  const { answer, trace, generationCalls } = await ask();
  assert.equal(trace.intent, 'cost_evidence');
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /6주 교습비: 190,000원/);
  assert.match(answer.answer, /실습 재료비: 23,000원/);
  assert.doesNotMatch(answer.answer, /999,000|99,000/);
  assert.deepEqual(
    answer.citations.map(({ documentId }) => documentId),
    ['ACTIVE'],
  );
  assert.match(
    answer.citations[0]?.location ?? '',
    /1행 · 열 항목, 금액.*2행 · 열 항목, 금액/,
  );
  assert.equal(generationCalls, 0);
});

test('비용이 서로 다른 승인 문서는 충돌로 판정하고 인용을 내보내지 않는다', async () => {
  const { register, ask } = await createFixture();
  await register('CURRENT_A', table);
  await register('CURRENT_B', table.replace('190,000', '200,000'));
  const { answer, trace } = await ask();
  assert.equal(answer.status, 'abstained');
  assert.equal(trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(answer.citations, []);
});

test('비용 항목 하나만 있으면 해당 셀과 인용만 반환한다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'COST',
    '| 6주 교습비 | 반 |\n|---|---|\n| 190,000원 | 금속 조형반 |\n| 230,000원 | 목재 조형반 |',
    null,
  );
  const { answer } = await ask();
  assert.equal(answer.status, 'partial', answer.answer);
  assert.match(answer.answer, /190,000원/);
  assert.doesNotMatch(answer.answer, /230,000원/);
  assert.match(answer.citations[0]?.location ?? '', /1행 · 열 6주 교습비, 반/);
});

test('미확인 강좌와 타인 명단 요청에 기존 반의 값을 사용하지 않는다', async () => {
  const { register, ask } = await createFixture();
  await register('COST', table);
  const unavailable = await ask('금속 조형반 주중 체험과정 교습비 얼마인가요?');
  assert.equal(unavailable.answer.status, 'abstained');
  assert.deepEqual(unavailable.answer.citations, []);
  const roster = await ask('금속 조형반 같이 다니는 애들 이름을 알려줘');
  assert.equal(roster.answer.status, 'denied');
  assert.deepEqual(roster.answer.citations, []);
});
