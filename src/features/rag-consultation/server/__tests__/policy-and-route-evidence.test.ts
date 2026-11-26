import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type { AcademyCatalog, DocumentType, RagAccessScope } from '../types.ts';
import { runQuery } from './helpers.ts';

const asOf = '2026-11-20T15:00:00+09:00';
const catalog: AcademyCatalog = {
  academyId: 'POLICY_TEST',
  displayName: '예시학원',
  aliases: [],
  units: [],
  classes: [
    {
      classId: 'A',
      name: '중2 창작 1반',
      aliases: ['중2 1반', '창작반'],
      grade: '중2',
    },
    {
      classId: 'B',
      name: '중2 창작 2반',
      aliases: ['중2 2반', '창작반'],
      grade: '중2',
    },
    { classId: 'C', name: '초5 글쓰기반', aliases: [], grade: '초5' },
  ],
  studentDirectory: [{ studentId: 'S2', names: ['민해온', '해온'] }],
};
const access: RagAccessScope = {
  actorId: 'guardian',
  academyId: catalog.academyId,
  role: 'guardian',
  allowedStudentIds: ['S1'],
  allowedClassIds: ['A'],
  studentRefs: [
    {
      studentId: 'S1',
      displayLabel: '채나래',
      aliases: ['나래'],
      classIds: ['A'],
    },
  ],
  canViewPublicHistory: false,
};

function setup() {
  const store = new InMemoryRagStore();
  const register = (
    documentId: string,
    documentType: DocumentType,
    title: string,
    text: string,
    approve = true,
  ) =>
    store.upsertIndexedRevision({
      approve,
      document: {
        academyId: catalog.academyId,
        documentId,
        revision: 1,
        documentType,
        visibility: 'academy_public',
        title,
        validFrom: '2026-11-01T00:00:00+09:00',
        approvedAt: '2026-11-01T00:00:00+09:00',
        text,
      },
    });
  const ask = (question: string) =>
    runQuery(
      {
        store,
        catalog: { getAcademyCatalog: async () => catalog },
        resolveScope: () => access,
      },
      { engine: 'planned', userId: access.actorId, question, asOf },
    );
  return { register, ask, store };
}

test('학교 시험 결석은 같은 반과 학기의 예외 조항을 확인한다', async () => {
  const { register, ask } = setup();
  await register(
    'GENERAL',
    'policy',
    '보강 규정',
    '학교 시험으로 결석하면 다음 주에 보강을 진행합니다.',
  );
  await register(
    'OTHER',
    'schedule',
    '초등부 기말 대비 기간 변경 시간표',
    '기말 대비 기간에 학교 시험으로 결석하는 경우 보강은 토요일에 진행합니다.',
  );
  await register(
    'PREVIOUS_TERM',
    'schedule',
    '중등부 중간고사 대비 기간 변경 시간표',
    '중간고사 대비 기간에 학교 시험으로 결석하면 보강을 따로 진행합니다.',
  );
  await register(
    'EXAM_NOTICE',
    'schedule',
    '중등부 기말 대비 기간 변경 시간표',
    '기말 대비 기간에 학교 시험으로 결석하면 보강을 진행하지 않고 요약 노트와 해설 자료를 제공합니다.',
  );
  await register(
    'DRAFT_EXAM_NOTICE',
    'schedule',
    '중등부 기말 대비 기간 변경 시간표 초안',
    '기말 대비 기간에 학교 시험으로 결석하면 보강을 일요일에 진행합니다.',
    false,
  );
  const known = await ask(
    '기말 대비 기간에 학교 시험 때문에 빠지면 보강해 줘요?',
  );
  assert.equal(known.answer.status, 'answered', known.answer.answer);
  assert.match(
    known.answer.answer,
    /보강을 진행하지 않고.*요약 노트.*해설 자료/,
  );
  assert.doesNotMatch(known.answer.answer, /다음 주|토요일|일요일/);
  assert.deepEqual(
    known.answer.citations.map(({ documentId }) => documentId),
    ['EXAM_NOTICE'],
  );
  assert.equal(known.generationCalls, 0);
});

