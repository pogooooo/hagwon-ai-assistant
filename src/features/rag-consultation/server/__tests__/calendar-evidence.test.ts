import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryConversationStore } from '../adapters/memory/index.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';
import { runQuery } from './helpers.ts';

const catalog: AcademyCatalog = {
  academyId: 'CALENDAR_TEST',
  displayName: '예시학원',
  aliases: [],
  units: [],
  classes: [
    {
      classId: 'A',
      name: '새봄중 2학년반',
      aliases: [],
      subject: '국어',
      grade: '중2',
    },
    {
      classId: 'B',
      name: '새봄여중 2학년반',
      aliases: [],
      subject: '국어',
      grade: '중2',
    },
  ],
  studentDirectory: [{ studentId: 'S3', names: ['남태민', '태민'] }],
};
const access: RagAccessScope = {
  actorId: 'guardian',
  academyId: catalog.academyId,
  role: 'guardian',
  allowedStudentIds: ['S1', 'S2'],
  allowedClassIds: ['A', 'B'],
  studentRefs: [
    {
      studentId: 'S1',
      displayLabel: '김가람',
      aliases: ['가람', '큰애'],
      classIds: ['A'],
    },
    {
      studentId: 'S2',
      displayLabel: '김나루',
      aliases: ['나루', '작은애'],
      classIds: ['B'],
    },
  ],
  canViewPublicHistory: false,
};

function setup() {
  const store = new InMemoryRagStore();
  const conversations = new InMemoryConversationStore();
  const register = (
    documentId: string,
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
        documentType: 'schedule',
        visibility: 'academy_public',
        title,
        validFrom: '2026-11-01T00:00:00+09:00',
        validTo: '2027-02-01T00:00:00+09:00',
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
      {
        engine: 'planned',
        userId: access.actorId,
        question,
        asOf: '2026-11-25T18:00:00+09:00',
        conversations,
      },
    );
  return { register, ask };
}

const exams = [
  '| 자료 번호 | 학년 | 국어 시험일 | 학교 |',
  '|---|---|---|---|',
  '| 901 | 2학년 | 12월 2일(수) | 새봄여자중학교 |',
  '| 902 | 3학년 | 12월 3일(목) | 새봄중학교 |',
  '| 903 | 2학년 | 12월 9일(수) | 새봄중학교 |',
].join('\n');
const datedHeader =
  '| 적용 날짜 | 반 | 수업 시간 | 비고 |\n|---|---|---|---|\n';
const examQuestion = '가람이 기말 국어 시험 언제예요? 시험 전날에도 학원 가요?';

test('다음 선발 시험은 직전 과정의 미래 공지에서 날짜와 시각을 확인한다', async () => {
  const { register, ask } = setup();
  await register(
    'ENTRY_RULE',
    '수강 신청과 선발 안내',
    '새봄중 2학년반에 등록하려면 선발 테스트를 봅니다.',
  );
  await register(
    'OTHER_ENTRY',
    '선발 일정',
    '새봄여중 2학년반 선발 테스트는 11월 26일(목) 10:40입니다.',
  );
  await register(
    'EARLIER_ENTRY',
    '선발 일정',
    '새봄중 2학년반 선발 테스트는 11월 24일(화) 09:00입니다.',
  );
  await register(
    'DRAFT_ENTRY',
    '선발 일정 초안',
    '새봄중 2학년반 선발 테스트는 11월 26일(목) 16:10입니다.',
    false,
  );
  await register(
    'ENTRY_SIGNUP',
    '선발 접수 공지',
    '새봄중 2학년반 선발 테스트 접수는 11월 26일(목) 13:10에 시작합니다.',
  );
  await register(
    'APPROVED_ENTRY',
    '선발 일정 확정',
    [
      '새봄중 2학년반은 선발 테스트를 진행합니다.',
      '다음 선발 테스트는 11월 27일(금) 17:30입니다.',
    ].join('\n'),
  );
  const first = await ask('새봄중 2학년반 들어가려면 선발 테스트 봐야 돼요?');
  assert.equal(first.answer.status, 'answered', first.answer.answer);
  const next = await ask('다음 테스트는 언제 봐요?');
  assert.equal(next.answer.status, 'answered', next.answer.answer);
  assert.match(next.answer.answer, /11월 27일.*17:30/);
  assert.doesNotMatch(next.answer.answer, /09:00|10:40|13:10|16:10/);
  assert.deepEqual(
    next.answer.citations.map(({ documentId }) => documentId),
    ['APPROVED_ENTRY'],
  );
  assert.equal(next.generationCalls, 0);
});

