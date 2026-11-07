import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryConversationStore } from '../adapters/memory/index.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type {
  AcademyCatalog,
  ApprovedFactInput,
  FactAssignment,
  RagAccessScope,
} from '../types.ts';
import { runQuery } from './helpers.ts';

const start = '2026-11-04T09:00:00+09:00';
const academyId = 'REPORT_CONTEXT';
const catalog: AcademyCatalog = {
  academyId,
  displayName: '예시 교실',
  aliases: [],
  units: ['과거형', '듣기'],
  classes: [
    { classId: 'MIX', name: '통합반', aliases: [], subject: '종합' },
    { classId: 'EN', name: '영어반', aliases: [], subject: '영어' },
  ],
  studentDirectory: [
    { studentId: 'A', names: ['조채원', '채원'] },
    { studentId: 'B', names: ['조다연', '다연'] },
    { studentId: 'X', names: ['서유진', '유진'] },
  ],
};
const access: RagAccessScope = {
  actorId: 'guardian',
  academyId,
  role: 'guardian',
  allowedStudentIds: ['A', 'B'],
  allowedClassIds: ['MIX'],
  studentRefs: [
    {
      studentId: 'A',
      displayLabel: '조채원',
      aliases: ['채원', '작은애'],
      classIds: ['MIX'],
    },
    {
      studentId: 'B',
      displayLabel: '조다연',
      aliases: ['다연', '언니'],
      classIds: ['MIX'],
    },
  ],
  canViewPublicHistory: false,
};

function setup() {
  const store = new InMemoryRagStore();
  const conversations = new InMemoryConversationStore();
  const ask = (
    question: string,
    options: { scope?: RagAccessScope; conversationId?: string } = {},
  ) => {
    const scope = options.scope ?? access;
    return runQuery(
      {
        store,
        catalog: {
          getAcademyCatalog: async () => ({
            ...catalog,
            academyId: scope.academyId,
          }),
        },
        resolveScope: () => scope,
      },
      {
        engine: 'planned',
        userId: scope.actorId,
        question,
        asOf: '2026-11-19T18:00:00+09:00',
        conversations,
        conversationId: options.conversationId,
      },
    );
  };
  const report = async (
    documentId: string,
    studentId: string,
    period: string,
    text: string,
    options: {
      correct?: number;
      total?: number;
      weak?: string;
      assignments?: FactAssignment[];
    } = {},
  ) => {
    const fact = (
      suffix: string,
      factType: ApprovedFactInput['factType'],
      value: ApprovedFactInput['value'],
    ): ApprovedFactInput => ({
      factId: documentId + '-' + suffix,
      sourceId: documentId + ':r1:body',
      academyId,
      documentId,
      revision: 1,
      subjectType: 'student',
      subjectId: studentId,
      factType,
      value,
      period,
      validFrom: start,
      approvalStatus: 'approved',
      assignments: options.assignments,
    });
    const result = await store.upsertIndexedRevision({
      approve: true,
      document: {
        academyId,
        documentId,
        revision: 1,
        documentType: 'student_analysis',
        visibility: 'student_private',
        title: period + ' 리포트',
        studentId,
        classId: 'MIX',
        text,
        validFrom: start,
        approvedAt: start,
      },
      facts: [
        fact('overall', 'accuracy', {
          kind: 'accuracy',
          dimension: 'overall',
          unit: '전체',
          correct: options.correct ?? 7,
          total: options.total ?? 10,
        }),
        ...(options.weak
          ? [
              fact('weak', 'weak_area', {
                kind: 'weak_area',
                unit: options.weak,
                text: '확정 리포트에 기록된 오답 유형입니다.',
              }),
            ]
          : []),
      ],
    });
    assert.equal(result.status, 'activated');
  };
  return { report, ask };
}

const subjectRows = (unit: string, correct: number) =>
  [
    '## 단원별 결과',
    '',
    '| 과목 | 단원 | 정답 문항 | 전체 문항 | 정답률 |',
    '|---|---|---|---|---|',
    '| 영어 | ' +
      unit +
      ' | ' +
      correct +
      '문항 | 10문항 | ' +
      correct * 10 +
      '% |',
    '| 수학 | 함수 | 10문항 | 10문항 | 100% |',
    '',
    '## 과목별 소계',
    '',
    '| 구분 | 정답 문항 | 전체 문항 | 정답률 |',
    '|---|---|---|---|',
    '| 영어 소계 | ' + correct + '문항 | 10문항 | ' + correct * 10 + '% |',
  ].join('\n');

test('학생만 바꾸는 후속 질문은 확인된 기간과 취약 영역 요청을 이어받는다', async () => {
  const { report, ask } = setup();
  await report('A9', 'A', '2026-09', '9월 채점 자료', { weak: '정수' });
  await report('B9', 'B', '2026-09', '9월 채점 자료', { weak: '도형' });
  await report('B10', 'B', '2026-10', '10월 채점 자료', { weak: '함수' });
  const first = await ask('채원이 9월 취약 영역 알려줘요');
  assert.equal(first.answer.status, 'answered', first.answer.answer);
  const next = await ask('다연은요?');
  assert.equal(next.answer.status, 'answered', next.answer.answer);
  assert.match(next.answer.answer, /9월.*취약 영역: 도형/);
  assert.doesNotMatch(next.answer.answer, /정수|함수|10월/);
  assert.deepEqual(
    next.answer.citations.map(({ documentId }) => documentId),
    ['B9'],
  );
  const forbidden = await ask('유진은요?');
  assert.equal(forbidden.answer.status, 'denied');
  assert.deepEqual(forbidden.trace.retrievedFactIds, []);
});