test('결석 연락 기한은 예정된 보강 시각과 구분하고 지정 반의 승인 규정을 우선한다', async () => {
  const { register, ask } = setup();
  await register(
    'GENERAL_MAKEUP',
    'policy',
    '결석 보강 규정',
    '결석 예정일 전날 20:00까지 연락하면 보강을 신청할 수 있습니다.',
  );
  await register(
    'CLASS_MAKEUP',
    'policy',
    '중2 창작 1반 결석 보강 규정',
    '학교 행사로 결석할 때는 수업 전날 18:10까지 연락하면 보강을 신청할 수 있습니다.',
  );
  await register(
    'OTHER_MAKEUP',
    'policy',
    '중2 창작 2반 결석 보강 규정',
    '결석 예정일 전날 22:00까지 연락하면 보강을 신청할 수 있습니다.',
  );
  await register(
    'DRAFT_MAKEUP',
    'policy',
    '중2 창작 1반 결석 보강 초안',
    '결석 예정일 전날 23:00까지 연락하면 보강을 신청할 수 있습니다.',
    false,
  );
  await register(
    'SCHEDULE_ONLY',
    'announcement',
    '강사 연수 휴강 보강',
    '보강 수업은 11월 25일 19:20에 진행합니다.',
  );
  const question =
    '중2 창작 1반 다음 주에 학교 행사 때문에 빠져야 하는데 언제까지 알려야 보충해 줘요?';
  const result = await ask(question);
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /18:10까지 연락/);
  assert.doesNotMatch(result.answer.answer, /20:00|22:00|23:00|19:20/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['CLASS_MAKEUP'],
  );
  assert.match(result.answer.citations[0].location ?? '', /문단 1/);
  assert.equal(result.generationCalls, 0);

  await register(
    'CONFLICT_MAKEUP',
    'policy',
    '중2 창작 1반 추가 결석 보강 규정',
    '결석 예정일 전날 19:15까지 연락하면 보강을 신청할 수 있습니다.',
  );
  const conflict = await ask(question);
  assert.equal(conflict.answer.status, 'abstained', conflict.answer.answer);
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(conflict.answer.citations, []);
});

test('이미 발생한 질병 결석과 예정된 결석에 각각 맞는 증빙·연락 규정을 인용한다', async () => {
  const { register, ask } = setup();
  await register(
    'ABSENCE',
    'policy',
    '결석 보강 운영 규정',
    '## 결석 및 보강\n\n1. 결석 예정일 전날 18:40까지 연락하면 보강을 신청할 수 있습니다.\n2. 질병으로 당일 결석한 경우 소견서를 내면 사전에 연락한 결석과 같이 처리합니다.',
  );
  await register(
    'ATTENDANCE_ONLY',
    'policy',
    '출결 규정',
    '질병으로 결석한 학생은 출결 기록을 위해 진단서를 제출해야 합니다.',
  );
  const happened = await ask('어제 아파서 학원 못 갔는데 보충 받을 수 있어요?');
  assert.equal(happened.answer.status, 'answered', happened.answer.answer);
  assert.match(happened.answer.answer, /소견서를 내면/);
  assert.doesNotMatch(happened.answer.answer, /18:40|진단서/);
  assert.deepEqual(
    happened.answer.citations.map(({ documentId }) => documentId),
    ['ABSENCE'],
  );
  const planned = await ask('아이가 아파서 결석하게 되면 보강 받을 수 있나요?');
  assert.equal(planned.answer.status, 'answered', planned.answer.answer);
  assert.match(planned.answer.answer, /18:40.*\n.*소견서를 내면/);

  const actual = await ask('어제 아파서 결석했는데 보강 일정은 언제예요?');
  assert.equal(actual.answer.status, 'abstained', actual.answer.answer);
  assert.doesNotMatch(actual.answer.answer, /소견서|18:40/);
});

test('원어민 스피킹 결석은 해당 수업의 승인 대체 조항을 사용한다', async () => {
  const { register, ask } = setup();
  await register(
    'NATIVE_POLICY',
    'policy',
    '결석 보강 규정',
    [
      '## 결석 및 보강',
      '',
      '1. 정규 수업 결석분은 자습실에서 별도 보강을 진행합니다.',
      '2. 비원어민 스피킹 수업 결석분은 다른 반에서 보강을 진행합니다.',
      '3. 원어민 스피킹 수업 결석분은 음성 과제 피드백으로 대체할 수 있습니다.',
    ].join('\n'),
  );
  await register(
    'NATIVE_NOTICE',
    'schedule',
    '원어민 스피킹 정규 시간표',
    '| 수업 | 시간 |\n|---|---|\n| 원어민 스피킹 | 18:30~19:20 |',
  );
  const result = await ask('오늘 원어민 수업 빠졌는데 보충 따로 해주나요?');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /음성 과제 피드백으로 대체할 수/);
  assert.doesNotMatch(result.answer.answer, /다른 반|자습실|18:30/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['NATIVE_POLICY'],
  );
  assert.equal(result.generationCalls, 0);
});

