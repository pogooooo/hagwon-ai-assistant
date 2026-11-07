import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryConversationStore } from '../adapters/memory/index.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type {
  AcademyCatalog,
  ApprovedFactInput,
  DocumentType,
  RagAccessScope,
  SourceDocumentInput,
} from '../types.ts';
import { runQuery } from './helpers.ts';

const start = '2026-11-01T00:00:00+09:00';
const now = '2026-11-11T15:00:00+09:00';
const catalog: AcademyCatalog = {
  academyId: 'OPERATIONS_TEST',
  displayName: '새봄학원',
  aliases: [],
  units: [],
  classes: [
    {
      classId: 'STUDIO',
      name: '초5 미술 2반',
      aliases: ['초5 2반'],
      grade: '초5',
    },
    {
      classId: 'ART_L2',
      name: 'L2 디자인 토요반',
      aliases: ['L2'],
      subject: '디자인',
    },
    {
      classId: 'ART_L3',
      name: 'L3 디자인 토요반',
      aliases: ['L3'],
      subject: '디자인',
    },
  ],
};
const scope: RagAccessScope = {
  actorId: 'guardian',
  role: 'guardian',
  academyId: catalog.academyId,
  allowedStudentIds: ['S1'],
  allowedClassIds: ['ART_L2'],
  canViewPublicHistory: false,
  studentRefs: [
    {
      studentId: 'S1',
      displayLabel: '소율',
      aliases: ['소율'],
      classIds: ['ART_L2'],
    },
  ],
};

type FactData = Pick<ApprovedFactInput, 'factType' | 'value'> &
  Partial<
    Pick<
      ApprovedFactInput,
      'validFrom' | 'validTo' | 'subjectType' | 'subjectId'
    >
  >;

function setup(access = scope) {
  const store = new InMemoryRagStore();
  const conversations = new InMemoryConversationStore();
  const register = (
    documentId: string,
    documentType: DocumentType,
    title: string,
    text: string,
    opts: {
      approve?: boolean;
      facts?: FactData[];
      visibility?: SourceDocumentInput['visibility'];
      validTo?: string;
    } = {},
  ) =>
    store.upsertIndexedRevision({
      approve: opts.approve ?? true,
      document: {
        academyId: scope.academyId,
        documentId,
        revision: 1,
        documentType,
        title,
        text,
        visibility: opts.visibility ?? 'academy_public',
        validFrom: start,
        approvedAt: start,
        validTo: opts.validTo,
      },
      facts: opts.facts?.map((fact, index) => ({
        factId: documentId + '_' + index,
        sourceId: documentId + ':r1:body',
        documentId,
        revision: 1,
        academyId: scope.academyId,
        subjectType: 'academy',
        subjectId: scope.academyId,
        validFrom: start,
        approvalStatus: 'approved',
        period: null,
        ...fact,
      })),
    });
  const ask = (question: string, asOf = now) =>
    runQuery(
      {
        store,
        catalog: { getAcademyCatalog: async () => catalog },
        resolveScope: () => access,
      },
      {
        question,
        asOf,
        engine: 'planned',
        userId: access.actorId,
        conversations,
      },
    );
  return { register, ask };
}

