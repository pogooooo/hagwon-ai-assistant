import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';
import { runQuery } from './helpers.ts';

const start = '2026-09-01T00:00:00+09:00';
const now = '2026-11-15T15:00:00+09:00';
const change = '2027-01-01T00:00:00+09:00';
const catalog: AcademyCatalog = {
  academyId: 'TUITION_TEST',
  displayName: '새길학원',
  aliases: [],
  units: [],
  classes: [
    {
      classId: 'A',
      name: '초6 종합 1반',
      aliases: ['초6 종합반'],
      grade: '초6',
    },
    {
      classId: 'B',
      name: '과학 실험반(초5·6)',
      aliases: ['실험반'],
      grade: '초5~초6',
    },
    {
      classId: 'C',
      name: '초5 종합 1반',
      aliases: ['초5 종합반'],
      grade: '초5',
    },
    {
      classId: 'D',
      name: '미술 조형반(초5·6)',
      aliases: ['조형반'],
      grade: '초5~초6',
    },
  ],
};
const access: RagAccessScope = {
  actorId: 'guardian',
  academyId: catalog.academyId,
  role: 'guardian',
  allowedStudentIds: ['S1', 'S2'],
  allowedClassIds: ['A', 'B', 'C', 'D'],
  canViewPublicHistory: false,
  studentRefs: [
    {
      studentId: 'S1',
      displayLabel: '윤하늘',
      aliases: ['첫째'],
      classIds: ['A', 'B'],
    },
    {
      studentId: 'S2',
      displayLabel: '윤나무',
      aliases: ['둘째'],
      classIds: ['C', 'D'],
    },
  ],
};

const policy = [
  '## 할인 규정',
  '',
  '종합반과 단과반을 함께 들으면 단과반 수강료에서 한 과목당 20,000원을 할인합니다.',
  '종합반 없이 단과반만 2과목을 들으면 두 과목 수강료 합계의 10%를 할인합니다.',
  '형제·자매는 월 수강료 합계가 더 적은 원생의 수강료를 10% 할인합니다.',
  '중복 할인 없음이며 할인 금액이 더 큰 쪽 하나만 적용합니다.',
].join('\n');

function setup(scope = access) {
  const store = new InMemoryRagStore();
  const register = (
    id: string,
    rule: string,
    fees: Record<string, number>,
    validFrom = start,
    validTo?: string,
    approve = true,
  ) =>
    store.upsertIndexedRevision({
      approve,
      document: {
        academyId: scope.academyId,
        documentId: id,
        revision: 1,
        title: id + ' 월 수강료와 할인 규정',
        documentType: 'fee',
        visibility: 'academy_public',
        approvedAt: start,
        validFrom,
        validTo,
        text: [
          '## 단과반 월 수강료',
          '',
          '| 강좌 | 월 수강료 |',
          '|---|---|',
          '| 과학 실험반(초5·6) | ' + fees.B.toLocaleString('en-US') + '원 |',
          '| 미술 조형반(초5·6) | ' + fees.D.toLocaleString('en-US') + '원 |',
          '',
          rule,
        ].join('\n'),
      },
      facts: Object.entries(fees).map(([classId, amount]) => ({
        factId: id + '_' + classId,
        sourceId: id + ':r1:body',
        documentId: id,
        revision: 1,
        academyId: scope.academyId,
        subjectType: 'class',
        subjectId: classId,
        factType: 'monthly_fee',
        value: { kind: 'money', amount, currency: 'KRW' },
        validFrom,
        validTo,
        period: null,
        approvalStatus: 'approved',
      })),
    });
  const ask = (question: string) =>
    runQuery(
      {
        store,
        catalog: { getAcademyCatalog: async () => catalog },
        resolveScope: () => scope,
      },
      { question, asOf: now, engine: 'planned', userId: scope.actorId },
    );
  return { register, ask };
}

test('가족 동시 등록 문의는 승인 할인표의 조건과 할인율을 함께 인용한다', async () => {
  const { register, ask } = setup();
  const prices = { A: 400000, B: 120000, C: 200000, D: 100000 };
  const sheet = (rate: number) =>
    [
      '## 가족 동시 등록 할인',
      '',
      '| 구분 | 내용 |',
      '|---|---|',
      '| 대상 | 두 자녀가 모두 등록한 달에만 적용 |',
      '| 할인율 | 수강료가 낮은 자녀에게 ' + rate + '% 할인 |',
      '| 제외 | 재료비는 감면 대상에서 제외 |',
      '',
      '## 신규 등록 행사',
      '',
      '친구와 등록하면 수강료를 24% 할인합니다.',
    ].join('\n');
  await register('FAMILY_ACTIVE', sheet(14), prices);
  await register('FAMILY_PENDING', sheet(29), prices, start, undefined, false);
  const question = '누나하고 저 둘 다 등록하면 수강료 깎아주나요?';
  const result = await ask(question);
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /모두 등록한 달/);
  assert.match(result.answer.answer, /14%/);
  assert.match(result.answer.answer, /재료비.*제외/);
  assert.doesNotMatch(result.answer.answer, /24%|29%|400,000원/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['FAMILY_ACTIVE'],
  );
  assert.match(result.answer.citations[0].location ?? '', /열 구분, 내용/);
  assert.equal(result.generationCalls, 0);

  await register('FAMILY_CONFLICT', sheet(17), prices);
  const conflict = await ask(question);
  assert.equal(conflict.answer.status, 'abstained', conflict.answer.answer);
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(conflict.answer.citations, []);
});