test('확정된 개인 보강은 권한 있는 원생의 같은 결석일에 연결된 일정만 답한다', async () => {
  const { store, ask } = setup();
  const validFrom = '2026-11-19T09:00:00+09:00';
  for (const [id, studentId, absence, date, time, approve] of [
    ['APPOINTMENT', 'S1', '11월 19일', '2026-11-25', '18:20', true],
    ['OTHER_DAY', 'S1', '11월 18일', '2026-11-24', '19:20', true],
    ['OTHER_STUDENT', 'S2', '11월 19일', '2026-11-26', '20:20', true],
    ['PENDING_APPOINTMENT', 'S1', '11월 19일', '2026-11-27', '21:20', false],
  ] as const) {
    const sourceId = id + ':r1:body';
    const text =
      absence + ' 수업 결석분 보강 일정은 ' + date + ' ' + time + '입니다.';
    await store.upsertIndexedRevision({
      approve,
      document: {
        academyId: catalog.academyId,
        documentId: id,
        revision: 1,
        sourceId,
        studentId,
        classId: 'A',
        documentType: 'announcement',
        visibility: 'student_private',
        title: '개인 보강 안내',
        text,
        validFrom,
        approvedAt: validFrom,
      },
      facts: [
        {
          academyId: catalog.academyId,
          factId: id + '_FACT',
          documentId: id,
          sourceId,
          revision: 1,
          subjectType: 'student',
          subjectId: studentId,
          factType: 'schedule_change',
          period: null,
          validFrom,
          approvalStatus: 'approved',
          value: {
            kind: 'schedule_change',
            changeType: 'makeup',
            date,
            time,
            text,
          },
        },
      ],
    });
  }
  const result = await ask('어제 아파서 결석했는데 보강 일정은 언제예요?');
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /11월 19일 결석분.*11월 25일 18:20/);
  assert.doesNotMatch(result.answer.answer, /19:20|20:20|21:20/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['APPOINTMENT'],
  );
  assert.equal(result.generationCalls, 0);

  const denied = await ask(
    '민해온은 어제 아파서 결석했는데 보강 일정은 언제예요?',
  );
  assert.equal(denied.answer.status, 'denied');
  assert.deepEqual(denied.trace.retrievedFactIds, []);
  assert.deepEqual(denied.answer.citations, []);
});

test('자습실 이용 대상은 같은 학교급의 승인 안내를 비교한다', async () => {
  const { register, ask } = setup();
  const question = '초등학생도 수업 끝나고 자습실을 쓸 수 있나요?';
  await register(
    'FACILITY_LIMIT',
    'facility',
    '자습실 안내',
    '| 시설 | 이용 안내 |\n|---|---|\n| 자습실 | 중등부 원생만 이용 |',
  );
  await register(
    'PARENT_POST',
    'announcement',
    '자습실 문의 게시판',
    '[질문] 초등학생도 자습실을 이용할 수 있나요?\n\n[답변] 초등부 학부모 | 2026-11-05\n자습실은 초등부도 이용 가능합니다.',
  );
  await register(
    'FACILITY_DRAFT',
    'facility',
    '자습실 운영 초안',
    '자습실은 초등부·중등부 모두 이용 가능합니다.',
    false,
  );
  const restricted = await ask(question);
  assert.equal(restricted.answer.status, 'answered', restricted.answer.answer);
  assert.match(restricted.answer.answer, /중등부 원생만 이용/);
  assert.deepEqual(
    restricted.answer.citations.map(({ documentId }) => documentId),
    ['FACILITY_LIMIT'],
  );
  await register(
    'OFFICIAL_REPLY',
    'announcement',
    '시설 질문 답변 게시판',
    '[질문] 초등학생도 자습실에 들어갈 수 있나요?\n\n[답변] 예시학원 데스크 | 2026-11-09\n자습실은 초등부·중등부 원생 모두 평일에 이용할 수 있습니다.',
  );
  const conflict = await ask(question);
  assert.equal(conflict.answer.status, 'abstained', conflict.answer.answer);
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(conflict.answer.citations, []);
  assert.equal(conflict.generationCalls, 0);
});

