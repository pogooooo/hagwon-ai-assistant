import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisReportToIndexInput } from '../events.ts';
import { freshEnv, runQuery } from './helpers.ts';

const assessmentAsOf = '2026-11-10T18:00:00+09:00';

function assessmentReport(
  reportId: string,
  period: string,
  options: { revision?: number; studentId?: string } = {},
) {
  return analysisReportToIndexInput({
    academyId: 'AC_A',
    studentId: options.studentId ?? 'ST_A01',
    reportId,
    revision: options.revision ?? 1,
    period,
    title: period + ' 승인 학습 리포트',
    publishedAt:
      period === '2025-10'
        ? '2025-11-01T09:00:00+09:00'
        : '2026-11-01T09:00:00+09:00',
    units: [{ unitName: '문장 읽기', correctCount: 9, questionCount: 10 }],
  });
}

const scoreTable = (score: number, month = 10) =>
  [
    '| 응시 번호 | 획득 점수 | 평가명 | 비고 |',
    '|---|---|---|---|',
    '| 402 | 68점 | 실전 평가 | 중간 확인 |',
    `| 403 | ${score}점 | ${month}월 월말 고사 | 별도 점수 |`,
    '| 404 | 66점 | 9월 월말 고사 | 앞 달 |',
  ].join('\n');

test('월말 점수는 같은 원생의 기간과 승인 개정판에 있는 평가명·점수 셀만 인용한다', async () => {
  const env = await freshEnv();
  for (const [report, text, approve] of [
    [assessmentReport('RPT_SCORE', '2026-10'), scoreTable(72), true],
    [
      assessmentReport('RPT_SCORE', '2026-10', { revision: 2 }),
      scoreTable(84),
      true,
    ],
    [
      assessmentReport('RPT_SCORE', '2026-10', { revision: 3 }),
      scoreTable(99),
      false,
    ],
    [assessmentReport('RPT_SCORE_OLD', '2025-10'), scoreTable(77), true],
    [
      assessmentReport('RPT_OTHER_SCORE', '2026-10', { studentId: 'ST_A02' }),
      scoreTable(94),
      true,
    ],
  ] as const)
    await env.store.upsertIndexedRevision({
      approve,
      document: { ...report.document, text },
      facts: report.facts,
    });

  const ask = (question: string, userId = 'GUARDIAN_A') =>
    runQuery(env, {
      engine: 'planned',
      question,
      userId,
      asOf: assessmentAsOf,
    });
  const answer = await ask('A01 2026년 10월 월말 시험 몇 점 나왔어요?');
  assert.equal(answer.answer.status, 'answered', answer.answer.answer);
  assert.match(answer.answer.answer, /10월 월말 고사.*84점/);
  assert.doesNotMatch(
    answer.answer.answer,
    /68점|72점|77점|90%|94점|99점|응시 번호/,
  );
  assert.deepEqual(
    answer.answer.citations.map(({ sourceId }) => sourceId),
    ['RPT_SCORE:r2:body'],
  );
  assert.match(
    answer.answer.citations[0].location ?? '',
    /2행 · 열 평가명, 획득 점수$/,
  );
  assert.equal(answer.generationCalls, 0);

  const previousYear = await ask('A01 2025년 10월 월말 평가 점수 알려줘');
  assert.equal(
    previousYear.answer.status,
    'answered',
    previousYear.answer.answer,
  );
  assert.match(previousYear.answer.answer, /2025년.*77점/);
  assert.doesNotMatch(previousYear.answer.answer, /84점/);

  for (const userId of ['VISITOR_A', 'GUARDIAN_A02']) {
    const denied = await ask('A01 10월 월말 고사 점수 알려줘', userId);
    assert.equal(denied.answer.status, 'denied');
    assert.deepEqual(denied.trace.retrievedChunkIds, []);
    assert.deepEqual(denied.answer.citations, []);
  }
});

test('월말 점수 칸이 없거나 같은 기간의 승인 점수가 충돌하면 다른 값을 사용하지 않는다', async () => {
  const env = await freshEnv();
  const report = assessmentReport('RPT_SCORE_EMPTY', '2026-10');
  await env.store.upsertIndexedRevision({ ...report, approve: true });
  const ask = (question: string) =>
    runQuery(env, {
      engine: 'planned',
      question,
      userId: 'STUDENT_A01',
      asOf: assessmentAsOf,
    });
  const missing = await ask('10월 월말 평가 몇 점이에요?');
  assert.equal(missing.answer.status, 'abstained');
  assert.doesNotMatch(missing.answer.answer, /90%/);
  assert.deepEqual(missing.answer.citations, []);
  for (const [id, score] of [
    ['RPT_SCORE_X', 76],
    ['RPT_SCORE_Y', 88],
  ] as const) {
    const item = assessmentReport(id, '2026-10');
    await env.store.upsertIndexedRevision({
      approve: true,
      document: { ...item.document, text: scoreTable(score) },
      facts: item.facts,
    });
  }
  const conflict = await ask('10월 월말 평가 몇 점이에요?');
  assert.equal(conflict.answer.status, 'abstained', conflict.answer.answer);
  assert.equal(conflict.trace.reasonCode, 'CONFLICTING_EVIDENCE');
  assert.deepEqual(conflict.answer.citations, []);
  const school = await ask('학교에서 본 월말 평가 몇 점이에요?');
  assert.equal(school.answer.status, 'abstained');
  assert.deepEqual(school.trace.retrievedChunkIds, []);
});

