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

async function createFixture(fixtureCatalog = catalog, fixtureScope = scope) {
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
            return fixtureCatalog;
          },
        },
        resolveScope: () => fixtureScope,
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

test('같은 강좌명은 대상 학년으로 구분하고 학기당 청구액을 인용한다', async () => {
  const { ask, register } = await createFixture({
    ...catalog,
    classes: [
      {
        classId: 'JUNIOR',
        name: '공예반(초3·4)',
        aliases: ['저학년 공예반'],
        grade: '초3~초4',
      },
      {
        classId: 'SENIOR',
        name: '공예반(초5·6)',
        aliases: ['고학년 공예반'],
        grade: '초5~초6',
      },
    ],
  });
  await register(
    'SEMESTER',
    '| 강좌 | 대상 | 교재비 |\n|---|---|---|\n| 공예반 | 초3·4 | 학기당 34,000원 |\n| 공예반 | 초5·6 | 학기당 38,000원 |',
    null,
  );
  const { answer } = await ask('공예반(초3·4) 교재비는 매달 내요?');
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /학기당 34,000원/);
  assert.doesNotMatch(answer.answer, /38,000원/);
  assert.match(
    answer.citations[0]?.location ?? '',
    /1행 · 열 강좌, 대상, 교재비/,
  );
});

test('이용권 가격은 강좌 이름과 요청 회차가 함께 일치하는 셀만 인용한다', async () => {
  const { ask, register } = await createFixture();
  await register(
    'PASSES',
    '| 서비스 | 1회권 | 4회권 |\n|---|---|---|\n| 단체 판화 체험 | 31,000원 | 102,000원 |\n| 개인 판화 체험 | 39,000원 | 134,000원 |',
    null,
  );
  const result = await ask('개인 판화 체험 4회권 가격 얼마예요?');
  assert.equal(result.trace.intent, 'pass_price_evidence');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /개인 판화 체험 4회권: 134,000원/);
  assert.doesNotMatch(result.answer.answer, /31,000원|39,000원|102,000원/);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행 · 열 서비스, 4회권/,
  );
});

test('대여와 차량 비용은 요금 단위와 같은 행의 적용 조건을 보존한다', async () => {
  const { ask, register } = await createFixture();
  await register(
    'SERVICES',
    '| 항목 | 금액(월) | 안내 |\n|---|---|---|\n| 태블릿 대여료 | 12,000원 | 정규반만 신청 가능 |\n| 차량 이용료(왕복) | 38,000원 | 등하원 모두 이용 |\n| 차량 이용료(편도) | 21,000원 | 한 방향만 이용 |\n| 간식비 | 27,000원 | 별도 |',
    null,
  );
  const rental = await ask('태블릿을 빌리면 얼마예요?');
  assert.equal(rental.trace.intent, 'ancillary_price_evidence');
  assert.match(rental.answer.answer, /12,000원 \(월 기준\).*정규반만/);
  assert.doesNotMatch(rental.answer.answer, /38,000원|21,000원|27,000원/);
  assert.match(
    rental.answer.citations[0]?.location ?? '',
    /1행 · 열 항목, 금액\(월\), 안내/,
  );
  const rides = await ask('차량비 얼마예요? 등원만 타도 똑같나요?');
  assert.equal(rides.trace.intent, 'ancillary_price_evidence');
  assert.match(rides.answer.answer, /왕복.*38,000원/);
  assert.match(rides.answer.answer, /편도.*21,000원/);
  assert.doesNotMatch(rides.answer.answer, /12,000원|27,000원/);
});

test('적용 전 납부 공지는 이미 승인된 같은 기수의 행만 인용한다', async () => {
  const { ask, store } = await createFixture();
  const registerNotice = async (
    documentId: string,
    approvedAt: string,
    visibility: 'academy_public' | 'staff_only',
    window: string,
  ) =>
    store.upsertIndexedRevision({
      approve: true,
      document: {
        academyId: scope.academyId,
        documentId,
        revision: 1,
        documentType: 'fee',
        visibility,
        title: '수강료 납부 일정',
        validFrom: '2026-12-10T00:00:00+09:00',
        approvedAt,
        text:
          '| 항목 | 기간 |\n|---|---|\n| 12기 수강료 납부 | 11월 1일 ~ 11월 7일 |\n| 2기 수강료 납부 | ' +
          window +
          ' |\n| 2기 교재비 납부 | 12월 9일 ~ 12월 14일 |',
      },
    });
  await registerNotice(
    'PUBLISHED',
    '2026-11-01T00:00:00+09:00',
    'academy_public',
    '11월 21일 ~ 12월 4일',
  );
  await registerNotice(
    'LATER_APPROVAL',
    '2026-11-05T00:00:00+09:00',
    'academy_public',
    '11월 22일 ~ 12월 5일',
  );
  await registerNotice(
    'RESTRICTED',
    '2026-11-01T00:00:00+09:00',
    'staff_only',
    '11월 23일 ~ 12월 6일',
  );
  const result = await ask('2기 수강료는 언제부터 언제까지 내나요?');
  assert.equal(result.trace.intent, 'payment_window_evidence');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /11월 21일 ~ 12월 4일/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['PUBLISHED'],
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행 · 열 항목, 기간/,
  );
  assert.ok(
    result.trace.retrievedChunkIds.every((id) => id.startsWith('PUBLISHED:')),
  );
});

