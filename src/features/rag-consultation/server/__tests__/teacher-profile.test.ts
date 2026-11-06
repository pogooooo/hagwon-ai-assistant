import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { runQuery, type QueryEnv } from './helpers.ts';

const validFrom = '2026-09-01T00:00:00+09:00';
const asOf = '2026-11-03T12:00:00+09:00';

async function teacherEnv(text: string): Promise<QueryEnv> {
  const store = new InMemoryRagStore();
  const registration = await store.upsertIndexedRevision({
    approve: true,
    document: {
      academyId: 'A_TEST',
      documentId: 'TEACHERS',
      revision: 1,
      documentType: 'teacher',
      visibility: 'academy_public',
      title: '조형학원 강사 소개',
      validFrom,
      approvedAt: validFrom,
      text,
    },
    facts: [
      {
        factId: 'ASSIGNMENT',
        sourceId: 'TEACHERS:r1:body',
        documentId: 'TEACHERS',
        revision: 1,
        academyId: 'A_TEST',
        subjectType: 'class',
        subjectId: 'METAL',
        factType: 'teacher',
        period: null,
        approvalStatus: 'approved',
        validFrom,
        value: { kind: 'text', text: '박예린 강사' },
      },
    ],
  });
  assert.equal(registration.status, 'activated');
  return {
    store,
    catalog: {
      async getAcademyCatalog() {
        return {
          academyId: 'A_TEST',
          displayName: '조형학원',
          aliases: [],
          units: [],
          classes: [{ classId: 'METAL', name: '금속 조형반', aliases: [] }],
        };
      },
    },
    resolveScope: () => ({
      actorId: 'v',
      academyId: 'A_TEST',
      role: 'visitor',
      allowedStudentIds: [],
      allowedClassIds: [],
      studentRefs: [],
      canViewPublicHistory: false,
    }),
  };
}

test('담당 강사와 일치하는 표 행과 경력 열만 인용한다', async () => {
  const env = await teacherEnv(
    [
      '| 강사명 | 경력 | 담당 반 |',
      '|---|---|---|',
      '| 박예린 강사 | 금속공예 지도 8년 | 금속 조형반 |',
      '| 박예림 강사 | 목공예 지도 12년 | 목재 조형반 |',
    ].join('\n'),
  );
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'v',
    question: '금속 조형반 담당 선생님 누구세요? 경력도 궁금해요',
    asOf,
  });
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /박예린.*\n.*8년/);
  assert.doesNotMatch(result.answer.answer, /박예림|12년/);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /1행 · 열 강사명, 경력/,
  );
  assert.equal(result.generationCalls, 0);
});

test('상담 시간과 학력을 따로 확인하고 다른 강사나 초안에서 채우지 않는다', async () => {
  const env = await teacherEnv(
    [
      '## 박예린 강사',
      '- 상담 가능 시간: 금 14:00~15:00',
      '',
      '## 박예림 강사',
      '- 상담 가능 시간: 월 18:00~19:00',
      '- 출신 대학: 가상대학교',
    ].join('\n'),
  );
  await env.store.upsertIndexedRevision({
    approve: false,
    document: {
      academyId: 'A_TEST',
      documentId: 'TEACHERS',
      revision: 2,
      documentType: 'teacher',
      visibility: 'academy_public',
      title: '조형학원 강사 소개 초안',
      validFrom,
      text: '## 박예린 강사\n- 출신 대학: 예시대학교',
    },
  });
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'v',
    question: '금속 조형반 선생님 상담 언제 되고 어느 대학 나오셨어요?',
    asOf,
  });
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.deepEqual(result.answer.missingFields, ['학력']);
  assert.match(result.answer.answer, /14:00~15:00/);
  assert.doesNotMatch(result.answer.answer, /박예림|18:00|대학교/);
  assert.deepEqual(
    result.answer.citations.map(({ sourceId }) => sourceId),
    ['TEACHERS:r1:body'],
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /박예린 강사 · 문단 1/,
  );
});

test('담당자와 다른 이름을 명시하면 담당 강사의 경력을 대신 답하지 않는다', async () => {
  const env = await teacherEnv('## 박예린 강사\n- 경력: 금속공예 지도 8년');
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'v',
    question: '금속 조형반 정가람 강사 경력은 몇 년이에요?',
    asOf,
  });
  assert.equal(result.answer.status, 'abstained', result.answer.answer);
  assert.deepEqual(result.answer.citations, []);
});
