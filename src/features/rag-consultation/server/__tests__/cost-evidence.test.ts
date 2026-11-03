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
  return { register, ask, store };
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

test('교재비와 재료비는 다른 표 열로 확인하고 하나만 있으면 부분 답변한다', async () => {
  const { register, ask } = await createFixture();
  const question = '금속 조형반 교재비와 실습 재료비 각각 얼마예요?';
  await register(
    'BOOK',
    '| 반 | 교재비 |\n|---|---|\n| 금속 조형반 | 17,000원 |',
    null,
  );
  const partial = (await ask(question)).answer;
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missingFields, ['금속 조형반 재료비']);
  assert.match(partial.citations[0]?.location ?? '', /열 반, 교재비/);
  await register(
    'MATERIAL',
    '| 항목 | 금액 |\n|---|---|\n| 실습 재료비 | 23,000원 |',
  );
  const complete = (await ask(question)).answer;
  assert.equal(complete.status, 'answered', complete.answer);
  assert.match(complete.answer, /교재비: 17,000원/);
  assert.match(complete.answer, /실습 재료비: 23,000원/);
  assert.deepEqual(
    complete.citations.map(({ documentId }) => documentId),
    ['BOOK', 'MATERIAL'],
  );
});

test('이번 달의 교재비와 재료비를 별개로 확인하고 만료 자료를 제외한다', async () => {
  const { register, ask } = await createFixture();
  const current =
    '| 반 | 교재비 | 재료비 |\n|---|---|---|\n| 금속 조형반 | 17,000원 | 23,000원 |';
  await register('CURRENT', current, null);
  await register(
    'EXPIRED',
    current.replace('23,000원', '99,000원'),
    null,
    true,
    '2026-11-01T00:00:00+09:00',
  );
  const { answer, trace } = await ask(
    '금속 조형반 이번 달 교재비와 재료비 각각 얼마예요?',
  );
  assert.equal(trace.intent, 'cost_evidence');
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /교재비: 17,000원/);
  assert.match(answer.answer, /재료비: 23,000원/);
  assert.doesNotMatch(answer.answer, /99,000원/);
});

test('비용 액수는 포함 관계를 증명하지 않는다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'COST',
    '| 반 | 교재비 | 재료비 |\n|---|---|---|\n| 금속 조형반 | 17,000원 | 23,000원 |',
    null,
  );
  const { answer } = await ask('금속 조형반 교재비는 재료비에 포함인가요?');
  assert.equal(answer.status, 'abstained');
  assert.deepEqual(answer.citations, []);
});

test('같은 청구 금액의 숫자 서식은 충돌이 아니지만 청구 단위는 충돌이다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'MONTHLY',
    '| 반 | 월 수강료 |\n|---|---|\n| 금속 조형반 | 17,000원 |',
    null,
  );
  await register(
    'EQUIVALENT',
    '| 반 | 매월 수강료 |\n|---|---|\n| 금속 조형반 | 17000원 |',
    null,
  );
  const question = '금속 조형반 수강료 얼마예요?';
  const matching = await ask(question);
  assert.equal(matching.answer.status, 'answered', matching.answer.answer);
  assert.match(matching.answer.answer, /17,?000원/);
  await register(
    'DIFFERENT_PERIOD',
    '| 반 | 6주 수강료 |\n|---|---|\n| 금속 조형반 | 17,000원 |',
    null,
  );
  const conflict = await ask(question);
  assert.equal(conflict.answer.status, 'abstained');
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
});

test('교습비와 담당 강사를 한 문장에 물으면 근거가 있는 비용만 부분 답변한다', async () => {
  const { register, ask } = await createFixture();
  await register('FEE_ONLY', table);
  const { answer } = await ask('금속 조형반 교습비랑 담당 강사는 누구예요?');
  assert.equal(answer.status, 'partial', answer.answer);
  assert.match(answer.answer, /190,000원/);
  assert.ok(answer.missingFields?.length);
  assert.deepEqual(
    answer.citations.map(({ documentId }) => documentId),
    ['FEE_ONLY'],
  );
});

test('내년 승인 수강료의 첫 적용일과 금액을 조회하고 같은 시점 충돌을 감지한다', async () => {
  const { ask, store } = await createFixture();
  const registerChange = async (
    documentId: string,
    validFrom: string,
    amount: number,
    approve: boolean,
  ) => {
    const sourceId = documentId + ':r1:body';
    const result = await store.upsertIndexedRevision({
      approve,
      document: {
        academyId: scope.academyId,
        classId: 'METAL',
        documentId,
        revision: 1,
        documentType: 'fee',
        visibility: 'academy_public',
        title: '조형 수업 비용',
        validFrom,
        approvedAt: '2026-08-01T00:00:00+09:00',
        text: '금속 조형반 수강료 ' + amount.toLocaleString('en-US') + '원',
      },
      facts: [
        {
          factId: documentId + '_FACT',
          academyId: scope.academyId,
          sourceId,
          documentId,
          revision: 1,
          subjectType: 'class',
          subjectId: 'METAL',
          factType: 'monthly_fee',
          value: { kind: 'money', amount, currency: 'KRW' },
          period: null,
          validFrom,
          approvalStatus: approve ? 'approved' : 'pending_review',
        },
      ],
    });
    assert.notEqual(result.status, 'rejected');
  };
  await registerChange('APPROVED', '2027-01-09T00:00:00+09:00', 180_000, true);
  await registerChange(
    'UNAPPROVED',
    '2027-01-01T00:00:00+09:00',
    99_000,
    false,
  );
  await registerChange(
    'FAR_FUTURE',
    '2028-01-01T00:00:00+09:00',
    360_000,
    true,
  );
  const query = '금속 조형반 내년 수강료가 얼마로 오르나요? 언제부터요?';
  const upcoming = await ask(query);
  assert.equal(upcoming.trace.intent, 'upcoming_fee');
  assert.equal(upcoming.answer.status, 'answered', upcoming.answer.answer);
  assert.match(upcoming.answer.answer, /2027년 1월 9일부터 180,000원/);
  assert.deepEqual(
    upcoming.answer.citations.map(({ documentId }) => documentId),
    ['APPROVED'],
  );
  await registerChange(
    'OVERLAPPING',
    '2026-08-01T00:00:00+09:00',
    150_000,
    true,
  );
  const conflict = await ask(query);
  assert.equal(conflict.answer.status, 'abstained');
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
});
