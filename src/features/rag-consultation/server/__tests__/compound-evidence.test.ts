import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type {
  AcademyCatalog,
  ApprovedFactInput,
  DocumentType,
  RagAccessScope,
} from '../types.ts';
import { runQuery } from './helpers.ts';

const catalog: AcademyCatalog = {
  academyId: 'COMPOUND_TEST',
  displayName: '예시 학원',
  aliases: [],
  units: [],
  classes: [
    { classId: 'A', name: '초5 종합 1반', grade: '초5', aliases: ['초5 1반'] },
    { classId: 'B', name: '초5 종합 2반', grade: '초5', aliases: ['초5 2반'] },
    { classId: 'C', name: '초5 종합 3반', grade: '초5', aliases: ['초5 3반'] },
    {
      classId: 'LOW',
      name: '영어 독해반(초3·4)',
      grade: '초3~초4',
      aliases: ['영어 독해반'],
    },
    {
      classId: 'HIGH',
      name: '영어 독해반(초5·6)',
      grade: '초5~초6',
      aliases: ['영어 독해반'],
    },
    { classId: 'G1', name: '중1 창작반', grade: '중1', aliases: [] },
    { classId: 'G2', name: '중2 창작반', grade: '중2', aliases: [] },
    { classId: 'M1', name: 'M1 조립 로봇반', aliases: [] },
    { classId: 'M2', name: 'M2 제어 로봇반', aliases: [] },
    { classId: 'M3', name: 'M3 자율 로봇반', aliases: [] },
    { classId: 'D', name: 'R5 제작 평일반', aliases: [] },
    { classId: 'S', name: 'R5 제작 토요반', aliases: [] },
    { classId: 'EDIT', name: '논술 첨삭 코스', aliases: [] },
  ],
};
const start = '2026-11-01T00:00:00+09:00';
const visitor: RagAccessScope = {
  actorId: 'visitor',
  academyId: catalog.academyId,
  role: 'visitor',
  allowedStudentIds: [],
  allowedClassIds: [],
  studentRefs: [],
  canViewPublicHistory: false,
};

function setup(fixtureCatalog = catalog) {
  const store = new InMemoryRagStore();
  const register = (
    documentId: string,
    documentType: DocumentType,
    title: string,
    text: string,
    options: {
      approve?: boolean;
      facts?: ApprovedFactInput[];
      classId?: string;
    } = {},
  ) =>
    store.upsertIndexedRevision({
      approve: options.approve ?? true,
      facts: options.facts,
      document: {
        academyId: catalog.academyId,
        documentId,
        revision: 1,
        documentType,
        visibility: 'academy_public',
        classId: options.classId,
        title,
        text,
        validFrom: start,
        approvedAt: start,
      },
    });
  const ask = (question: string, scope = visitor) =>
    runQuery(
      {
        store,
        catalog: { getAcademyCatalog: async () => fixtureCatalog },
        resolveScope: () => scope,
      },
      {
        engine: 'planned',
        userId: scope.actorId,
        question,
        asOf: '2026-11-21T11:00:00+09:00',
      },
    );
  return { register, ask };
}

function seat(
  documentId: string,
  classId: string,
  text: string,
  remaining: number,
): ApprovedFactInput {
  return {
    factId: documentId + '-' + classId,
    sourceId: documentId + ':r1:body',
    documentId,
    revision: 1,
    academyId: catalog.academyId,
    subjectType: 'class',
    subjectId: classId,
    factType: 'enrollment_status',
    value: {
      kind: 'enrollment',
      status: remaining ? 'open' : 'waitlist',
      capacity: 10,
      remaining,
      text,
    },
    period: null,
    validFrom: start,
    approvalStatus: 'approved',
  };
}