test('주소와 전철 하차역을 서로 다른 행에서 확인하고 주차 안내를 제외한다', async () => {
  const { register, ask } = setup();
  await register(
    'DIRECTIONS',
    'academy_info',
    '오시는 길',
    [
      '| 내용 | 항목 |',
      '|---|---|',
      '| 예시로 84, 3층 | 주소 |',
      '| 샘물역 4번 출구에서 도보 3분 | 지하철 |',
      '| 새봄 정류장에서 버스 하차 | 버스 |',
      '| 지하 주차장 30분 무료 | 주차 |',
    ].join('\n'),
  );
  await register(
    'PENDING_RAIL',
    'academy_info',
    '전철 안내 초안',
    '| 항목 | 내용 |\n|---|---|\n| 지하철 | 다솔역 8번 출구 |',
    { approve: false },
  );
  const onlyRail = await ask('전철 타면 어느 역에서 내려요?');
  assert.equal(onlyRail.answer.status, 'answered', onlyRail.answer.answer);
  assert.match(onlyRail.answer.answer, /샘물역 4번 출구/);
  assert.doesNotMatch(onlyRail.answer.answer, /예시로|주차장|정류장|다솔역/);

  const both = await ask(
    '학원 위치가 정확히 어디예요? 지하철 타면 몇 번 출구로 나가요?',
  );
  assert.equal(both.answer.status, 'answered', both.answer.answer);
  assert.match(both.answer.answer, /예시로 84/);
  assert.match(both.answer.answer, /샘물역 4번 출구/);
  assert.doesNotMatch(both.answer.answer, /주차장|정류장|다솔역/);
  assert.match(both.answer.citations[0]?.location ?? '', /1행.*2행|2행.*1행/);
  assert.equal(both.generationCalls, 0);
});

test('행사일과 월별 학원 전체 휴강은 같은 기간의 특정 반 휴강과 구분한다', async () => {
  const { register, ask } = setup();
  const cancel = (
    date: string,
    text: string,
    subjectId?: string,
  ): FactData => ({
    factType: 'schedule_change',
    ...(subjectId ? { subjectType: 'class', subjectId } : {}),
    value: {
      kind: 'schedule_change',
      changeType: 'cancel',
      date,
      time: null,
      text,
    },
  });
  await register(
    'CLOSURES',
    'announcement',
    '학원 휴강 일정',
    '11월 19일 수능일 전체 휴강. 12월 25일 성탄절 전체 휴강. 12월 3일에는 실험반만 휴강입니다.',
    {
      facts: [
        cancel('2026-11-19', '수능일 전체 휴강'),
        cancel('2026-12-25', '성탄절 전체 휴강'),
        cancel('2026-12-03', '초5 미술 2반 휴강', 'STUDIO'),
      ],
    },
  );
  const exam = await ask('수능날 학원 쉼?');
  assert.equal(exam.answer.status, 'answered', exam.answer.answer);
  assert.match(exam.answer.answer, /11월 19일.*전체 휴강/);
  assert.doesNotMatch(exam.answer.answer, /12월/);
  const month = await ask('12월에 학원 노는 날 있어요?');
  assert.equal(month.answer.status, 'answered', month.answer.answer);
  assert.match(month.answer.answer, /12월 25일.*전체 휴강/);
  assert.doesNotMatch(month.answer.answer, /12월 3일|11월/);
  assert.deepEqual(
    month.answer.citations.map(({ documentId }) => documentId),
    ['CLOSURES'],
  );
  assert.equal(month.generationCalls, 0);
});

const matrixScope: RagAccessScope = {
  ...scope,
  role: 'student',
  allowedClassIds: ['STUDIO'],
  studentRefs: scope.studentRefs.map((ref) => ({
    ...ref,
    classIds: ['STUDIO'],
  })),
};
const shuttleMatrix = [
  '| 하원 2회차(중등) | 정류장 | 노선 | 등원 1회차(초등) | 하원 1회차(초등) | 등원 2회차(중등) |',
  '|---|---|---|---|---|---|',
  '| 19:40 | 연솔중학교 정문 | A | 15:50 | 18:20 | 16:55 |',
  '| 19:45 | 연솔중학교 후문 | A | 16:10 | 18:15 | 17:05 |',
  '| 19:50 | 연솔중학교 후문 | B | 16:30 | 18:05 | 17:35 |',
  '| 19:55 | 큰연솔중학교 후문 | A | 16:25 | 18:05 | 17:40 |',
  '| 19:20 출발 | 학원 출발 | A | 16:50 도착 | 18:00 출발 | 17:50 도착 |',
  '| 19:20 출발 | 학원 출발 | B | 16:50 도착 | 18:00 출발 | 17:50 도착 |',
].join('\n');