test('일반 카드 결제와 할부 가능 여부를 별개로 판정한다', async () => {
  const { ask, register } = await createFixture();
  await register(
    'PAYMENT',
    '납부 기한: 매월 9일까지 (카드 결제 또는 계좌 이체)',
    null,
  );
  const query = '수강료 카드 할부 되나요? 납부는 언제까지 해야 돼요?';
  const incomplete = await ask(query);
  assert.equal(incomplete.answer.status, 'partial', incomplete.answer.answer);
  assert.match(incomplete.answer.answer, /매월 9일까지/);
  assert.match(incomplete.answer.answer, /확인되지 않은 항목: 할부 가능 여부/);
  await register('INSTALLMENT', '카드 할부는 지원하지 않습니다.', null);
  const complete = await ask(query);
  assert.equal(complete.answer.status, 'answered', complete.answer.answer);
  assert.match(complete.answer.answer, /할부는 지원하지 않습니다/);
  assert.match(complete.answer.answer, /매월 9일까지/);
});

test('교재비 비교는 두 반의 값과 같은 청구 기준이 있어야 완료한다', async () => {
  const { ask, register } = await createFixture();
  await register(
    'COMPARE',
    '| 반 | 교재비(월) |\n|---|---|\n| 금속 조형반 | 21,000원 |\n| 목재 조형반 | 19,000원 |',
    null,
  );
  const result = await ask('금속 조형반이랑 목재 조형반 교재비가 같은가요?');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /금속 조형반 교재비\(월\): 21,000원/);
  assert.match(result.answer.answer, /목재 조형반 교재비\(월\): 19,000원/);
  assert.match(result.answer.answer, /금액은 서로 다릅니다/);
  assert.match(result.answer.citations[0]?.location ?? '', /1행.*2행|2행.*1행/);
});

test('현재 수강료와 간식비를 각각 검증하고 이전 가격이나 합계를 안내하지 않는다', async () => {
  const { ask, store } = await createFixture();
  const documentId = 'CURRENT_COSTS';
  const validFrom = '2026-10-01T00:00:00+09:00';
  await store.upsertIndexedRevision({
    approve: true,
    document: {
      academyId: scope.academyId,
      documentId,
      revision: 1,
      documentType: 'fee',
      visibility: 'academy_public',
      title: '새 학기 수강료',
      validFrom,
      approvedAt: '2026-09-01T00:00:00+09:00',
      text: '금속 조형반 월 수강료 220,000원\n\n| 항목 | 현행 | 개정 |\n|---|---|---|\n| 간식비(월) | 10,000원 | 12,000원 |',
    },
    facts: [
      {
        factId: 'METAL_FEE',
        academyId: scope.academyId,
        sourceId: documentId + ':r1:body',
        documentId,
        revision: 1,
        subjectType: 'class',
        subjectId: 'METAL',
        factType: 'monthly_fee',
        value: { kind: 'money', amount: 220_000, currency: 'KRW' },
        period: null,
        validFrom,
        approvalStatus: 'approved',
      },
    ],
  });
  const result = await ask('금속 조형반 이번달 수강료 얼마예요? 간식비까지요.');
  assert.equal(result.trace.intent, 'tuition_and_snacks');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /월 수강료: 220,000원/);
  assert.match(result.answer.answer, /간식비\(월\): 12,000원/);
  assert.doesNotMatch(result.answer.answer, /10,000원|232,000원/);
  assert.match(result.answer.citations[0]?.location ?? '', /열 항목, 개정/);
});

test('할인 예시는 같은 원생의 반 조합과 산식·결과를 모두 확인한다', async () => {
  const { ask, register } = await createFixture(catalog, {
    ...scope,
    role: 'guardian',
    allowedStudentIds: ['S1'],
    studentRefs: [
      {
        studentId: 'S1',
        displayLabel: '민수',
        aliases: ['민수'],
        classIds: ['METAL', 'WOOD'],
      },
    ],
  });
  await register(
    'EXAMPLES',
    '## 할인 계산 예시\n\n| 조합 | 계산 | 할인 후 월 수강료 |\n|---|---|---|\n| 금속 조형반 + 목재 조형반 | 60,000원 + (40,000원 − 9,000원) | 91,000원 |\n| 금속 조형반 + 사진반 | 60,000원 + (30,000원 − 8,000원) | 82,000원 |',
    null,
  );
  const result = await ask(
    '민수 금속 조형반이랑 목재 조형반 월 수강료 합치면 얼마예요?',
  );
  assert.equal(result.trace.intent, 'combined_tuition_example');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /할인 계산 예시.*9,000원.*91,000원/);
  assert.doesNotMatch(result.answer.answer, /82,000원/);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /1행 · 열 조합, 계산, 할인 후 월 수강료/,
  );
});