test('둘 다는 비용과 강사를 가리키고 다른 반으로 대상이 넓어지지 않는다', async () => {
  const { register, ask } = setup();
  await register(
    'COMPOUND_FEE',
    'fee',
    '반별 비용',
    '| 반 | 월 수강료 |\n|---|---|\n| 초5 종합 1반 | 180,000원 |\n| 초5 종합 2반 | 230,000원 |',
  );
  const teacher = (classId: string, name: string): ApprovedFactInput => ({
    factId: 'COMPOUND_TEACHER-' + classId,
    documentId: 'COMPOUND_TEACHER',
    sourceId: 'COMPOUND_TEACHER:r1:body',
    revision: 1,
    academyId: catalog.academyId,
    subjectType: 'class',
    subjectId: classId,
    factType: 'teacher',
    value: { kind: 'text', text: name },
    period: null,
    validFrom: start,
    approvalStatus: 'approved',
  });
  await register(
    'COMPOUND_TEACHER',
    'teacher',
    '담당 강사',
    '| 반 | 담당 강사 |\n|---|---|\n| 초5 종합 1반 | 김동호 강사 |\n| 초5 종합 2반 | 한우진 강사 |',
    { facts: [teacher('A', '김동호 강사'), teacher('B', '한우진 강사')] },
  );
  const { answer } = await ask(
    '초5 종합 1반 수강료랑 담당 강사 둘 다 알려주세요.',
  );
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /180,000원/);
  assert.match(answer.answer, /김동호 강사/);
  assert.doesNotMatch(answer.answer, /한우진|230,000/);
  assert.deepEqual(
    answer.citations.map(({ documentId, location }) => [documentId, location]),
    [
      ['COMPOUND_FEE', '표 1 · 1행 · 열 반, 월 수강료'],
      ['COMPOUND_TEACHER', '표 1 · 1행'],
    ],
  );
});

test('와·과로 연결한 비용과 요일 시간표를 각각 같은 반의 근거로 확인한다', async () => {
  const { register, ask } = setup();
  await register(
    'COORD_FEE',
    'fee',
    '반별 비용',
    '| 반 | 월 수강료 |\n|---|---|\n| 초5 종합 1반 | 180,000원 |\n| 초5 종합 2반 | 230,000원 |',
  );
  await register(
    'COORD_CLOCK',
    'schedule',
    '정규 수업 시간표',
    '| 반 | 요일 | 시작 | 종료 | 교실 |\n|---|---|---|---|---|\n| 초5 종합 1반 | 화요일 | 17:00 | 18:00 | 301호 |\n| 초5 종합 2반 | 화요일 | 18:20 | 19:20 | 302호 |',
  );
  const { answer, trace } = await ask(
    '초5 종합 1반 월 수강료와 화요일 수업 시간표를 알려주세요.',
  );
  assert.equal(trace.intent, 'multi(2)');
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /180,000원/);
  assert.match(answer.answer, /17:00/);
  assert.doesNotMatch(answer.answer, /18:20|230,000/);
  assert.deepEqual(
    answer.citations.map(({ documentId, location }) => [documentId, location]),
    [
      ['COORD_FEE', '표 1 · 1행 · 열 반, 월 수강료'],
      ['COORD_CLOCK', '표 1 · 1행 · 열 반, 요일, 시작, 종료, 교실'],
    ],
  );
});

const letterCatalog = {
  ...catalog,
  classes: [
    {
      classId: 'LA',
      name: '중1 실습A반',
      aliases: ['중1 A반'],
      grade: '중1',
      subject: '과학',
    },
    {
      classId: 'LB',
      name: '중1 실습B반',
      aliases: ['중1 B반'],
      grade: '중1',
      subject: '과학',
    },
    {
      classId: 'LX',
      name: '중2 실습B반',
      aliases: ['중2 B반'],
      grade: '중2',
      subject: '과학',
    },
    {
      classId: 'LC',
      name: '중1 로봇B반',
      aliases: [],
      grade: '중1',
      subject: '공학',
    },
  ],
};