test('단어 시험은 과제가 하나로 연결된 승인 집계만 사용하고 여러 주차를 구분한다', async () => {
  const env = await freshEnv();
  const report = assessmentReport('RPT_WORD_TEST', '2026-10');
  const add = async (second: boolean) => {
    const revision = second ? 2 : 1;
    const sourceId = 'RPT_WORD_TEST:r' + revision + ':body';
    const base = { ...report.facts[0], revision, sourceId };
    const first = { assignmentId: 'W1', title: '10월 1주 어휘 시험' };
    const next = { assignmentId: 'W3', title: '10월 3주 단어 시험' };
    const text = [
      '| 단원 | 정답 문항 | 전체 문항 | 정답률 |',
      '|---|---|---|---|',
      '| 기초 어휘 | 7문항 | 10문항 | 70% |',
      '| 확장 어휘 | 9문항 | 10문항 | 90% |',
    ].join('\n');
    await env.store.upsertIndexedRevision({
      approve: true,
      document: { ...report.document, revision, sourceId, text },
      facts: [
        {
          ...base,
          factId: 'FIRST_' + revision,
          assignments: [first],
          value: { kind: 'accuracy', unit: '기초 어휘', correct: 7, total: 10 },
        },
        {
          ...base,
          factId: 'TYPE_' + revision,
          assignments: [first, next],
          value: {
            kind: 'accuracy',
            unit: '어휘',
            correct: 19,
            total: 20,
            dimension: 'question_type',
          },
        },
        ...(second
          ? [
              {
                ...base,
                factId: 'NEXT_' + revision,
                assignments: [next],
                value: {
                  kind: 'accuracy' as const,
                  unit: '확장 어휘',
                  correct: 9,
                  total: 10,
                },
              },
            ]
          : []),
      ],
    });
  };
  const ask = (question: string) =>
    runQuery(env, {
      engine: 'planned',
      question,
      userId: 'STUDENT_A01',
      asOf: assessmentAsOf,
    });
  await add(false);
  const one = await ask('10월 단어 시험 몇 퍼 나왔어요?');
  assert.equal(one.answer.status, 'answered', one.answer.answer);
  assert.match(one.answer.answer, /70%/);
  assert.match(one.answer.answer, /10월 1주 어휘 시험/);
  assert.doesNotMatch(one.answer.answer, /95%|90%/);
  assert.match(one.answer.citations[0].location ?? '', /표 1 · 1행$/);
  assert.equal(one.generationCalls, 0);

  await add(true);
  const ambiguous = await ask('10월 단어 시험 정답률 알려주세요');
  assert.equal(ambiguous.answer.status, 'clarify', ambiguous.answer.answer);
  assert.deepEqual(ambiguous.answer.citations, []);
  const third = await ask('10월 3주 단어 시험 몇 퍼센트예요?');
  assert.equal(third.answer.status, 'answered', third.answer.answer);
  assert.match(third.answer.answer, /90%/);
  assert.doesNotMatch(third.answer.answer, /70%|95%/);
  const missing = await ask('10월 2주 단어 시험 정답률은?');
  assert.equal(missing.answer.status, 'abstained', missing.answer.answer);
  assert.deepEqual(missing.answer.citations, []);
});

