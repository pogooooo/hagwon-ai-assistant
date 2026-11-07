import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type { SourceDocumentInput } from '../types.ts';
import { runQuery } from './helpers.ts';

test('이미 승인된 다음 기수의 비용과 수업 시간을 서로 다른 원본 표에서 확인한다', async () => {
  const store = new InMemoryRagStore();
  const asOf = '2026-11-03T12:00:00+09:00';
  const current = '2026-09-01T00:00:00+09:00';
  const future = '2026-11-16T00:00:00+09:00';
  const register = async (
    documentId: string,
    input: Pick<
      SourceDocumentInput,
      'documentType' | 'title' | 'text' | 'validFrom'
    > & { validTo?: string },
    approve = true,
  ) =>
    store.upsertIndexedRevision({
      approve,
      document: {
        academyId: 'AC_OFFER',
        documentId,
        revision: 1,
        visibility: 'academy_public',
        approvedAt: current,
        ...input,
      },
    });
  const schedule =
    '| 반 | 요일·시간 |\n|---|---|\n| 창작 목공반 | 월 14:00~15:00 |\n| 금속 공예반 | 월 16:00~17:00 |\n| 공예입문반 | 월 10:00~11:00 |';
  await register('CURRENT', {
    documentType: 'schedule',
    title: '3기 시간표',
    text:
      '3기 수업 기간: 9월 1일(화) ~ 11월 14일(토)\n\n' +
      schedule.replace('14:00~15:00', '17:00~18:00'),
    validFrom: current,
    validTo: future,
  });
  await register('NEXT_TIME', {
    documentType: 'schedule',
    title: '4기 시간표',
    text: schedule,
    validFrom: future,
  });
  await register('NEXT_START', {
    documentType: 'announcement',
    title: '다음 과정 개강 안내',
    text: '4기는 2026년 11월 16일(월)에 개강합니다.',
    validFrom: current,
  });
  await register('NEXT_FEE', {
    documentType: 'fee',
    title: '4기 수강료 안내',
    text: '| 반 | 현행 수강료(3기까지) | 개정 수강료(4기부터) |\n|---|---|---|\n| 창작 목공반 | 130,000원 | 150,000원 |\n| 금속 공예반 | 170,000원 | 180,000원 |',
    validFrom: future,
  });
  await register(
    'DRAFT_TIME',
    {
      documentType: 'schedule',
      title: '4기 시간표 초안',
      text: schedule.replace('14:00~15:00', '19:00~20:00'),
      validFrom: future,
    },
    false,
  );
  const ask = (question: string) =>
    runQuery(
      {
        store,
        catalog: {
          async getAcademyCatalog() {
            return {
              academyId: 'AC_OFFER',
              displayName: '공예 학원',
              aliases: [],
              units: [],
              classes: [
                {
                  classId: 'WOOD',
                  name: '창작 목공반',
                  aliases: ['공예입문반'],
                },
                {
                  classId: 'METAL',
                  name: '금속 공예반',
                  aliases: ['공예입문반'],
                },
              ],
            };
          },
        },
        resolveScope: () => ({
          actorId: 'v',
          academyId: 'AC_OFFER',
          role: 'visitor',
          allowedStudentIds: [],
          allowedClassIds: [],
          studentRefs: [],
          canViewPublicHistory: false,
        }),
      },
      { engine: 'planned', userId: 'v', asOf, question },
    );
  const result = await ask('4기 창작 목공반 수강료랑 시간도 알려주세요');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /11월 16일/);
  assert.match(result.answer.answer, /150,000원/);
  assert.match(result.answer.answer, /14:00~15:00/);
  assert.doesNotMatch(
    result.answer.answer,
    /130,000원|180,000원|10:00~11:00|17:00~18:00|19:00~20:00/,
  );
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['NEXT_FEE', 'NEXT_TIME'],
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /1행.*열 반, 개정 수강료\(4기부터\)/,
  );
  assert.equal(result.generationCalls, 0);
  const partial = await ask('4기 창작 목공반 교재비랑 시간도 알려주세요');
  assert.equal(partial.answer.status, 'partial', partial.answer.answer);
  assert.deepEqual(partial.answer.missingFields, ['교재비']);
  assert.match(partial.answer.answer, /14:00~15:00/);
  const dates = await ask('3기 언제 끝나요? 다음 기수는 언제 시작하나요?');
  assert.equal(dates.answer.status, 'answered', dates.answer.answer);
  assert.match(dates.answer.answer, /3기 종강일: 11월 14일/);
  assert.match(dates.answer.answer, /4기 개강일: 2026년 11월 16일/);
  assert.deepEqual(
    dates.answer.citations.map(({ documentId }) => documentId),
    ['CURRENT', 'NEXT_START'],
  );
});