test('공개 반 편성 기준은 같은 학년과 과정의 반을 비교한다', async () => {
  const { register, ask } = setup(letterCatalog);
  await register(
    'OTHER_GROUP',
    'academy_info',
    '중2 편성',
    '중2 실습A반과 실습B반은 수준별 반이 아닙니다. 같은 학년의 A반과 B반은 같은 진도를 나가며 수업은 수·토입니다.',
  );
  const question = '중1 A반 B반은 어느 쪽이 레벨이 높은 반이에요?';
  const missing = await ask(question);
  assert.equal(missing.answer.status, 'abstained', missing.answer.answer);
  assert.deepEqual(missing.answer.citations, []);
  await register(
    'GROUP_RULE',
    'academy_info',
    '중1 편성',
    '실습A반과 실습B반은 수준별 반이 아닙니다. 같은 학년의 A반과 B반은 같은 교재로 같은 진도를 배우며 요일만 다릅니다(A반 월·목, B반 화·금).',
  );
  const known = await ask(question);
  assert.equal(known.answer.status, 'answered', known.answer.answer);
  assert.match(known.answer.answer, /A반 월·목.*B반 화·금/);
  assert.doesNotMatch(known.answer.answer, /수·토/);
  assert.deepEqual(
    known.answer.citations.map(({ documentId }) => documentId),
    ['GROUP_RULE'],
  );
  const roster = await ask('중1 A반과 B반 학생들 이름 전체 명단 알려줘');
  assert.equal(roster.answer.status, 'denied');
  assert.deepEqual(roster.trace.retrievedChunkIds, []);
});

test('개설 여부는 학원의 승인 수강 대상 범위로 확인한다', async () => {
  const { register, ask } = setup(letterCatalog);
  await register(
    'TUTOR',
    'teacher',
    '강사 소개',
    '고등 통합과학 연계 자료를 제공한 경험이 있습니다.',
  );
  const question = '고등학생 통합과학 수업도 하나요?';
  const unknown = await ask(question);
  assert.equal(unknown.answer.status, 'abstained', unknown.answer.answer);
  assert.deepEqual(unknown.answer.citations, []);
  await register(
    'SCHOOL_SCOPE',
    'academy_info',
    '수강 대상 안내',
    '예시학원은 초등학교 4학년부터 중학교 2학년까지 과학 수업을 운영합니다.',
  );
  const known = await ask(question);
  assert.equal(known.answer.status, 'answered', known.answer.answer);
  assert.match(known.answer.answer, /초등학교 4학년부터 중학교 2학년까지/);
  assert.doesNotMatch(known.answer.answer, /연계 자료/);
  assert.deepEqual(
    known.answer.citations.map(({ documentId }) => documentId),
    ['SCHOOL_SCOPE'],
  );
});

test('대기 불가와 대체 반 잔여석은 같은 모집 공지에서 함께 확인한다', async () => {
  const { register, ask } = setup(letterCatalog);
  const id = 'CLOSED_OPEN';
  const rules = [
    '마감된 반은 대기 접수를 받지 않습니다.',
    '같은 학년의 다른 반(A반 ↔ B반)은 같은 진도로 수업하며, 자리가 있는 반으로 등록할 수 있습니다.',
  ].join('\n');
  await register(
    id,
    'announcement',
    '반별 모집 현황',
    [
      '| 모집 상태 | 반 |',
      '|---|---|',
      '| 모집 중 (잔여 2석) | 중2 실습B반 |',
      '| 마감 | 중1 실습A반 |',
      '| 모집 중 (잔여 2석) | 중1 실습B반 |',
      '',
      rules,
    ].join('\n'),
    {
      facts: [
        {
          ...seat(id, 'LA', '마감', 0),
          value: {
            kind: 'enrollment',
            status: 'closed',
            capacity: 10,
            remaining: 0,
            text: '마감',
          },
        },
        seat(id, 'LX', '모집 중 (잔여 2석)', 2),
        seat(id, 'LB', '모집 중 (잔여 2석)', 2),
      ],
    },
  );
  const question = '중1 A반 자리 있어요? 없으면 대기 걸어둘게요';
  const known = await ask(question);
  assert.equal(known.answer.status, 'answered', known.answer.answer);
  assert.match(
    known.answer.answer,
    /중1 실습A반.*마감.*\n.*대기 접수를 받지 않/,
  );
  assert.match(known.answer.answer, /중1 실습B반.*잔여 2석/);
  assert.doesNotMatch(known.answer.answer, /중2 실습B반|로봇/);
  assert.deepEqual(known.trace.usedFactIds, [id + '-LA', id + '-LB']);
  const location = known.answer.citations[0].location ?? '';
  assert.match(location, /2행 · 열 반, 모집 상태/);
  assert.match(location, /3행 · 열 반, 모집 상태/);
  assert.doesNotMatch(location, /표 1 · 1행/);
  assert.equal(known.generationCalls, 0);
});

