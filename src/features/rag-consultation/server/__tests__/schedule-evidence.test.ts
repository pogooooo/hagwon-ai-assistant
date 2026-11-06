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
      grade: '초3~초4',
    },
    {
      classId: 'DRAW_56',
      name: '기초 소묘반(초5·6)',
      aliases: ['고학년 소묘반'],
      grade: '초5~초6',
    },
  ],
  units: [],
};

const numberedClasses: AcademyCatalog['classes'] = [
  {
    classId: 'STUDIO_1',
    name: '초5 조형 1반',
    aliases: ['초5 1반'],
    grade: '초5',
  },
  {
    classId: 'STUDIO_2',
    name: '초5 조형 2반',
    aliases: ['초5 2반'],
    grade: '초5',
  },
  {
    classId: 'STUDIO_6',
    name: '초6 조형 2반',
    aliases: ['초6 2반'],
    grade: '초6',
  },
];

async function createFixture(
  sharedCourseAlias = false,
  access = scope,
  numbered = false,
) {
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
            return sharedCourseAlias
              ? {
                  ...catalog,
                  classes: catalog.classes.map((entry) =>
                    entry.classId.startsWith('DRAW_')
                      ? { ...entry, aliases: [...entry.aliases, '소묘반'] }
                      : entry,
                  ),
                }
              : numbered
                ? {
                    ...catalog,
                    classes: [...catalog.classes, ...numberedClasses],
                  }
                : catalog;
          },
        },
        resolveScope: () => access,
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

test('단일 학년 조건이 있는 약칭 질문은 해당 학년의 강좌 시간표만 선택한다', async () => {
  const { register, ask } = await createFixture(true);
  await register(
    'GRADE_SCOPE',
    '| 강좌 | 대상 | 수업 요일·시간 | 강의실 |\n|---|---|---|---|\n| 기초 소묘반 | 초3·4 | 화·목 17:00~18:00 | 201호 |\n| 기초 소묘반 | 초5·6 | 월·수 19:00~20:00 | 301호 |',
  );
  const { answer, trace } = await ask(
    '소묘반 5학년반은 무슨 요일 몇 호에서 해요?',
  );
  assert.equal(trace.intent, 'schedule_evidence');
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /초5·6.*월·수.*301호/);
  assert.doesNotMatch(answer.answer, /초3·4|17:00|201호/);
  const multipleGrades = await ask('3,4학년 기초 소묘반 시간 알려주세요');
  assert.equal(multipleGrades.trace.intent, 'schedule_evidence');
  assert.equal(multipleGrades.answer.status, 'answered');
  assert.match(multipleGrades.answer.answer, /화·목 17:00~18:00/);
  assert.doesNotMatch(multipleGrades.answer.answer, /초5·6|19:00/);
});

test('수업 시각과 강의실을 같은 반의 원본 행에서 함께 확인한다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'TIME_ROOM',
    '| 반 | 수업 요일·시간 | 강의실 |\n|---|---|---|\n| 금속 조형반 | 화 17:00~18:00 | 조형실 |\n| 목재 조형반 | 월 19:00~20:00 | 목공실 |',
  );
  const { answer, trace } = await ask(
    '금속 조형반 수업 시간이랑 강의실 어디예요?',
  );
  assert.equal(trace.intent, 'schedule_evidence');
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /17:00~18:00.*조형실/);
  assert.doesNotMatch(answer.answer, /19:00|목공실/);
  assert.match(
    answer.citations[0]?.location ?? '',
    /1행 · 열 반, 수업 요일·시간, 강의실/,
  );
});

test('등원 시각은 소속 반의 당일 시간표로 확인하고 휴강 공지가 있으면 보류한다', async () => {
  const { register, ask } = await createFixture(false, {
    ...scope,
    role: 'guardian',
    allowedStudentIds: ['PUPIL'],
    studentRefs: [
      {
        studentId: 'PUPIL',
        displayLabel: '김수현',
        aliases: ['수현이'],
        classIds: ['METAL'],
      },
    ],
  });
  await register(
    'ARRIVAL',
    '| 시각 | 월요일 | 화요일 |\n|---|---|---|\n| 16:00 | 목재 조형반 | 금속 조형반 |\n| 18:00 | 금속 조형반 | 목재 조형반 |',
  );
  const question = '수현이 오늘 몇 시까지 학원 가면 돼요?';
  const regular = await ask(question);
  assert.equal(regular.trace.intent, 'schedule_evidence');
  assert.equal(regular.answer.status, 'answered', regular.answer.answer);
  assert.match(regular.answer.answer, /16:00/);
  assert.doesNotMatch(regular.answer.answer, /18:00/);

  await register('CANCELLATION', '11월 3일 금속 조형반 수업은 휴강합니다.', {
    facts: [
      {
        factId: 'F_CANCEL',
        sourceId: 'CANCELLATION:r1:body',
        documentId: 'CANCELLATION',
        revision: 1,
        academyId: scope.academyId,
        subjectType: 'class',
        subjectId: 'METAL',
        factType: 'schedule_change',
        value: {
          kind: 'schedule_change',
          changeType: 'cancel',
          date: '2026-11-03',
          time: null,
          text: '휴강',
        },
        period: null,
        validFrom: '2026-11-01T00:00:00+09:00',
        approvalStatus: 'approved',
      },
    ],
  });
  const changed = await ask(question);
  assert.equal(changed.answer.status, 'abstained', changed.answer.answer);
  assert.doesNotMatch(changed.answer.answer, /16:00|18:00/);
});