test('실험 계획은 등록 반과 날짜 범위를 묶고 요청한 준비물 열을 인용한다', async () => {
  const { register, ask } = setup();
  const sheet = [
    '| 준비물 | 기간 | 실험·활동 주제 | 반 | 주차 |',
    '|---|---|---|---|---|',
    '| 색종이 | 11/23~11/28 | 종이 접기 | 새봄중 2학년반 | 4주차 |',
    '| 보호 장갑 | 11/30~12/5 | 가루 염료 섞기 | 새봄중 2학년반 | 5주차 |',
    '| 비커 | 11/30~12/5 | 농도 계산 | 새봄여중 2학년반 | 5주차 |',
    '| 나뭇잎 4장 | 1/4~1/9 | 잎 모양 관찰 | 새봄중 2학년반 | 10주차 |',
    '| 투명 병 2개 | 1/11~1/16 | 용액 섞기 | 새봄중 2학년반 | 11주차 |',
    '| 종이컵 6개 | 1/11~1/16 | 물의 이동 | 새봄여중 2학년반 | 11주차 |',
    '| — | 1/18~1/23 | 결과 발표 | 새봄중 2학년반 | 12주차 |',
  ].join('\n');
  await register('LAB_PLAN', '주차별 실험 계획', sheet);
  await register(
    'LAB_DRAFT',
    '수정 실험 계획',
    sheet.replace('보호 장갑', '금속 장갑'),
    false,
  );
  const weekly = await ask('가람이 다음 주 무슨 실험해요? 준비물 있어요?');
  assert.equal(weekly.answer.status, 'answered', weekly.answer.answer);
  assert.match(weekly.answer.answer, /5주차.*가루 염료 섞기.*보호 장갑/);
  assert.doesNotMatch(weekly.answer.answer, /금속 장갑|색종이|농도 계산|비커/);
  assert.match(
    weekly.answer.citations[0].location ?? '',
    /2행 · 열 반, 주차, 기간, 실험·활동 주제, 준비물/,
  );
  assert.equal(weekly.generationCalls, 0);

  const monthly = await ask('가람이 2027년 1월에 집에서 챙겨갈 준비물 있어요?');
  assert.equal(monthly.answer.status, 'answered', monthly.answer.answer);
  assert.match(
    monthly.answer.answer,
    /10주차.*나뭇잎 4장.*\n.*11주차.*투명 병 2개/,
  );
  assert.doesNotMatch(monthly.answer.answer, /잎 모양 관찰|종이컵|12주차/);
  assert.match(
    monthly.answer.citations[0].location ?? '',
    /4행.*열 반, 주차, 기간, 준비물.*5행/,
  );

  const daily = await ask('나루 2027년 1월 12일 수업에 뭐 가져가야 돼요?');
  assert.equal(daily.answer.status, 'answered', daily.answer.answer);
  assert.match(daily.answer.answer, /11주차.*종이컵 6개/);
  assert.doesNotMatch(daily.answer.answer, /투명 병|나뭇잎/);
  const denied = await ask('태민이 다음 주 무슨 실험해요? 준비물 있어요?');
  assert.equal(denied.answer.status, 'denied');
  assert.deepEqual(denied.trace.retrievedChunkIds, []);
});