test('과목과 기간을 이어받아 해당 단원과 새로 지목한 학생의 소계를 별도로 검증한다', async () => {
  const { report, ask } = setup();
  await report('A9', 'A', '2026-09', subjectRows('듣기', 7));
  await report('A10', 'A', '2026-10', subjectRows('어휘', 9));
  await report('B9', 'B', '2026-09', subjectRows('독해', 6));
  assert.equal(
    (await ask('채원 9월 리포트 영어 정답률 알려줘')).answer.status,
    'answered',
  );
  const unit = await ask('그 단원 이름 뭐였고 몇 개 맞았어?');
  assert.equal(unit.answer.status, 'answered', unit.answer.answer);
  assert.match(unit.answer.answer, /9월.*영어.*단원: 듣기.*7문항/);
  assert.doesNotMatch(unit.answer.answer, /함수|어휘/);
  assert.match(
    unit.answer.citations[0]?.location ?? '',
    /1행 · 열 과목, 단원, 정답 문항, 전체 문항, 정답률/,
  );
  const sibling = await ask('언니는요? 영어만요');
  assert.equal(sibling.answer.status, 'answered', sibling.answer.answer);
  assert.match(sibling.answer.answer, /9월.*영어 소계.*60%/);
  assert.doesNotMatch(sibling.answer.answer, /70%|90%/);
  assert.deepEqual(
    sibling.answer.citations.map(({ documentId }) => documentId),
    ['B9'],
  );
  const otherAcademy = await ask('그 단원 이름은 뭐였어요?', {
    scope: { ...access, academyId: 'DIFFERENT_ACADEMY' },
  });
  assert.deepEqual(otherAcademy.answer.citations, []);
});

test('복합 과목의 취약 영역은 해당 월의 같은 리포트에서 단원과 과목이 일치해야 한다', async () => {
  const { report, ask } = setup();
  await report('SEP', 'A', '2026-09', subjectRows('듣기', 7), { weak: '듣기' });
  await report('OCT', 'A', '2026-10', subjectRows('과거형', 8), {
    weak: '과거형',
  });
  const answer = await ask(
    '채원 9월이랑 10월 영어 단원이 제일 약했어요? 각각 뭐였는지요',
  );
  assert.equal(answer.answer.status, 'answered', answer.answer.answer);
  assert.match(answer.answer.answer, /9월.*취약 영역: 듣기/);
  assert.match(answer.answer.answer, /10월.*취약 영역: 과거형/);
  assert.deepEqual(
    answer.answer.citations.map(({ documentId }) => documentId),
    ['SEP', 'OCT'],
  );
  const unrelated = await ask(
    '채원 9월이랑 10월 영어 단원이 제일 약했어요? 각각 뭐였는지요',
    {
      scope: {
        ...access,
        allowedStudentIds: ['B'],
        studentRefs: access.studentRefs.slice(1),
      },
      conversationId: 'new-scope',
    },
  );
  assert.equal(unrelated.answer.status, 'denied');
  assert.deepEqual(unrelated.answer.citations, []);
});

test('기간 비교에 한 기간만 승인됐으면 그 기간의 전체 합계와 누락 기간을 함께 표시한다', async () => {
  const { report, ask } = setup();
  await report('OCT', 'A', '2026-10', subjectRows('듣기', 7), {
    correct: 8,
    total: 10,
  });
  const result = await ask('채원 10월하고 11월 정답률 비교해 주세요');
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.match(result.answer.answer, /10월 전체.*80%/);
  assert.deepEqual(result.answer.missingFields, ['2026년 11월 분석 자료']);
  assert.doesNotMatch(result.answer.answer, /높습니다|낮습니다/);
});

test('과제 오답 순위는 전체 합계와 과제 목록이 맞을 때만 답하고 자료 발송 여부를 분리한다', async () => {
  const { report, ask } = setup();
  const table = [
    '| 숙제 번호 | 숙제 제목 | 문항 수 | 정답 |',
    '|---|---|---|---|',
    '| X01 | 이야기 요약 | 10문항 | 8문항 |',
    '| X02 | 연극 대사 | 10문항 | 5문항 |',
  ].join('\n');
  const assignments = [
    { assignmentId: 'X01', title: '이야기 요약' },
    { assignmentId: 'X02', title: '연극 대사' },
  ];
  await report('OK', 'A', '2026-10', table, {
    correct: 13,
    total: 20,
    assignments,
  });
  await report('BAD', 'B', '2026-10', table, {
    correct: 14,
    total: 20,
    assignments,
  });
  const result = await ask(
    '채원 10월 숙제 중에 제일 많이 틀린 게 뭐였어요? 그 숙제 보내주실 수 있나요?',
  );
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.match(result.answer.answer, /연극 대사.*오답: 5문항/);
  assert.doesNotMatch(result.answer.answer, /이야기 요약|X02/);
  assert.deepEqual(result.answer.missingFields, ['과제 자료 재전송 가능 여부']);
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행 · 열 숙제 제목, 문항 수, 정답/,
  );
  const conflict = await ask('다연 10월 숙제 중에 제일 많이 틀린 게 뭐였어요?');
  assert.equal(conflict.answer.status, 'abstained', conflict.answer.answer);
  assert.deepEqual(conflict.answer.citations, []);
});