test('노선·정류장·승차 방향과 권한으로 확인된 학교급의 회차 열만 인용한다', async () => {
  const { register, ask } = setup(matrixScope);
  await register(
    'MATRIX',
    'academy_info',
    '학원 셔틀버스 운행표',
    shuttleMatrix,
  );
  const result = await ask('학원차 A노선 연솔중 후문에서 몇 시에 타요?');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /등원 1회차\(초등\).*16:10/);
  assert.doesNotMatch(result.answer.answer, /17:05|18:15|19:45|16:30|16:25/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['MATRIX'],
  );
  assert.match(
    result.answer.citations[0].location ?? '',
    /2행 · 열 노선, 정류장, 등원 1회차\(초등\)/,
  );
  assert.equal(result.generationCalls, 0);

  const gate = await ask('학원차 A노선 큰연솔중 후문에서 몇 시에 타요?');
  assert.equal(gate.answer.status, 'answered', gate.answer.answer);
  assert.match(gate.answer.answer, /큰연솔중학교 후문.*16:25/);
  assert.doesNotMatch(gate.answer.answer, /16:10/);
  const missing = await ask('학원차 A노선 연솔중 동문에서 몇 시에 타요?');
  assert.equal(missing.answer.status, 'abstained', missing.answer.answer);
  assert.deepEqual(missing.answer.citations, []);
});

test('기간 마지막 날까지 변경 출발 시각을 쓰고 휴강일에는 정규 시각을 대입하지 않는다', async () => {
  const { register, ask } = setup(matrixScope);
  await register(
    'MATRIX_DATED',
    'schedule',
    '셔틀버스 운행표',
    shuttleMatrix +
      '\n\n## 운행 변경\n\n' +
      [
        '| 구분 | 변경 내용 |',
        '|---|---|',
        '| 점검 기간(11월 12일~11월 16일) 하원 1회차 | 18:20 출발 |',
        '| 토요일 | 운행하지 않음 |',
        '| 휴강일 | 전 반 휴강일에는 운행하지 않음 |',
      ].join('\n'),
  );
  const question = '수업 끝나고 봉고 몇 시에 출발해요?';
  const before = await ask(question, '2026-11-11T15:00:00+09:00');
  assert.equal(before.answer.status, 'answered', before.answer.answer);
  assert.match(before.answer.answer, /18:00 출발/);
  assert.doesNotMatch(before.answer.answer, /18:20|19:20/);
  const tomorrow = await ask(
    '내일 수업 끝나고 봉고 몇 시에 출발해요?',
    '2026-11-11T15:00:00+09:00',
  );
  assert.equal(tomorrow.answer.status, 'answered', tomorrow.answer.answer);
  assert.match(tomorrow.answer.answer, /18:20 출발/);
  const last = await ask(question, '2026-11-16T15:00:00+09:00');
  assert.equal(last.answer.status, 'answered', last.answer.answer);
  assert.match(last.answer.answer, /18:20 출발/);
  assert.doesNotMatch(last.answer.answer, /18:00|19:20/);
  assert.match(
    last.answer.citations[0].location ?? '',
    /표 2 · 1행 · 열 구분, 변경 내용/,
  );
  const weekend = await ask(question, '2026-11-14T15:00:00+09:00');
  assert.equal(weekend.answer.status, 'abstained', weekend.answer.answer);
  const after = await ask(question, '2026-11-17T15:00:00+09:00');
  assert.equal(after.answer.status, 'answered', after.answer.answer);
  assert.match(after.answer.answer, /18:00 출발/);

  await register(
    'CLOSED',
    'announcement',
    '학원 전체 휴강 안내',
    '11월 17일은 전 반 휴강입니다.',
    {
      facts: [
        {
          factType: 'schedule_change',
          value: {
            kind: 'schedule_change',
            changeType: 'cancel',
            date: '2026-11-17',
            time: null,
            text: '전 반 휴강',
          },
        },
      ],
    },
  );
  const closed = await ask(question, '2026-11-17T15:00:00+09:00');
  assert.equal(closed.answer.status, 'abstained', closed.answer.answer);
  assert.deepEqual(closed.answer.citations, []);
});