test('반 변경 수강료는 월별 수강료 대신 승인된 정산 규정이 있어야 답한다', async () => {
  const { register, ask } = setup();
  const question =
    '나래가 중간에 중2 창작 2반으로 옮기면 수강료 다시 계산해요?';
  await register(
    'TUITION_TABLE',
    'fee',
    '중등부 수강료',
    '| 반 | 월 수강료 |\n|---|---|\n| 중2 창작 1반 | 240,000원 |\n| 중2 창작 2반 | 240,000원 |',
  );
  const missing = await ask(question);
  assert.equal(missing.answer.status, 'abstained', missing.answer.answer);
  assert.doesNotMatch(missing.answer.answer, /240,000원/);
  await register(
    'TRANSFER_RULE',
    'policy',
    '반 변경 및 정산 규정',
    '같은 과정에서 반을 변경하면 남은 수업의 수강료 차액만 다음 달에 반영합니다.',
  );
  const known = await ask(question);
  assert.equal(known.answer.status, 'answered', known.answer.answer);
  assert.match(known.answer.answer, /남은 수업의 수강료 차액만 다음 달에 반영/);
  assert.deepEqual(
    known.answer.citations.map(({ documentId }) => documentId),
    ['TRANSFER_RULE'],
  );
  assert.equal(known.generationCalls, 0);
});

test('입실 가능 시점과 입실 마감 시점을 구분한다', async () => {
  const { register, ask } = setup();
  await register(
    'ARRIVAL_DEADLINE',
    'schedule',
    '교실 이용 안내',
    '지각 방지를 위해 수업 시작 3분 전까지 입실해 주세요.',
  );
  const question = '학원 일찍 가면 교실 몇 분 전부터 들어갈 수 있어요?';
  const unsupported = await ask(question);
  assert.equal(
    unsupported.answer.status,
    'abstained',
    unsupported.answer.answer,
  );
  assert.deepEqual(unsupported.answer.citations, []);
  await register(
    'ROOM_ACCESS',
    'schedule',
    '강의실 입실 안내',
    '강의실은 수업 시작 12분 전부터 입실할 수 있습니다.',
  );
  const result = await ask(question);
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /12분 전부터/);
  assert.doesNotMatch(result.answer.answer, /3분 전/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['ROOM_ACCESS'],
  );
});

test('자습실 요금과 요일별 운영 시간, 입학 시험 시각에 각각 맞는 규정을 인용한다', async () => {
  const { register, ask } = setup();
  await register(
    'ROOM',
    'facility',
    '시설 이용 안내',
    [
      '## 자습실',
      '',
      '- 자습실 운영: 평일 13:00~21:00, 토요일 11:20~17:40.',
      '- 재원생은 추가 비용 없이 이용할 수 있습니다.',
      '- 상담실은 토요일 09:00~11:00 운영합니다.',
    ].join('\n'),
  );
  await register(
    'ENTRY_EXAM',
    'academy_info',
    '입학 레벨테스트 안내',
    '레벨테스트는 평일 15:00~17:00, 토요일 10:40~12:20에 진행합니다. 입학 상담은 토요일 13:00~15:00입니다.',
  );
  const hours = await ask('토요일 공부방 몇 시까지 열어요?');
  assert.equal(hours.answer.status, 'answered', hours.answer.answer);
  assert.match(hours.answer.answer, /토요일 11:20~17:40/);
  assert.doesNotMatch(hours.answer.answer, /13:00|09:00|10:40/);
  assert.deepEqual(
    hours.answer.citations.map(({ documentId }) => documentId),
    ['ROOM'],
  );

  const fee = await ask('자습하는 방 이용하려면 돈 따로 내요?');
  assert.equal(fee.answer.status, 'answered', fee.answer.answer);
  assert.match(fee.answer.answer, /재원생은 추가 비용 없이/);
  assert.doesNotMatch(fee.answer.answer, /11:20|17:40/);
  assert.deepEqual(
    fee.answer.citations.map(({ documentId }) => documentId),
    ['ROOM'],
  );

  const exam = await ask('학원 들어가기 전에 보는 시험 토요일 몇 시에 봐요?');
  assert.equal(exam.answer.status, 'answered', exam.answer.answer);
  assert.match(exam.answer.answer, /토요일 10:40~12:20/);
  assert.doesNotMatch(exam.answer.answer, /15:00|13:00|17:40/);
  assert.deepEqual(
    exam.answer.citations.map(({ documentId }) => documentId),
    ['ENTRY_EXAM'],
  );
  assert.equal(exam.generationCalls, 0);
});

