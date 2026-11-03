import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type {
  AcademyCatalog,
  ApprovedFactInput,
  RagAccessScope,
} from '../types.ts';
import { runQuery } from './helpers.ts';

const asOf = '2026-11-03T12:00:00+09:00';
const scope: RagAccessScope = {
  actorId: 'visitor',
  academyId: 'AC_SCHEDULE',
  role: 'visitor',
  allowedStudentIds: [],
  allowedClassIds: [],
  studentRefs: [],
  canViewPublicHistory: false,
};
const catalog: AcademyCatalog = {
  academyId: scope.academyId,
  displayName: '도담공방',
  aliases: [],
  classes: [
    { classId: 'METAL', name: '금속 조형반', aliases: [] },
    { classId: 'WOOD', name: '목재 조형반', aliases: [] },
    {
      classId: 'DRAW_34',
      name: '기초 소묘반(초3·4)',
      aliases: ['저학년 소묘반'],
    },
    {
      classId: 'DRAW_56',
      name: '기초 소묘반(초5·6)',
      aliases: ['고학년 소묘반'],
    },
  ],
  units: [],
};

async function createFixture() {
  const store = new InMemoryRagStore();
  const register = async (
    documentId: string,
    text: string,
    options: {
      approve?: boolean;
      validTo?: string;
      facts?: ApprovedFactInput[];
    } = {},
  ) =>
    store.upsertIndexedRevision({
      approve: options.approve ?? true,
      facts: options.facts,
      document: {
        academyId: scope.academyId,
        documentId,
        revision: 1,
        documentType: 'schedule',
        visibility: 'academy_public',
        title: '조형반 수업 시간표',
        validFrom: '2026-09-01T00:00:00+09:00',
        approvedAt: '2026-09-01T00:00:00+09:00',
        validTo: options.validTo ?? null,
        text,
      },
    });
  const ask = (question: string) =>
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
      { engine: 'planned', userId: scope.actorId, asOf, question },
    );
  return { register, ask };
}

test('요일을 묻는 시간표는 그 요일의 실제 반·시각 셀만 인용한다', async () => {
  const { register, ask } = await createFixture();
  const grid =
    '| 시각 | 월요일 | 화요일 |\n|---|---|---|\n| 16:00 | 목재 조형반 | 금속 조형반 |\n| 18:00 | 금속 조형반 | 목재 조형반 |';
  await register('ACTIVE', grid);
  await register('PENDING', grid.replace('16:00', '19:00'), { approve: false });
  await register('EXPIRED', grid.replace('16:00', '20:00'), {
    validTo: '2026-10-01T00:00:00+09:00',
  });

  const { answer, trace, generationCalls } = await ask(
    '금속 조형반 화요일 수업 몇 시에 시작해요?',
  );
  assert.equal(trace.intent, 'schedule_evidence');
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /시각: 16:00.*화요일: 금속 조형반/);
  assert.doesNotMatch(answer.answer, /18:00|19:00|20:00|목재|월요일/);
  assert.deepEqual(
    answer.citations.map(({ documentId }) => documentId),
    ['ACTIVE'],
  );
  assert.match(answer.citations[0]?.location ?? '', /1행 · 열 화요일/);
  assert.equal(generationCalls, 0);
});

test('같은 강좌 이름을 사용하는 두 반은 별도 대상 열로 구분한다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'GRADE_SPLIT',
    '| 강좌 | 대상 | 수업 요일·시간 | 강의실 |\n|---|---|---|---|\n| 기초 소묘반 | 초3·4 | 화·목 17:00~18:00 | 201호 |\n| 기초 소묘반 | 초5·6 | 월·수 19:00~20:00 | 301호 |',
  );
  const { answer, trace } = await ask('저학년 소묘반은 무슨 요일 몇 시예요?');
  assert.equal(trace.intent, 'schedule_evidence');
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /초3·4.*화·목 17:00~18:00/);
  assert.doesNotMatch(answer.answer, /초5·6|19:00|301호/);
  assert.match(answer.citations[0]?.location ?? '', /1행 · 열 강좌, 대상/);
});

test('적용 중인 반의 승인 사실이 가리키는 시간표를 사용한다', async () => {
  const { register, ask } = await createFixture();
  const table =
    '| 반 | 수업 요일·시간 |\n|---|---|\n| 금속 조형반 | 화 17:00~18:00 |';
  await register('REGULAR', table);
  await register('REVISED', table.replace('17:00~18:00', '19:00~20:00'), {
    facts: [
      {
        factId: 'F_REVISED',
        sourceId: 'REVISED:r1:body',
        documentId: 'REVISED',
        revision: 1,
        academyId: scope.academyId,
        subjectType: 'class',
        subjectId: 'METAL',
        factType: 'schedule',
        value: { kind: 'schedule', text: '화 19:00~20:00' },
        period: null,
        validFrom: '2026-11-01T00:00:00+09:00',
        approvalStatus: 'approved',
      },
    ],
  });
  const { answer, trace } = await ask('금속 조형반 화요일 몇 시에 시작해요?');
  assert.equal(trace.intent, 'schedule_evidence');
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /19:00~20:00/);
  assert.doesNotMatch(answer.answer, /17:00|18:00/);
  assert.deepEqual(
    answer.citations.map(({ documentId }) => documentId),
    ['REVISED'],
  );
});