test('복합 과목 보고서에서 요청 과목·기간의 소계 행만 인용한다', async () => {
  const env = await freshEnv();
  const report = analysisReportToIndexInput({
    academyId: 'AC_A',
    studentId: 'ST_A01',
    reportId: 'RPT_MIXED_SUBJECT',
    revision: 1,
    period: '2026-10',
    title: '10월 과목별 보고서',
    publishedAt: '2026-10-31T09:00:00+09:00',
    units: [{ unitName: '어휘', correctCount: 7, questionCount: 10 }],
  });
  const document = {
    ...report.document,
    text: '| 구분 | 정답 문항 | 전체 문항 | 정답률 |\n|---|---|---|---|\n| 수학 소계 | 9문항 | 10문항 | 90% |\n| 영어 소계 | 7문항 | 10문항 | 70% |',
  };
  await env.store.upsertIndexedRevision({
    approve: true,
    document,
    facts: report.facts,
  });
  const catalog = env.catalog;
  env.catalog = {
    async getAcademyCatalog(academyId) {
      const base = await catalog.getAcademyCatalog(academyId);
      assert.ok(base);
      return {
        ...base,
        classes: [
          ...base.classes,
          {
            classId: 'ENGLISH',
            name: '영어 집중반',
            aliases: [],
            subject: '영어',
          },
        ],
      };
    },
  };
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 10월 영어 정답률은?',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /영어 소계.*70%/);
  assert.doesNotMatch(result.answer.answer, /90%/);
  assert.equal(
    result.answer.citations[0]?.sourceId,
    'RPT_MIXED_SUBJECT:r1:body',
  );
  assert.match(
    result.answer.citations[0]?.location ?? '',
    /2행.*열 구분, 정답 문항, 전체 문항, 정답률/,
  );
  assert.equal(result.generationCalls, 0);
  const combined = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 10월 영어 정답률이랑 학교 단원평가 점수도 알려주세요',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(combined.answer.status, 'partial', combined.answer.answer);
  assert.match(combined.answer.answer, /영어 소계.*70%/);
  assert.deepEqual(combined.answer.missingFields, ['학교 시험 점수']);
  assert.doesNotMatch(combined.answer.answer, /90%/);
});

test('반 평균 비교에 이전 달 성적을 대입하지 않는다', async () => {
  const env = await freshEnv();
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 10월 정답률이 반 평균이랑 비교하면 어느 정도인가요?',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(result.answer.status, 'partial', result.answer.answer);
  assert.deepEqual(result.answer.missingFields, ['반·학년 평균']);
  assert.match(result.answer.answer, /10월.*정답률/);
  assert.doesNotMatch(result.answer.answer, /9월|%p/);
  assert.equal(result.generationCalls, 0);
});

test('같은 달 두 영역의 축약 이름은 각각 원본 항목으로 해석한다', async () => {
  const env = await freshEnv();
  const catalog = env.catalog;
  env.catalog = {
    async getAcademyCatalog(academyId) {
      const base = await catalog.getAcademyCatalog(academyId);
      assert.ok(base);
      return { ...base, units: [...base.units, '비문학 독해', '문학 감상'] };
    },
  };
  const report = analysisReportToIndexInput({
    academyId: 'AC_A',
    studentId: 'ST_A01',
    reportId: 'RPT_LITERATURE_A',
    revision: 1,
    period: '2026-10',
    title: '10월 영역별 리포트',
    publishedAt: '2026-10-31T09:00:00+09:00',
    units: [
      { unitName: '비문학 독해', correctCount: 8, questionCount: 10 },
      { unitName: '문학 감상', correctCount: 6, questionCount: 10 },
    ],
  });
  const registration = await env.store.upsertIndexedRevision({
    approve: true,
    ...report,
  });
  assert.equal(registration.status, 'activated');
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question:
      'A01 10월 비문학이랑 문학 정답률 둘 다 알려주고 뭐가 더 낮은지 알려주세요',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /문학 감상.*60%/);
  assert.match(result.answer.answer, /비문학 독해.*80%/);
  assert.match(result.answer.answer, /20%p/);
  assert.doesNotMatch(result.answer.answer, /9월/);
  assert.deepEqual(
    result.answer.citations.map(({ sourceId }) => sourceId),
    ['RPT_LITERATURE_A:r1:body'],
  );
});

test('종합반 과목명만으로 분석 리포트에 없는 과목의 결과를 추정하지 않는다', async () => {
  const env = await freshEnv();
  const catalog = env.catalog;
  env.catalog = {
    async getAcademyCatalog(academyId) {
      const base = await catalog.getAcademyCatalog(academyId);
      assert.ok(base);
      return {
        ...base,
        classes: [
          ...base.classes,
          {
            classId: 'COMPOSITE',
            name: '종합반',
            aliases: [],
            subject: '국어·수학·영어',
          },
        ],
      };
    },
  };
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 국어는 9월보다 10월에 나아졌어요?',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(result.answer.status, 'abstained', result.answer.answer);
  assert.deepEqual(result.answer.citations, []);
});

test('제출 과제 목록을 미제출 횟수로 사용하지 않는다', async () => {
  const env = await freshEnv();
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 10월에 숙제 몇 번 안 냈어요? 미제출 몇 개예요?',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(result.answer.status, 'abstained');
  assert.equal(result.trace.intent, 'unsubmitted_assignment_count');
  assert.deepEqual(result.answer.citations, []);
  assert.equal(result.generationCalls, 0);
});