test('차량 운행과 자택 픽업은 승인된 안내에서만 확인한다', async () => {
  const { register, ask } = setup();
  await register(
    'ATTENDANCE',
    'policy',
    '학원 출결 규정',
    '수업 시작 시각까지 입실해 주세요.',
  );
  await register(
    'BUS_DRAFT',
    'announcement',
    '차량 검토안',
    '학원차는 집 앞까지 데리러 가는 방식으로 운행합니다.',
    { approve: false },
  );
  const unsupported = await ask('학원차 다녀요? 집 앞까지 데리러 와요?');
  assert.equal(
    unsupported.answer.status,
    'abstained',
    unsupported.answer.answer,
  );
  assert.deepEqual(unsupported.answer.citations, []);
  await register(
    'BUS_ACTIVE',
    'announcement',
    '차량 공식 안내',
    '학원 셔틀버스를 평일에 운행합니다.',
  );
  const operating = await ask('학원차 다녀요?');
  assert.equal(operating.answer.status, 'answered', operating.answer.answer);
  assert.match(operating.answer.answer, /평일에 운행/);
  assert.deepEqual(
    operating.answer.citations.map(({ documentId }) => documentId),
    ['BUS_ACTIVE'],
  );
  const doorstep = await ask('학원차 집 앞까지 데리러 와요?');
  assert.equal(doorstep.answer.status, 'abstained', doorstep.answer.answer);
  assert.deepEqual(doorstep.answer.citations, []);

  const closed = setup();
  await closed.register(
    'NO_SERVICE',
    'academy_info',
    '학원 안내',
    '- 상담 방문 주차는 1시간 무료입니다.\n- 학원 차량(셔틀버스)은 운영하지 않습니다.\n- 정문 앞에서 정차할 수 없습니다.',
  );
  const negative = await closed.ask('학원차 있어요? 아파트 앞까지 와주나요?');
  assert.equal(negative.answer.status, 'answered', negative.answer.answer);
  assert.match(negative.answer.answer, /차량\(셔틀버스\)은 운영하지 않습니다/);
  assert.doesNotMatch(negative.answer.answer, /주차|정문/);
  assert.deepEqual(
    negative.answer.citations.map(({ documentId }) => documentId),
    ['NO_SERVICE'],
  );
});

const bus = [
  '| 시각 | 정류장 | 차량 | 회차 |',
  '|---|---|---|---|',
  '| 18:00 | 학원 출발 | 4호차 | 하원 1회차 |',
  '| 18:20 | 버드나무 도서관 | 4호차 | 하원 1회차 |',
  '| 19:00 | 학원 출발 | 4호차 | 하원 2회차 |',
  '| 19:20 | 버드나무 도서관 | 4호차 | 하원 2회차 |',
  '| 19:27 | 버드나무 도서관 | 5호차 | 하원 2회차 |',
].join('\n');

