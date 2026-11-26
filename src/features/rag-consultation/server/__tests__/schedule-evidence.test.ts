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
  const ask = (question: string, engine: 'legacy' | 'planned' = 'planned') =>
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
      { engine, userId: scope.actorId, asOf, question },
    );
  return { register, ask };
}

test('클리닉은 같은 학교급과 요일의 교시 시간만 인용한다', async () => {
  const { register, ask } = await createFixture(false, scope, true);
  await register(
    'CLINICS',
    [
      '## 초등부 시간표',
      '',
      '| 화 | 교시(평일 / 토요일) | 토 |',
      '|---|---|---|',
      '| 초등 과제 클리닉 · 209호 | 2교시 (평일 17:00~18:20 / 토 11:10~12:30) | 특별 수업 |',
      '',
      '## 중등부 시간표',
      '',
      '| 화 | 교시(평일 / 토요일) | 토 |',
      '|---|---|---|',
      '| 중등 과제 클리닉 · 304호 | 2교시 (평일 19:00~20:20 / 토 13:10~14:30) | 중등 과제 클리닉 |',
    ].join('\n'),
  );
  const result = await ask(
    '초5 조형 1반 화요일 수업 끝나고 과제 클리닉 몇 시예요?',
  );
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /초등 과제 클리닉 화요일 17:00~18:20/);
  assert.doesNotMatch(result.answer.answer, /19:00|11:10|13:10/);
  assert.match(
    result.answer.citations[0].location ?? '',
    /초등부.*열 교시\(평일 \/ 토요일\), 화/,
  );
  assert.equal(result.generationCalls, 0);
});

test('학생의 등록 반에서 정규 수업 구간과 교실을 별개 열로 인용한다', async () => {
  const { register, ask } = await createFixture(false, {
    ...scope,
    role: 'student',
    allowedStudentIds: ['LEARNER'],
    studentRefs: [
      {
        studentId: 'LEARNER',
        displayLabel: '학생',
        aliases: [],
        classIds: ['WOOD'],
      },
    ],
  });
  const grid = [
    '| 강의실 | 반 | 정규 수업 | 실습 |',
    '|---|---|---|---|',
    '| 201호 | 금속 조형반 | 월·수 17:10~18:20 | 목 15:10~16:30 |',
    '| 403호 | 목재 조형반 | 화·금 18:10~19:40 | 토 12:00~13:30 |',
  ].join('\n');
  await register('OWN_CLASS', grid);
  await register(
    'PENDING',
    grid.replace('403호', '999호').replace('18:10', '21:10'),
    { approve: false },
  );
  const times = await ask('우리반 수업 몇 시부터 몇 시까지예요?');
  assert.equal(times.answer.status, 'answered', times.answer.answer);
  assert.match(times.answer.answer, /목재 조형반.*18:10~19:40/);
  assert.doesNotMatch(times.answer.answer, /17:10|21:10|12:00|403호/);
  assert.match(
    times.answer.citations[0]?.location ?? '',
    /2행 · 열 반, 정규 수업/,
  );

  const room = await ask('우리반 교실 몇 호였지?');
  assert.equal(room.answer.status, 'answered', room.answer.answer);
  assert.match(room.answer.answer, /목재 조형반.*403호/);
  assert.doesNotMatch(room.answer.answer, /201호|999호|18:10/);
  assert.deepEqual(
    room.answer.citations.map(({ documentId }) => documentId),
    ['OWN_CLASS'],
  );
  assert.match(room.answer.citations[0]?.location ?? '', /2행 · 열 강의실, 반/);
  assert.equal(room.generationCalls, 0);
});

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