test('학교 시험 범위는 같은 학교·학년·과목 셀에 내용이 있을 때만 안내한다', async () => {
  const { register, ask } = setup();
  await register(
    'EXAM_DATE_ONLY',
    '기말고사 시험 일정',
    exams + '\n\n학교별 시험 범위 프린트는 수업 시간에 배부합니다.',
  );
  const question = '가람이 학교 기말 국어 시험 범위 어디까지예요?';
  const missing = await ask(question);
  assert.equal(missing.answer.status, 'abstained', missing.answer.answer);
  assert.deepEqual(missing.answer.citations, []);

  await register(
    'EXAM_RANGES',
    '기말고사 시험 범위',
    [
      '| 국어 시험 범위 | 학교 | 학년 | 수학 시험 범위 |',
      '|---|---|---|---|',
      '| 문학 1단원 | 새봄여자중학교 | 2학년 | 도형 |',
      '| 문학 2단원 | 새봄중학교 | 3학년 | 삼각비 |',
      '| 문학 3~4단원 | 새봄중학교 | 2학년 | 확률 |',
    ].join('\n'),
  );
  const known = await ask(question);
  assert.equal(known.answer.status, 'answered', known.answer.answer);
  assert.match(known.answer.answer, /새봄중학교.*문학 3~4단원/);
  assert.doesNotMatch(
    known.answer.answer,
    /12월 9일|문학 1단원|문학 2단원|확률/,
  );
  assert.deepEqual(
    known.answer.citations.map(({ documentId }) => documentId),
    ['EXAM_RANGES'],
  );
  assert.match(
    known.answer.citations[0].location ?? '',
    /3행 · 열 학교, 학년, 국어 시험 범위/,
  );
  assert.equal(known.generationCalls, 0);

  const different = await ask(
    '가람이 새봄여자중학교 기말 국어 시험 범위 알려주세요',
  );
  assert.equal(different.answer.status, 'abstained', different.answer.answer);
  assert.deepEqual(different.answer.citations, []);
});

test('변경 시간표는 기간과 정규 복귀를 같은 대상 행에서 확인한다', async () => {
  const { register, ask } = setup();
  const sheet = (note: string) =>
    [
      '| 정규 복귀일 | 대상 | 적용 기간 |',
      '|---|---|---|',
      '| 12월 7일 | 새봄여중 2학년반 | 11월 23일 ~ 12월 4일 |',
      '| ' + note + ' | 새봄중 2학년반 | 11월 23일 ~ 12월 11일 |',
      '',
      '| 반 | 수업 시간 | 적용 기간 |',
      '|---|---|---|',
      '| 새봄중 2학년반 | 16:00~18:00 | 11월 23일 ~ 12월 11일 |',
    ].join('\n');
  await register(
    'CHANGE_SCOPE',
    '기말고사 대비 변경 시간표',
    sheet('12월 14일'),
  );
  await register(
    'CHANGE_DRAFT',
    '기말고사 변경 시간표 초안',
    sheet('12월 18일'),
    false,
  );
  const result = await ask(
    '가람이 기말 대비 시간표 언제까지예요? 끝나면 원래대로 돌아가요?',
  );
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /새봄중 2학년반.*12월 11일.*12월 14일/);
  assert.doesNotMatch(
    result.answer.answer,
    /12월 [47]일|12월 18일|16:00|새봄여중/,
  );
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['CHANGE_SCOPE'],
  );
  assert.match(
    result.answer.citations[0].location ?? '',
    /2행 · 열 대상, 적용 기간, 정규 복귀일/,
  );
  assert.equal(result.generationCalls, 0);
});