test('감점 이유는 원생·기간·단원이 같은 승인 채점 사유에서만 답한다', async () => {
  const env = await freshEnv();
  for (const [id, month, student, content, approve] of [
    ['RPT_DEDUCT_09', '2026-09', 'ST_A01', '3문항 감점, 단위 표기 누락', true],
    ['RPT_DEDUCT_10', '2026-10', 'ST_A01', '4문항 감점', true],
    [
      'RPT_DEDUCT_DRAFT',
      '2026-09',
      'ST_A01',
      '5문항 감점, 풀이 순서 오류',
      false,
    ],
    [
      'RPT_DEDUCT_OTHER',
      '2026-09',
      'ST_A02',
      '2문항 감점, 숫자 기입 오류',
      true,
    ],
  ] as const) {
    const report = assessmentReport(id, month, { studentId: student });
    await env.store.upsertIndexedRevision({
      approve,
      document: {
        ...report.document,
        text: [
          '## 분석 대상 과제',
          '',
          '일차방정식 응용 과제 제출 기록.',
          '',
          '## 채점 판정',
          '',
          '판정 단원: 일차방정식',
          '판정 내용: ' + content,
        ].join('\n'),
      },
      facts: [
        {
          ...report.facts[0],
          factId: 'F_' + id,
          factType: 'weak_area',
          value: { kind: 'weak_area', unit: '일차방정식', text: content },
        },
      ],
    });
  }
  const ask = (question: string, userId = 'GUARDIAN_A') =>
    runQuery(env, {
      engine: 'planned',
      asOf: assessmentAsOf,
      userId,
      question,
    });
  const result = await ask(
    'A01 2026년 9월 일차방정식에서 뭐 때문에 감점됐어요?',
  );
  assert.equal(result.answer.status, 'answered', result.answer.answer);
  assert.match(result.answer.answer, /9월.*단위 표기 누락/);
  assert.doesNotMatch(result.answer.answer, /풀이 순서|숫자 기입/);
  assert.deepEqual(result.trace.usedFactIds, ['F_RPT_DEDUCT_09']);
  assert.deepEqual(
    result.answer.citations.map(({ documentId }) => documentId),
    ['RPT_DEDUCT_09'],
  );
  assert.match(result.answer.citations[0].location ?? '', /채점 판정/);
  assert.doesNotMatch(
    result.answer.citations[0].location ?? '',
    /분석 대상 과제/,
  );
  assert.equal(result.generationCalls, 0);
  for (const question of [
    'A01 10월 일차방정식 감점 사유 알려줘',
    'A01 2025년 9월 일차방정식 감점 사유 알려줘',
    'A01 9월 일차방정식이 감점된 이유가 공부에 집중을 안 해서인가요?',
  ]) {
    const other = await ask(question);
    assert.equal(other.answer.status, 'abstained', other.answer.answer);
    assert.deepEqual(other.answer.citations, []);
  }
  const denied = await ask(
    'A01 9월 일차방정식 감점 사유 알려줘',
    'GUARDIAN_A02',
  );
  assert.equal(denied.answer.status, 'denied');
  assert.deepEqual(denied.trace.retrievedChunkIds, []);
});

test('사용자가 단원을 추정해도 보고서가 확정한 취약 영역을 인용한다', async () => {
  const env = await freshEnv();
  const report = analysisReportToIndexInput({
    academyId: 'AC_A',
    studentId: 'ST_A01',
    reportId: 'RPT_REPORTED_WEAKNESS',
    revision: 1,
    period: '2026-10',
    title: '확정 취약 영역 리포트',
    publishedAt: '2026-10-31T09:00:00+09:00',
    units: [{ unitName: '일차방정식', correctCount: 8, questionCount: 10 }],
  });
  const weak = '입체 전개도를 방향에 맞게 접는 데 어려움이 있습니다.';
  await env.store.upsertIndexedRevision({
    approve: true,
    document: {
      ...report.document,
      text: report.document.text + '\n\n취약 영역: 공간과 입체 — ' + weak,
    },
    facts: [
      {
        ...report.facts[0],
        factId: 'F_REPORTED_WEAKNESS',
        factType: 'weak_area',
        value: { kind: 'weak_area', unit: '공간과 입체', text: weak },
      },
    ],
  });
  const result = await runQuery(env, {
    engine: 'planned',
    userId: 'GUARDIAN_A',
    question: 'A01 10월 리포트의 취약영역도 일차방정식인 거죠?',
    asOf: '2026-11-01T18:00:00+09:00',
  });
  assert.equal(result.answer.status, 'answered');
  assert.match(result.answer.answer, /리포트의 취약 영역: 공간과 입체/);
  assert.ok(
    result.answer.citations.some(
      ({ sourceId }) => sourceId === 'RPT_REPORTED_WEAKNESS:r1:body',
    ),
  );
});