test('하원 변경은 조회일에 유효한 동일 차량의 정류장·회차 공지만 사용한다', async () => {
  const { register, ask } = setup();
  await register('BUS', 'schedule', '학원 차량 운행표', bus);
  const from = '2026-11-11T00:00:00+09:00';
  const until = '2026-11-16T00:00:00+09:00';
  const detour =
    '"버드나무 도서관" 정류장을 쓰지 않고, "우체국 앞" 임시 정류장에 정차합니다.';
  const departure = '공사 기간 중 4호차 하원 2회차 학원 출발은 19:10입니다.';
  await register(
    'DETOUR',
    'announcement',
    '4호차 하원 노선 임시 변경',
    detour + '\n\n' + departure,
    {
      facts: [detour, departure].map((text) => ({
        factType: 'notice',
        value: { kind: 'text', text },
        validFrom: from,
        validTo: until,
      })),
    },
  );
  const draft = departure.replace('19:10', '20:00');
  await register(
    'DRAFT',
    'announcement',
    '4호차 하원 노선 임시 변경 초안',
    draft,
    {
      approve: false,
      facts: [
        {
          factType: 'notice',
          value: { kind: 'text', text: draft },
          validFrom: from,
        },
      ],
    },
  );
  const stop = await ask(
    '4호차 버드나무 도서관 정류장 없어진 건가요? 어디서 내려요?',
  );
  assert.equal(stop.answer.status, 'answered', stop.answer.answer);
  assert.match(stop.answer.answer, /우체국 앞/);
  assert.deepEqual(
    stop.answer.citations.map(({ documentId }) => documentId),
    ['DETOUR'],
  );

  const time = await ask(
    '4호차 마지막 하원차 몇 시에 출발해요? 바뀌었다던데요.',
  );
  assert.equal(time.answer.status, 'answered', time.answer.answer);
  assert.match(time.answer.answer, /19:10/);
  assert.doesNotMatch(time.answer.answer, /19:00|20:00/);
  assert.deepEqual(
    time.answer.citations.map(({ documentId }) => documentId),
    ['DETOUR', 'BUS'],
  );
  assert.match(
    time.answer.citations[1].location ?? '',
    /열 차량, 회차, 정류장/,
  );
  assert.doesNotMatch(time.answer.citations[1].location ?? '', /열 시각/);

  for (const asOf of ['2026-11-10T12:00:00+09:00', until]) {
    const inactive = await ask(
      '4호차 마지막 하원차 몇 시에 출발해요? 바뀌었다던데요.',
      asOf,
    );
    assert.equal(inactive.answer.status, 'abstained');
    assert.equal(inactive.answer.citations.length, 0);
  }
});

test('임시 노선의 행·열에서 요청 차량, 방향, 회차와 정류장에 맞는 도착만 확인한다', async () => {
  const { register, ask } = setup();
  await register('REGULAR', 'schedule', '학원 차량 운행표', bus);
  await register(
    'TEMP',
    'announcement',
    '4호차 하원 노선 임시 변경',
    [
      '## 변경 후 4호차 하원 시각',
      '',
      '| 버드나무 도서관 | 회차 | 학원 출발 | 우체국 앞 |',
      '|---|---|---|---|',
      '| 18:20 | 1회차 | 18:00 | 18:25 |',
      '| 19:38 | 2회차 | 19:10 | 19:42 |',
    ].join('\n'),
  );
  const question = '공사 기간에 4호차 하원 2회차 버드나무 도서관 몇 시에 와요?';
  const result = await ask(question);
  assert.equal(result.trace.intent, 'changed_transit_arrival');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /19:38/);
  assert.doesNotMatch(result.answer.answer, /19:42|19:20|18:20/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['TEMP'],
  );
  assert.match(
    result.answer.citations[0].location ?? '',
    /열 회차, 버드나무 도서관/,
  );
  const unavailable = await ask(
    question.replace('버드나무 도서관', '시청 후문'),
  );
  assert.equal(unavailable.answer.status, 'abstained');
  assert.equal(unavailable.answer.citations.length, 0);
});