test('그날 일정은 직전 시험일과 같은 반의 당일 행에서 다시 확인한다', async () => {
  const { register, ask } = setup();
  await register('EXAM_DATE', '기말고사 시험 일정', exams);
  await register(
    'DAY_ROWS',
    '시험 기간 변경 시간표',
    datedHeader +
      [
        '| 12월 9일(수) | 새봄중 2학년반 | 휴강 | 국어 시험일 |',
        '| 12월 9일(수) | 새봄여중 2학년반 | 17:00~19:00 | 정상 수업 |',
        '| 12월 8일(화) | 새봄중 2학년반 | 18:00~20:00 | 전날 수업 |',
      ].join('\n'),
  );
  const initial = await ask('가람이 기말 국어 시험 언제예요?');
  assert.equal(initial.answer.status, 'answered', initial.answer.answer);
  const next = await ask('그날 학원 수업은 어떻게 돼요?');
  assert.equal(next.answer.status, 'answered', next.answer.answer);
  assert.match(next.answer.answer, /새봄중.*12월 9일.*휴강/);
  assert.doesNotMatch(next.answer.answer, /새봄여중|17:00|18:00/);
  assert.deepEqual(
    next.answer.citations.map(({ documentId }) => documentId),
    ['DAY_ROWS'],
  );
});

test('시험일과 전날 수업은 등록 반·학교·학년·날짜에 맞는 두 행을 따로 인용한다', async () => {
  const { register, ask } = setup();
  await register('EXAMS', '기말고사 시험 일정', exams);
  await register(
    'LESSONS',
    '날짜별 수업 일정',
    datedHeader +
      [
        '| 12월 8일(화) | 새봄여중 2학년반 | 17:00~18:00 | 정상 수업 |',
        '| 12월 1일(화) | 새봄중 2학년반 | 17:30~18:30 | 정상 수업 |',
        '| 12월 8일(화) | 새봄중 2학년반 | 18:30~20:00 | 시험 전날 |',
      ].join('\n'),
  );
  const result = await ask(examQuestion);
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /12월 9일.*\n.*12월 8일.*18:30~20:00/);
  assert.doesNotMatch(result.answer.answer, /17:00|17:30|903|12월 [123]일/);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['EXAMS', 'LESSONS'],
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /3행 · 열 학교, 학년, 국어 시험일$/,
  );
  assert.match(
    result.answer.citations[1]?.location ?? '',
    /3행 · 열 반, 적용 날짜, 수업 시간$/,
  );
  assert.equal(result.generationCalls, 0);

  const premise = await ask(
    '가람이도 새봄여중이랑 시험 날짜 같죠? 12월 2일 맞나요?',
  );
  assert.equal(premise.answer.status, 'answered', premise.answer.answer);
  assert.match(premise.answer.answer, /12월 9일/);
  assert.doesNotMatch(premise.answer.answer, /12월 2일/);
});

test('전날 수업 근거가 미승인 또는 충돌이면 시험일만 답하고 권한 밖 학생은 거부한다', async () => {
  const { register, ask } = setup();
  await register('EXAMS', '기말고사 시험 일정', exams);
  await register(
    'DRAFT',
    '검토 중인 수업 일정',
    datedHeader + '| 12월 8일(화) | 새봄중 2학년반 | 19:00~20:00 | 정상 수업 |',
    false,
  );
  const partial = await ask(examQuestion);
  assert.equal(partial.answer.status, 'partial', partial.answer.answer);
  assert.deepEqual(partial.answer.missingFields, ['시험 전날 수업']);
  assert.deepEqual(
    partial.answer.citations.map(({ documentId }) => documentId),
    ['EXAMS'],
  );
  assert.doesNotMatch(partial.answer.answer, /19:00/);

  await register(
    'CHANGE',
    '수업 변경 일정',
    datedHeader +
      '| 12월 8일(화) | 새봄중 2학년반 | 18:00~20:00 | 해당 수업 휴강 |',
  );
  const conflict = await ask(examQuestion);
  assert.equal(conflict.answer.status, 'partial', conflict.answer.answer);
  assert.deepEqual(
    conflict.answer.citations.map(({ documentId }) => documentId),
    ['EXAMS'],
  );
  assert.doesNotMatch(conflict.answer.answer, /18:00/);
  const denied = await ask('태민이 기말 국어 시험 언제예요?');
  assert.equal(denied.answer.status, 'denied');
  assert.deepEqual(denied.trace.retrievedChunkIds, []);
});