test('반 평균은 보류하고 공개 시간표의 해당 요일과 시각은 답한다', async () => {
  const { register, ask } = setup();
  await register(
    'GROUP_TIMES',
    'schedule',
    '창작반 수업 시간표',
    [
      '| 교시(평일 / 토요일) | 월 | 목 | 토 |',
      '|---|---|---|---|',
      '| 1교시 (평일 17:10~18:30 / 토 11:00~12:20) | 중1 창작반 | 중1 창작반 | 중2 창작반 |',
    ].join('\n'),
  );
  const result = await ask(
    '중1 창작반 수업 몇시에 해요? 그리고 반 평균 점수는 어느 정도예요?',
  );
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.match(result.answer.answer, /월요일 17:10~18:30.*목요일 17:10~18:30/);
  assert.doesNotMatch(result.answer.answer, /11:00|12:20|중2 창작반/);
  assert.deepEqual(result.answer.missingFields, ['성적 통계']);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['GROUP_TIMES'],
  );
  assert.match(
    result.answer.citations[0].location ?? '',
    /열 교시\(평일 \/ 토요일\), 월, 목/,
  );
  assert.equal(result.generationCalls, 0);
});

test('등하원과 상담 주차 요금을 구분하고 확인되지 않은 시설은 부분 답변에 남긴다', async () => {
  const { register, ask } = setup();
  await register(
    'CURR',
    'academy_info',
    '학습 계획',
    '| 과정 | 주차 | 내용 |\n|---|---|---|\n| 미술반 | 2주차 | 초상화 |',
  );
  await register(
    'PARK',
    'facility',
    '시설 안내',
    '건물 지하 주차장을 이용하실 수 있습니다. 상담이나 공개수업으로 방문하시면 2시간 무료 주차권을 드립니다.',
  );
  const pickup = await ask(
    '아이 데리러 갈 때 건물 주차장에 대도 돼요? 주차비 있어요?',
  );
  assert.equal(pickup.answer.status, 'partial', pickup.answer.answer);
  assert.match(pickup.answer.answer, /지하 주차장/);
  assert.doesNotMatch(pickup.answer.answer, /2시간|무료|초상화/);
  assert.deepEqual(
    pickup.answer.citations.map(({ documentId }) => documentId),
    ['PARK'],
  );
  const consultation = await ask(
    '상담 갈 때 주차 되나요? 그리고 수유실 있는지도 궁금해요',
  );
  assert.equal(
    consultation.answer.status,
    'partial',
    consultation.answer.answer,
  );
  assert.match(consultation.answer.answer, /2시간 무료/);
  assert.deepEqual(consultation.answer.missingFields, ['수유실']);
  const without = await ask('상담 없이 들를 때 주차 무료인가요?');
  assert.equal(without.answer.status, 'abstained', without.answer.answer);
  assert.doesNotMatch(without.answer.answer, /2시간/);
});