test('수업 종료와 같은 차량·회차의 출발과 도착을 연결하고 취소일에는 보류한다', async () => {
  const { register, ask } = setup();
  await register('BUS', 'schedule', '학원 차량 운행표', bus);
  await register(
    'CLASS',
    'schedule',
    '조형 시간표',
    '| 반 | 시간 |\n|---|---|\n| 초5 미술 2반 | 월~금 16:00~18:30 |',
    {
      facts: [
        {
          factType: 'schedule',
          subjectType: 'class',
          subjectId: 'STUDIO',
          value: { kind: 'schedule', text: '월~금 16:00~18:30' },
        },
      ],
    },
  );
  const question =
    '이번주 목요일에 초5 2반 끝나고 4호차 타면 버드나무 도서관 몇 시쯤 도착해요?';
  const result = await ask(question);
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /19:20/);
  assert.doesNotMatch(result.answer.answer, /18:20|19:27/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['CLASS', 'BUS'],
  );
  assert.match(
    result.answer.citations[1].location ?? '',
    /열 차량, 회차, 정류장, 시각/,
  );
  const text = '11월 12일 초5 미술 2반 수업은 휴강합니다.';
  await register('CANCEL', 'announcement', '수업 휴강 공지', text, {
    facts: [
      {
        factType: 'schedule_change',
        subjectType: 'class',
        subjectId: 'STUDIO',
        value: {
          kind: 'schedule_change',
          changeType: 'cancel',
          date: '2026-11-12',
          time: null,
          text,
        },
      },
    ],
  });
  const cancelled = await ask(question);
  assert.equal(cancelled.answer.status, 'abstained', cancelled.answer.answer);
  assert.equal(cancelled.answer.citations.length, 0);
});

test('시설 운영 시간은 날짜와 시설 이름을 함께 확인하고 방학 개원 시각을 분리한다', async () => {
  const { register, ask } = setup();
  const notice =
    '11월 12일(목)부터 11월 19일(목)까지 느티서재(자습실) 토요일 운영 시간을 20:00까지 늘립니다.';
  await register('HOURS', 'announcement', '자습실 운영 조정', notice, {
    facts: [{ factType: 'notice', value: { kind: 'text', text: notice } }],
  });
  const vacation =
    '겨울방학 기간에는 학원 평일 운영 시간을 08:30~18:30으로 앞당기고, 개인 연습실을 12:00부터 엽니다.';
  await register('BREAK', 'facility', '방학 운영 시간', vacation, {
    facts: [{ factType: 'facility', value: { kind: 'text', text: vacation } }],
  });
  const closing = await ask(
    '느티서재 토요일 몇 시까지 열어요? 이번주 토요일이요.',
  );
  assert.equal(closing.answer.status, 'answered', closing.answer.answer);
  assert.match(closing.answer.answer, /20:00/);
  assert.deepEqual(
    closing.answer.citations.map(({ documentId }) => documentId),
    ['HOURS'],
  );
  const expired = await ask(
    '느티서재 토요일 몇 시까지 열어요? 이번주 토요일이요.',
    '2026-11-23T15:00:00+09:00',
  );
  assert.doesNotMatch(expired.answer.answer, /20:00/);
  const opened = await ask('방학 때 학원 아침 몇 시에 열어요?');
  assert.equal(opened.answer.status, 'answered', opened.answer.answer);
  assert.match(opened.answer.answer, /08:30/);
  assert.doesNotMatch(opened.answer.answer, /12:00/);
});

test('승급 기준은 권한 있는 원생의 같은 과정 다음 단계에 연결한다', async () => {
  const { register, ask } = setup();
  const text = '레벨 평가 82점 이상이면 다음 레벨로 승급합니다';
  await register('RULE', 'announcement', '단계별 운영 규정', text, {
    facts: [{ factType: 'notice', value: { kind: 'text', text } }],
  });
  const result = await ask('레벨평가 몇 점 넘어야 L3 올라가요?');
  assert.equal(result.trace.intent, 'level_advancement_threshold');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /82점 이상/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['RULE'],
  );
  const sameLevel = await ask('레벨평가 몇 점 넘어야 L2 올라가요?');
  assert.notEqual(sameLevel.trace.intent, 'level_advancement_threshold');
});