const assignments = [
  '## 학교별 하교와 등원 회차',
  '',
  '| 학년 | 픽업 차량·회차 | 요일 | 학교 | 하교 시간 |',
  '|---|---|---|---|---|',
  '| 1~6학년 | 1호차 등원 1회차 | 수 | 햇살초 | 12:10 |',
  '| 3·4학년 | 2호차 등원 2회차 | 월·화·목·금 | 햇살초 | 13:20 |',
  '| 3·4학년 | 3호차 등원 1회차 | 월~금 | 햇빛초 | 14:20 |',
].join('\n');
const stops = [
  '## 정류장 시각',
  '',
  '| 차량 | 회차 | 시각 | 정류장 |',
  '|---|---|---|---|',
  '| 1호차 | 등원 1회차 | 12:25 | 햇살초 정문 |',
  '| 2호차 | 등원 2회차 | 13:37 | 햇살초 후문 |',
  '| 2호차 | 등원 2회차 | 13:31 | 햇살초 정문 |',
  '| 2호차 | 하원 2회차 | 19:00 | 햇살초 정문 |',
  '| 3호차 | 등원 1회차 | 14:28 | 햇빛초 정문 |',
].join('\n');

test('학교 픽업은 학교·학년·요일과 승인 문서 내 등원 회차·정류장을 연결한다', async () => {
  const { register, ask } = setup();
  await register(
    'BUS',
    'schedule',
    '통학차 운행표',
    assignments + '\n\n' + stops,
  );
  const result = await ask(
    '햇살초등학교 4학년 목요일 픽업은 정문에 몇 시에 와요?',
  );
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.equal(result.trace.intent, 'school_pickup');
  assert.match(result.answer.answer, /2호차.*2회차.*\n.*13:31/);
  assert.doesNotMatch(
    result.answer.answer,
    /13:37|19:00|14:28|12:25|하교 시간/,
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행 · 열 학교, 요일, 학년, 픽업 차량·회차/,
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /3행 · 열 차량, 회차, 정류장, 시각/,
  );
  const dismissal = await ask(
    '햇살초 4학년은 몇 시에 하교하고 몇 호차가 데리러 와요?',
  );
  assert.equal(dismissal.answer.status, 'answered', dismissal.answer.answer);
  assert.match(dismissal.answer.answer, /13:20/);
  assert.match(dismissal.answer.answer, /12:10/);
  assert.doesNotMatch(dismissal.answer.answer, /13:31|12:25|14:20/);
  assert.equal(result.generationCalls + dismissal.generationCalls, 0);
});

test('등원 차량 배정은 다른 승인 문서나 초안의 회차 시각과 합치지 않는다', async () => {
  const { register, ask } = setup();
  await register('ASSIGN', 'schedule', '통학차 배정표', assignments);
  await register('OTHER', 'schedule', '별도 노선 정류장 표', stops);
  await register(
    'DRAFT',
    'schedule',
    '검토 중인 운행표',
    assignments + '\n\n' + stops,
    false,
  );
  const result = await ask('햇살초 4학년 목요일 픽업은 정문에 몇 시에 와요?');
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.deepEqual(result.answer.missingFields, ['정류장 도착 시각']);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['ASSIGN'],
  );
  assert.doesNotMatch(result.answer.answer, /13:31|19:00/);
});

test('평가 소요 시간과 결과 안내를 같은 절에서 찾고 이름이 다른 테스트는 제외한다', async () => {
  const { register, ask } = setup();
  await register(
    'ASSESS',
    'policy',
    '운영 규정',
    [
      '## 재원생 레벨 평가',
      '',
      '레벨 평가는 실습 35분 동안 진행합니다.',
      '',
      '레벨 평가 결과는 학기가 끝난 뒤 2주 안에 문자로 안내합니다.',
      '',
      '## 신규 원생 레벨 테스트',
      '',
      '레벨 테스트는 실습 55분으로 진행합니다.',
      '',
      '레벨 테스트 결과는 3일 안에 전화로 안내합니다.',
    ].join('\n'),
  );
  const result = await ask(
    '레벨 평가는 시험 시간이 얼마나 돼요? 결과는 언제 알려주세요?',
  );
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /35분.*\n.*2주/);
  assert.doesNotMatch(result.answer.answer, /55분|3일/);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /재원생 레벨 평가.*문단.*재원생 레벨 평가.*문단/,
  );
  assert.equal(result.generationCalls, 0);
});