test('반명에 붙은 대상 학년을 우선하고 수강료와 교재비를 독립적으로 비교한다', async () => {
  const { register, ask } = setup();
  await register(
    'FEE',
    'fee',
    '수강료 안내',
    [
      '| 강좌 | 대상 | 월 수강료 | 교재비(월) |',
      '|---|---|---|---|',
      '| 영어 독해반 | 초3·4 | 150,000원 | 14,000원 |',
      '| 영어 독해반 | 초5·6 | 190,000원 | 21,000원 |',
      '',
      '## 중등',
      '',
      '| 반 | 월 수강료 | 교재비(월) |',
      '|---|---|---|',
      '| 중1 창작반 | 210,000원 | 16,000원 |',
      '| 중2 창작반 | 210,000원 | 18,000원 |',
    ].join('\n'),
  );
  const qualified = await ask('영어 독해반 5,6학년은 한달에 얼마예요?');
  assert.equal(qualified.answer.status, 'answered', qualified.answer.answer);
  assert.match(qualified.answer.answer, /190,000원/);
  assert.doesNotMatch(qualified.answer.answer, /150,000원|21,000원/);
  const comparison = await ask('중1이랑 중2 수강료 같아요? 교재비도 같은지');
  assert.equal(comparison.answer.status, 'answered', comparison.answer.answer);
  assert.match(comparison.answer.answer, /월 수강료 금액은 같습니다/);
  assert.match(comparison.answer.answer, /교재비\(월\) 금액은 서로 다릅니다/);
  assert.match(comparison.answer.answer, /16,000원/);
  assert.match(comparison.answer.answer, /18,000원/);
});

test('자리와 중도 등록 규정은 따로 답하고 체험 여부를 좌석 수로 추정하지 않는다', async () => {
  const { register, ask } = setup();
  await register(
    'SEATS',
    'announcement',
    '반별 모집 현황',
    '초5 종합 1반 모집 중 (잔여 4석).',
    {
      facts: [seat('SEATS', 'A', '모집 중 (잔여 4석)', 4)],
    },
  );
  await register(
    'RULES',
    'academy_info',
    '입학 안내',
    '등록은 매월 1일 기준이며, 월 중간에 들어오면 남은 수업일수로 일할 계산합니다.',
  );
  const result = await ask(
    '초5 1반 자리 있어요? 월 중간에 들어가도 되는지랑 체험수업 되는지도요',
  );
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.match(result.answer.answer, /잔여 4석/);
  assert.match(result.answer.answer, /남은 수업일수로 일할 계산/);
  assert.deepEqual(result.answer.missingFields, ['체험 수업']);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['SEATS', 'RULES'],
  );
});

test('보호자 게시글과 학원 답변을 구분하고 상충하는 중도 등록 마감은 보류한다', async () => {
  const { register, ask } = setup();
  await register(
    'RULES',
    'policy',
    '입학 규정',
    '중도 등록: 개강 후 2주 차까지 등록할 수 있습니다.',
  );
  await register(
    'PARENT',
    'announcement',
    '학부모 게시판',
    '보호자 질문: 중도 등록은 개강 후 8주 차까지 가능한가요?',
  );
  const initial = await ask('3기 3주차인데 중간에 등록 되나요?');
  assert.equal(initial.answer.status, 'answered', initial.answer.answer);
  assert.match(initial.answer.answer, /2주 차까지/);
  assert.doesNotMatch(initial.answer.answer, /8주/);
  await register(
    'STAFF',
    'announcement',
    '학부모 게시판 답변 모음',
    '[학원 답변] 2026-11-04 12:00 | 예시 학원 데스크 중도 등록은 개강 후 3주 차까지 받고 있습니다.',
  );
  const conflict = await ask('3기 3주차인데 중간에 등록 되나요?');
  assert.equal(conflict.answer.status, 'abstained', conflict.answer.answer);
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(conflict.answer.citations, []);
});