test('특정 날짜의 승인 변경 행이 정규 시간표보다 우선한다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'REGULAR_DATE',
    '| 반 | 수업 시간 | 강의실 |\n|---|---|---|\n| 금속 조형반 | 토 17:00~18:00 | 201호 |',
  );
  const rows = [
    '| 적용 날짜 | 반 | 강의실 | 수업 시간 |',
    '|---|---|---|---|',
    '| 11월 7일(토) | 목재 조형반 | 202호 | 19:00~20:00 |',
    '| 11월 14일(토) | 금속 조형반 | 303호 | 13:00~15:00 |',
    '| 11월 7일(토) | 금속 조형반 | 304호 | 14:00~16:00 |',
  ].join('\n');
  await register('DATED', rows);
  await register(
    'UNAPPROVED_DATED',
    rows.replace('14:00~16:00', '20:00~21:00'),
    { approve: false },
  );
  const { answer, trace, generationCalls } = await ask(
    '금속 조형반 11월 7일 토요일 수업 몇 시에 시작하고 강의실은 어디예요?',
  );
  assert.equal(trace.intent, 'dated_schedule_row', answer.answer);
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /14:00~16:00.*304호/);
  assert.doesNotMatch(answer.answer, /201호|202호|303호|20:00|목재/);
  assert.deepEqual(
    answer.citations.map(({ documentId }) => documentId),
    ['DATED'],
  );
  assert.match(
    answer.citations[0]?.location ?? '',
    /3행 · 열 반, 적용 날짜, 수업 시간, 강의실/,
  );
  assert.equal(generationCalls, 0);
});

test('같은 반과 날짜의 승인 변경 행이 충돌하면 정규표로 대체하지 않는다', async () => {
  const { register, ask } = await createFixture();
  const row =
    '| 반 | 적용 날짜 | 수업 시간 |\n|---|---|---|\n| 금속 조형반 | 11월 7일(토) | 14:00~16:00 |';
  await register('DATED_A', row);
  await register('DATED_B', row.replace('14:00~16:00', '16:00~18:00'));
  const { answer } = await ask('금속 조형반 11월 7일 수업 몇 시에 시작해요?');
  assert.equal(answer.status, 'abstained', answer.answer);
  assert.deepEqual(answer.citations, []);
});

test('차량·운행 방향·회차·정류장이 같은 행의 도착 시각만 선택한다', async () => {
  const { register, ask } = await createFixture();
  await register(
    'BUS_TABLE',
    [
      '| 차량 | 구분 | 정류장 | 시각 |',
      '|---|---|---|---|',
      '| 2호차 | 등원 1회차 | 해솔초 정문 | 13:20 |',
      '| 2호차 | 하원 1회차 | 해솔초 후문 | 17:10 |',
      '| 2호차 | 하원 1회차 | 해솔초 정문 | 17:30 |',
      '| 2호차 | 하원 2회차 | 해솔초 정문 | 18:40 |',
      '| 3호차 | 하원 3회차 | 해솔초 정문 | 19:30 |',
    ].join('\n'),
  );
  const first = await ask('2호차 하원 1회차 해솔초 정문에 몇 시 도착해요?');
  assert.equal(first.trace.intent, 'transit_schedule_row', first.answer.answer);
  assert.equal(first.answer.status, 'answered');
  assert.match(first.answer.answer, /17:30/);
  assert.doesNotMatch(first.answer.answer, /13:20|17:10|18:40|후문/);
  assert.match(
    first.answer.citations[0]?.location ?? '',
    /3행 · 열 차량, 구분, 정류장, 시각/,
  );
  const legacy = await ask(
    '2호차 하원 1회차 해솔초 정문에 몇 시 도착해요?',
    'legacy',
  );
  assert.equal(legacy.answer.answer, first.answer.answer);
  const last = await ask('2호차 마지막 하원차 해솔초 정문 도착 몇 시예요?');
  assert.equal(last.answer.status, 'answered', last.answer.answer);
  assert.match(last.answer.answer, /18:40/);
  assert.doesNotMatch(last.answer.answer, /17:30|19:30/);
  assert.equal(last.generationCalls, 0);
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