test('차량 등록번호는 운행 시각이나 담당자 전용 문서에서 대체하지 않는다', async () => {
  const { register, ask } = setup();
  await register('BUS', 'schedule', '학원 차량 운행표', bus);
  const header = '| 등록번호 | 운행 차량 |\n|---|---|\n';
  await register(
    'PRIVATE',
    'facility',
    '내부 차량 목록',
    header + '| 123가1234 | 4호차 |',
    {
      visibility: 'staff_only',
    },
  );
  const question = '4호차 차량번호 뭐예요?';
  const unavailable = await ask(question);
  assert.equal(
    unavailable.answer.status,
    'abstained',
    unavailable.answer.answer,
  );
  assert.equal(unavailable.answer.citations.length, 0);
  await register(
    'PUBLIC',
    'facility',
    '공개 차량 목록',
    header + '| 121나4242 | 4호차 |',
  );
  const verified = await ask(question);
  assert.equal(verified.answer.status, 'answered', verified.answer.answer);
  assert.match(verified.answer.answer, /121나4242/);
  assert.doesNotMatch(verified.answer.answer, /123가1234|18:00/);
  assert.deepEqual(
    verified.answer.citations.map(({ documentId }) => documentId),
    ['PUBLIC'],
  );
});

test('회당 요금 후속 질문은 확인한 서비스의 개정 요금 열과 적용일을 인용한다', async () => {
  const { register, ask } = setup();
  await register(
    'SINGLE',
    'fee',
    '실기 상담 요금',
    '| 과정 | 1회 요금 | 4회권 |\n|---|---|---|\n| 디자인 첨삭 | 48,000원 | 180,000원 |',
  );
  await register(
    'REVISED',
    'fee',
    '개정 가격',
    '## 이용 요금 (2027년 2월 1일부터)\n\n| 개정 1회 요금 | 현재 1회 요금 | 과정 | 개정 4회권 |\n|---|---|---|---|\n| 65,000원 | 48,000원 | 영상 첨삭 | 250,000원 |\n| 52,000원 | 48,000원 | 디자인 첨삭 | 199,000원 |',
  );
  const current = await ask('디자인 첨삭 1회 요금 얼마예요?');
  assert.equal(current.answer.status, 'answered', current.answer.answer);
  assert.match(current.answer.answer, /48,000원/);
  const next = await ask('내년에도 같은 가격이에요?');
  assert.equal(next.answer.status, 'answered', next.answer.answer);
  assert.match(next.answer.answer, /2027년 2월 1일.*52,000원/);
  assert.doesNotMatch(next.answer.answer, /65,000원|199,000원/);
  assert.deepEqual(
    next.answer.citations.map(({ documentId }) => documentId),
    ['REVISED'],
  );
  assert.match(
    next.answer.citations[0].location ?? '',
    /열 과정, 현재 1회 요금, 개정 1회 요금/,
  );
});

test('키트와 다음 적용 시점의 교재비는 월 수강료나 기존 교재비로 대체하지 않는다', async () => {
  const { register, ask } = setup();
  await register(
    'FEE',
    'fee',
    '수강료와 교재비',
    '| 반 | 수강료 | 교재비 |\n|---|---|---|\n| 초5 미술 2반 | 150,000원 | 20,000원 |',
    { validTo: '2026-12-01T00:00:00+09:00' },
  );
  const kit = await ask('초5 미술 2반 키트 따로 사야 돼요? 얼마예요?');
  assert.equal(kit.answer.status, 'abstained', kit.answer.answer);
  const textbook = await ask(
    '12월에 초5 올라가면 초5 미술 2반 교재비 얼마예요?',
  );
  assert.equal(textbook.answer.status, 'abstained', textbook.answer.answer);
  await register(
    'KIT',
    'fee',
    '실습 키트',
    '| 실습 키트비 | 반 |\n|---|---|\n| 32,000원 | 초5 미술 2반 |',
  );
  const confirmed = await ask('초5 미술 2반 키트 가격이 얼마예요?');
  assert.equal(confirmed.answer.status, 'answered', confirmed.answer.answer);
  assert.match(confirmed.answer.answer, /32,000원/);
  assert.deepEqual(
    confirmed.answer.citations.map(({ documentId }) => documentId),
    ['KIT'],
  );
});