test('명시 날짜에는 승인된 반별 대체 공지가 정규 시간표보다 우선한다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'REGULAR_DATE',
    '| 시각 | 화요일 |\n|---|---|\n| 16:00 | 금속 조형반 |\n| 18:00 | 목재 조형반 |',
  );
  const announcement =
    '11월 3일 금속 조형반 정규 수업은 전시회 참가로 대체합니다.';
  await register('REPLACEMENT', announcement, {
    facts: [
      {
        factId: 'F_REPLACEMENT',
        sourceId: 'REPLACEMENT:r1:body',
        documentId: 'REPLACEMENT',
        revision: 1,
        academyId: scope.academyId,
        subjectType: 'academy',
        subjectId: scope.academyId,
        factType: 'schedule_change',
        value: {
          kind: 'schedule_change',
          changeType: 'cancel',
          date: '2026-11-03',
          time: null,
          text: announcement,
        },
        period: null,
        validFrom: '2026-11-01T00:00:00+09:00',
        approvalStatus: 'approved',
      },
    ],
  });
  const replacement = await ask('금속 조형반 11월 3일 화요일에 수업 있어?');
  assert.equal(replacement.trace.intent, 'schedule_override');
  assert.equal(replacement.answer.status, 'answered');
  assert.match(replacement.answer.answer, /전시회 참가로 대체/);
  assert.doesNotMatch(replacement.answer.answer, /16:00/);
  assert.equal(replacement.answer.citations[0]?.documentId, 'REPLACEMENT');

  const unaffected = await ask('목재 조형반 11월 3일 화요일에 수업 있어?');
  assert.equal(unaffected.answer.status, 'answered', unaffected.answer.answer);
  assert.match(unaffected.answer.answer, /18:00/);
  assert.doesNotMatch(unaffected.answer.answer, /전시회/);
});

test('같은 학년으로 나열된 반마다 시간표 행을 확인한다', async () => {
  const { register, ask } = await createFixture(false, scope, true);
  await register(
    'NUMBERED_CLASSES',
    '| 반 | 수업 요일·시간 |\n|---|---|\n| 초5 조형 1반 | 화 17:00~18:00 |\n| 초5 조형 2반 | 수 19:00~20:00 |\n| 초6 조형 2반 | 금 20:00~21:00 |',
  );
  const { answer, trace } = await ask(
    '초5 1반이랑 2반 수업시간 각각 알려주세요',
  );
  assert.equal(trace.intent, 'schedule_evidence');
  assert.equal(answer.status, 'answered');
  assert.match(answer.answer, /초5 조형 1반.*17:00~18:00/);
  assert.match(answer.answer, /초5 조형 2반.*19:00~20:00/);
  assert.doesNotMatch(answer.answer, /초6|21:00/);
  assert.match(answer.citations[0]?.location ?? '', /1행.*2행/);
});

test('정규 수업 시각과 별도 수업 여부는 서로 다른 근거로 판단한다', async () => {
  const question =
    '금속 조형반 수업은 몇 시부터고 원어민 선생님 수업도 있나요?';
  const table =
    '| 반 | 수업 요일·시간 | 원어민 수업 |\n|---|---|---|\n| 금속 조형반 | 화 17:00~18:00 | - |';
  const unknown = await createFixture();
  await unknown.register('TIMETABLE_NO_NATIVE', table);
  const partial = (await unknown.ask(question)).answer;
  assert.equal(partial.status, 'partial', partial.answer);
  assert.match(partial.answer, /17:00~18:00/);
  assert.deepEqual(partial.missingFields, ['원어민 수업']);

  const known = await createFixture();
  await known.register(
    'TIMETABLE_NATIVE',
    table.replace('| - |', '| 매주 목요일 |'),
  );
  const confirmed = (await known.ask(question)).answer;
  assert.equal(confirmed.status, 'answered', confirmed.answer);
  assert.match(confirmed.answer, /원어민 수업: 매주 목요일/);
});