test('제출 기한은 제출 뒤 처리 시간과 구분하고 시험 기간 영상 예외를 우선한다', async () => {
  const { register, ask } = setup();
  await register(
    'DUE',
    'academy_info',
    '첨삭 안내',
    [
      '## 원고 제출',
      '',
      '원고 제출: 수업 3일 전 19:30까지 앱으로 원고를 올립니다.',
      '',
      '수정 원고를 올리면 2일 이내에 피드백을 보냅니다.',
    ].join('\n'),
  );
  await register(
    'VIDEO',
    'policy',
    '학원 운영 규정',
    '결석한 수업의 녹화 영상은 올린 날부터 5일 동안 볼 수 있습니다.',
  );
  await register(
    'EXCEPTION',
    'schedule',
    '기말고사 대비 중등부 변경 시간표',
    '변경 시간표 기간에는 결석해도 수업 영상을 제공하지 않으며, 결석한 내용은 토요일 질문 교실(10:20~11:30)에서 보충합니다.',
  );
  const deadline = await ask('첨삭 원고는 언제까지 올려야 해요?');
  assert.equal(deadline.answer.status, 'answered', deadline.answer.answer);
  assert.match(deadline.answer.answer, /3일 전 19:30/);
  assert.doesNotMatch(deadline.answer.answer, /2일 이내/);
  const duration = await ask('결석하면 녹화 영상은 며칠 동안 볼 수 있어요?');
  assert.equal(duration.answer.status, 'answered', duration.answer.answer);
  assert.match(duration.answer.answer, /5일 동안/);
  const exception = await ask(
    '나래가 시험기간에 결석하면 영상으로 보면 되나요?',
  );
  assert.equal(exception.answer.status, 'answered', exception.answer.answer);
  assert.match(exception.answer.answer, /제공하지 않.*10:20~11:30/);
  assert.doesNotMatch(exception.answer.answer, /5일/);
  assert.equal(exception.answer.citations[0]?.documentId, 'EXCEPTION');
});

test('과목 순서와 시간표 전제 확인은 승인된 반과 요청된 열을 인용한다', async () => {
  const { register, ask } = setup();
  await register(
    'TIME',
    'schedule',
    '정규 시간표',
    [
      '| 반 | 과목 순서 | 요일 | 시간 | 강의실 |',
      '|---|---|---|---|---|',
      '| 중2 창작 1반 | 작문 → 독서 (각 30분) | 월·수 | 16:00~17:00 | 501호 |',
      '| 중2 창작 2반 | 문학 → 발표 (각 45분) | 화·목 | 17:15~18:45 | 601호 |',
      '| 초5 글쓰기반 | 글쓰기 → 독서 | 화 | 14:15~15:45 | 701호 |',
    ].join('\n'),
  );
  const order = await ask('나래 창작반 과목 순서 알려주세요');
  assert.equal(order.answer.status, 'answered', order.answer.answer);
  assert.match(order.answer.answer, /작문 → 독서.*30분/);
  assert.doesNotMatch(order.answer.answer, /발표|45분|501호/);
  assert.match(
    order.answer.citations[0]?.location ?? '',
    /1행 · 열 반, 과목 순서$/,
  );
  const wrongClass = await ask(
    '나래 중2 2반이죠? 2반 끝나는 시간은 몇 시예요?',
  );
  assert.equal(wrongClass.answer.status, 'answered', wrongClass.answer.answer);
  assert.match(wrongClass.answer.answer, /중2 창작 1반.*월·수.*16:00~17:00/);
  assert.doesNotMatch(wrongClass.answer.answer, /17:15|창작 2반/);
  const wrongDay = await ask('초5 수업 수요일 맞죠? 몇 시예요?');
  assert.equal(wrongDay.answer.status, 'answered', wrongDay.answer.answer);
  assert.match(wrongDay.answer.answer, /요일: 화.*14:15~15:45/);
  assert.match(
    wrongDay.answer.citations[0]?.location ?? '',
    /3행 · 열 반, 요일, 시간$/,
  );
});

test('이름에 붙인 호칭으로 권한 밖 학생을 지칭해도 검색 전에 거부한다', async () => {
  const { ask } = setup();
  const result = await ask('해온언니는 몇 점이에요?');
  assert.equal(result.answer.status, 'denied');
  assert.deepEqual(result.answer.citations, []);
  assert.deepEqual(result.trace.retrievedFactIds, []);
  assert.deepEqual(result.trace.retrievedChunkIds, []);
  assert.equal(result.generationCalls, 0);
});
