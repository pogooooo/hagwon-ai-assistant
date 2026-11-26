import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { runQuery } from './helpers.ts';

test('환불 시점의 주차가 속한 구간과 같은 행의 반환 비율만 인용한다', async () => {
  const store = new InMemoryRagStore();
  const register = (documentId: string, rate: string) =>
    store.upsertIndexedRevision({
      approve: true,
      document: {
        academyId: 'REFUND_TEST',
        documentId,
        revision: 1,
        documentType: 'policy',
        visibility: 'academy_public',
        title: '학원 환불 안내',
        validFrom: '2026-09-01T00:00:00+09:00',
        approvedAt: '2026-09-01T00:00:00+09:00',
        text:
          '| 반환 사유 발생 시점 | 반환 금액 |\n|---|---|\n| 1주 차 종료 후 ~ 2주 차 종료 전 | 수강료의 3/4 |\n| 2주 차 종료 후 ~ 4주 차 종료 전 | 수강료의 ' +
          rate +
          ' |\n| 4주 차 종료 후 | 반환하지 않음 |',
      },
    });
  await register('REFUND', '1/2');
  const ask = () =>
    runQuery(
      {
        store,
        catalog: {
          async getAcademyCatalog() {
            return {
              academyId: 'REFUND_TEST',
              displayName: '학원',
              aliases: [],
              units: [],
              classes: [],
            };
          },
        },
        resolveScope: () => ({
          actorId: 'visitor',
          academyId: 'REFUND_TEST',
          role: 'visitor',
          allowedStudentIds: [],
          allowedClassIds: [],
          studentRefs: [],
          canViewPublicHistory: false,
        }),
      },
      {
        engine: 'planned',
        userId: 'visitor',
        question: '3주차에 그만두면 환불 얼마 받아요?',
        asOf: '2026-11-03T12:00:00+09:00',
      },
    );

  const result = await ask();
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /1\/2/);
  assert.doesNotMatch(result.answer.answer, /3\/4|반환하지 않음/);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행.*열 반환 사유 발생 시점, 반환 금액/,
  );
  await register('CONFLICT', '1/3');
  const conflict = await ask();
  assert.equal(conflict.answer.status, 'abstained');
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(conflict.answer.citations, []);
});
