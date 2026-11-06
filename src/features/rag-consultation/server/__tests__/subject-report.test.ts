import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisReportToIndexInput } from '../events.ts';
import { freshEnv, runQuery } from './helpers.ts';

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