test('축약한 반 번호와 기수 내 대안 반을 같은 계열의 승인 모집 현황에 연결한다', async () => {
  const { register, ask } = setup();
  await register(
    'NUMBERS',
    'announcement',
    '11월 모집 안내',
    '초5 종합 1반, 초5 종합 2반, 초5 종합 3반',
    {
      facts: [
        seat('NUMBERS', 'A', '잔여 1석', 1),
        seat('NUMBERS', 'B', '마감 (대기 2명)', 0),
        seat('NUMBERS', 'C', '잔여 5석', 5),
      ],
    },
  );
  await register(
    'CURRENT',
    'announcement',
    '3기 모집 안내',
    'R5 제작 평일반과 R5 제작 토요반',
    {
      facts: [
        seat('CURRENT', 'D', '마감', 0),
        seat('CURRENT', 'S', '잔여 3석', 3),
      ],
    },
  );
  await register(
    'OTHER',
    'announcement',
    '4기 모집 안내',
    'R5 제작 평일반과 R5 제작 토요반. 별도 공지',
    {
      facts: [
        seat('OTHER', 'D', '잔여 7석', 7),
        seat('OTHER', 'S', '잔여 8석', 8),
      ],
    },
  );
  const two = await ask('초5 1반이랑 2반 지금 자리 있어요?');
  assert.equal(two.answer.status, 'answered', two.answer.answer);
  assert.match(two.answer.answer, /대기 2명/);
  assert.doesNotMatch(two.answer.answer, /3반|5석/);
  const alternative = await ask(
    '3기 R5 제작 평일반 자리 있어요? 없으면 토요반은요?',
  );
  assert.equal(
    alternative.answer.status,
    'answered',
    alternative.answer.answer,
  );
  assert.match(alternative.answer.answer, /평일반.*마감.*\n.*토요반.*잔여 3석/);
  assert.doesNotMatch(alternative.answer.answer, /7석|8석/);
});

test('등록 반의 대여료 면제 행을 선택하고 일반 대여 단가를 대신 인용하지 않는다', async () => {
  const { register, ask } = setup();
  await register(
    'RENT',
    'fee',
    '기기 대여 안내',
    [
      '| 항목 | 금액 | 안내 |',
      '|---|---|---|',
      '| 노트북 대여료 | 8주 58,000원 | M3 과정만 해당합니다. |',
      '| 학원 기기 사용 | 없음 | M1·M2 로봇반은 학원 노트북을 쓰므로 노트북 대여료가 없습니다. |',
    ].join('\n'),
  );
  const result = await ask('수빈이도 노트북 대여료 내야 돼요?', {
    ...visitor,
    actorId: 'parent',
    role: 'guardian',
    allowedStudentIds: ['S1'],
    allowedClassIds: ['M2'],
    studentRefs: [
      {
        studentId: 'S1',
        displayLabel: '최수빈',
        aliases: ['수빈'],
        classIds: ['M2'],
      },
    ],
  });
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /금액: 없음/);
  assert.doesNotMatch(result.answer.answer, /58,000원/);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행 · 열 항목, 금액, 안내$/,
  );
  assert.deepEqual(result.trace.targetStudentIds, []);
});

test('공개 강좌의 예약 한도는 확인하고 다른 달의 잔여 시간은 대신 사용하지 않는다', async () => {
  const { register, ask } = setup();
  await register(
    'EDIT',
    'academy_info',
    '논술 첨삭 과정 안내',
    [
      '| 과정 | 대상 |',
      '|---|---|',
      '| 고등 첨삭(작문) | 고1~고3 |',
      '',
      '## 예약 안내',
      '',
      '같은 주에 최대 3회까지 예약할 수 있습니다.',
      '',
      '11월 화요일 저녁에는 잔여 2자리가 있습니다.',
    ].join('\n'),
    { classId: 'EDIT' },
  );
  await register(
    'UNAPPROVED',
    'announcement',
    '고등 첨삭 예약 안내',
    '12월 화요일 저녁에는 잔여 5자리가 있습니다.',
    { approve: false },
  );
  const result = await ask(
    '12월에 고등 첨삭 일주일에 몇 번까지 예약돼요? 화요일 저녁 자리도 남았나요?',
  );
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.match(result.answer.answer, /3회/);
  assert.doesNotMatch(result.answer.answer, /잔여 [25]자리/);
  assert.deepEqual(result.answer.missingFields, [
    '요청 시간대의 예약 가능 자리',
  ]);
});