test('달력 날짜로 학습 주차를 조회할 때 연도가 바뀌어도 같은 반의 유효한 기간만 사용한다', async () => {
  const { register, ask } = setup();
  await register(
    'CURRICULUM',
    '주차별 학습 계획',
    [
      '| 행 식별자 | 학습 주제 | 기간 | 주차 | 반 |',
      '|---|---|---|---|---|',
      '| 301 | 서사 구조 | 12/21~12/26 | 4주차 | 새봄중 2학년반 |',
      '| 302 | 논증 구조 | 12/28~1/3 | 5주차 | 새봄중 2학년반 |',
      '| 303 | 문장 성분 | 12/28~1/3 | 5주차 | 새봄여중 2학년반 |',
    ].join('\n'),
  );
  const answer = await ask('가람이 반 2027년 1월 2일 주에는 무엇을 배워요?');
  assert.equal(answer.answer.status, 'answered', answer.answer.answer);
  assert.match(answer.answer.answer, /5주차.*논증 구조/);
  assert.doesNotMatch(answer.answer.answer, /서사 구조|문장 성분|302/);
  assert.match(
    answer.answer.citations[0]?.location ?? '',
    /2행 · 열 반, 주차, 기간, 학습 주제$/,
  );
  assert.equal(answer.generationCalls, 0);
  const missing = await ask('가람이 반 2027년 1월 5일 주에는 무엇을 배워요?');
  assert.equal(missing.answer.status, 'abstained', missing.answer.answer);
  assert.deepEqual(missing.answer.citations, []);
});

test('자녀를 바꾸는 후속 질문은 수업 주제만 이어받고 강의실 조회는 필요한 열만 인용한다', async () => {
  const { register, ask } = setup();
  await register(
    'REGULAR',
    '정규 시간표',
    [
      '| 강사 | 반 | 교실 | 수업 시간 |',
      '|---|---|---|---|',
      '| 유정민 | 새봄중 2학년반 | 401호 | 화·목 18:00~20:00 |',
      '| 문다정 | 새봄여중 2학년반 | 501호 | 월·수 16:00~18:00 |',
    ].join('\n'),
  );
  const initial = await ask('큰애 수업 시간 알려주세요');
  assert.equal(initial.answer.status, 'answered', initial.answer.answer);
  assert.match(initial.answer.answer, /18:00~20:00/);
  const followup = await ask('작은애는요?');
  assert.equal(followup.answer.status, 'answered', followup.answer.answer);
  assert.match(followup.answer.answer, /16:00~18:00/);
  assert.doesNotMatch(followup.answer.answer, /18:00~20:00|401호/);

  const room = await ask('큰애 강의실이 몇 호예요?');
  assert.equal(room.answer.status, 'answered', room.answer.answer);
  assert.match(room.answer.answer, /401호/);
  assert.doesNotMatch(room.answer.answer, /501호|유정민|18:00/);
  assert.match(room.answer.citations[0]?.location ?? '', /1행 · 열 반, 교실$/);
  const otherRoom = await ask('작은애는요?');
  assert.equal(otherRoom.answer.status, 'answered', otherRoom.answer.answer);
  assert.match(otherRoom.answer.answer, /501호/);
  assert.doesNotMatch(otherRoom.answer.answer, /401호|문다정|16:00/);
  assert.match(
    otherRoom.answer.citations[0]?.location ?? '',
    /2행 · 열 반, 교실$/,
  );
  const unclear = await ask('수업 몇 시에 끝나요? 데리러 가야 해서요');
  assert.equal(unclear.answer.status, 'clarify', unclear.answer.answer);
  assert.deepEqual(unclear.answer.citations, []);
  assert.deepEqual(unclear.trace.retrievedChunkIds, []);
});