test('형제 할인율과 교재비 적용 범위는 같은 승인 할인 규정에서만 확인한다', async () => {
  const prices = { A: 400000, B: 120000, C: 200000, D: 100000 };
  const question = '형제 할인 몇 프로에요? 교재비도 할인되나요?';
  for (const excluded of [true, false]) {
    const { register, ask } = setup();
    const sibling =
      '## 할인 규정\n\n형제 할인은 수강료가 낮은 자녀에게 14% 적용합니다.';
    await register(
      'ACTIVE_POLICY',
      sibling +
        (excluded
          ? '\n\n할인은 월 수강료에만 적용하며 교재비는 할인하지 않습니다.'
          : '\n\n할인은 교재비 확인 후 계산하며 차량비는 할인하지 않습니다.'),
      prices,
    );
    await register(
      'OTHER_PROGRAM',
      '## 단과반 할인 규정\n\n단과반 할인은 교재비에도 적용합니다.',
      prices,
    );
    const result = await ask(question);
    assert.equal(
      result.answer.status,
      excluded ? 'answered' : 'partial',
      result.answer.answer,
    );
    assert.match(result.answer.answer, /14%/);
    assert.doesNotMatch(
      result.answer.answer,
      /100,000원|120,000원|단과반 할인/,
    );
    assert.deepEqual(
      result.answer.citations.map(({ documentId }) => documentId),
      ['ACTIVE_POLICY'],
    );
    if (excluded)
      assert.match(result.answer.answer, /교재비는 할인하지 않습니다/);
    else
      assert.deepEqual(result.answer.missingFields, ['교재비 할인 적용 여부']);
    assert.equal(result.generationCalls, 0);
  }
});

test('형제 할인과 다과목 할인이 겹치면 대상 원생별로 더 큰 금액만 적용한다', async () => {
  const { register, ask } = setup();
  await register('CURRENT', policy, {
    A: 400000,
    B: 120000,
    C: 200000,
    D: 100000,
  });
  await register(
    'UNAPPROVED',
    policy.replaceAll('10%', '60%'),
    { A: 400000, B: 120000, C: 200000, D: 100000 },
    start,
    undefined,
    false,
  );
  const result = await ask(
    '첫째랑 둘째 다니는데 형제 할인은 누구한테 들어가고 각각 얼마예요?',
  );
  assert.equal(result.trace.intent, 'effective_tuition_discount');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /윤하늘.*할인 20,000원.*500,000원/);
  assert.match(result.answer.answer, /윤나무.*할인 30,000원.*270,000원/);
  assert.doesNotMatch(result.answer.answer, /60%|250,000원/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['CURRENT'],
  );
});

test('다음 해 수강료와 할인은 같은 날짜의 승인 버전에서 선택한다', async () => {
  const { register, ask } = setup();
  await register(
    'CURRENT',
    policy,
    { A: 400000, B: 120000, C: 200000, D: 100000 },
    start,
    change,
  );
  await register(
    'NEXT',
    policy.replace(
      '한 과목당 20,000원을 할인합니다',
      '2027년 1월부터 한 과목당 25,000원을 할인합니다',
    ),
    {
      A: 420000,
      B: 140000,
      C: 210000,
      D: 110000,
    },
    change,
  );
  const result = await ask(
    '첫째 내년 1월부터 종합반+실험반 같이 들으면 할인과 수강료 얼마예요?',
  );
  assert.equal(result.trace.intent, 'effective_tuition_discount');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /420,000원.*140,000원/);
  assert.match(result.answer.answer, /25,000원.*535,000원/);
  assert.doesNotMatch(
    result.answer.answer,
    /(?<!\d)(?:400,000원|120,000원|20,000원)/,
  );
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['NEXT'],
  );
});

test('단과 두 과목은 같은 학년의 과목별 수강료와 합계 할인율을 확인한다', async () => {
  const { register, ask } = setup();
  await register('CURRENT', policy, {
    A: 400000,
    B: 120000,
    C: 200000,
    D: 100000,
  });
  const result = await ask(
    '과학 실험반이랑 미술 조형반 5,6학년꺼 둘다 하면 할인해서 얼마예요? 종합반은 안 다녀요.',
  );
  assert.equal(result.trace.intent, 'effective_tuition_discount');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(
    result.answer.answer,
    /할인 전 220,000원.*할인 22,000원.*할인 후 198,000원/,
  );
  assert.doesNotMatch(result.answer.answer, /400,000원|200,000원/);
});
