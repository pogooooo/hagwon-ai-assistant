import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLearningNarrative,
  comparedReportFingerprint,
  previousReportComparison,
  reportMatchesEvidence,
} from './report-narrative.ts';

test('narrative grounds strengths, practice, attendance and exclusions in the submitted evidence', () => {
  const report = buildLearningNarrative({
    total: 13,
    correct: 9,
    unknown: 2,
    excluded: 1,
    sourceCount: 2,
    types: [
      { id: 'fractions', name: '다른 분모의 분수 덧셈', total: 7, wrong: 4 },
      { id: 'equations', name: '방정식', total: 6, wrong: 0 },
    ],
    attendance: { present: 8, late: 1, absent: 0 },
  });
  assert.match(report.body, /13문항 중 9문항 정답 \(69%\)/);
  assert.match(report.body, /확정된 학습 결과 2건/);
  assert.match(report.body, /잘한 부분[\s\S]*방정식.*6문항 중 6문항/);
  assert.match(
    report.body,
    /더 살펴볼 부분[\s\S]*7문항 중 3문항은 정답, 4문항/,
  );
  assert.match(report.body, /새 문제 5문항[\s\S]*공통분모/);
  assert.match(report.body, /출석 8회 · 지각 1회 · 결석 0회/);
  assert.match(report.body, /아직 확인되지 않은 2문항/);
  assert.match(report.body, /평가 제외·채점 불가 1문항/);
  assert.match(report.teacher, /상담에서 물어볼 질문/);
  assert.doesNotMatch(report.body, /상담에서 물어볼 질문/);
});

test('missing and sparse records never create achievement claims or cross-type comparisons', () => {
  const current = { id: 'same', name: '분수', total: 5, wrong: 1 };
  const comparison = previousReportComparison('2027-01', [current], (month) => {
    assert.equal(month, '2026-12');
    return [
      { ...current, id: 'other', wrong: 5 },
      { ...current, total: 4, wrong: 3 },
    ];
  });
  assert.equal(comparison, undefined);
  const report = buildLearningNarrative({
    total: 0,
    correct: 0,
    unknown: 3,
    types: [],
    attendance: { present: 0, late: 0, absent: 0 },
  });
  assert.match(report.body, /확정한 채점 기록이 없습니다/);
  assert.match(report.body, /기록된 출결이 없습니다/);
  assert.doesNotMatch(report.body, /0%|잘한 부분|지난달과 비교|연습 방법/);
  assert.doesNotMatch(report.teacher, /맞힌 문제/);
});

test('comparisons describe the same type and retain compatibility with existing report fingerprints', () => {
  const current = { id: 'compare', name: '독해', total: 5, wrong: 1 };
  const comparison = previousReportComparison('2026-11', [current], () => [
    { ...current, total: 10, wrong: 4 },
  ]);
  assert.equal(comparison?.period, '2026-10');
  const report = buildLearningNarrative(
    { total: 5, correct: 4, unknown: 0, types: [current] },
    comparison,
  );
  assert.match(
    report.body,
    /2026년 10월 6\/10문항 정답 → 이번 기간 4\/5문항 정답/,
  );
  assert.match(report.body, /20%p 높았습니다/);
  assert.equal(
    reportMatchesEvidence('legacy', 'legacy', () => {
      throw Error('Legacy evidence does not require a comparison');
    }),
    true,
  );
  const saved = comparedReportFingerprint('this', 'previous');
  assert.equal(
    reportMatchesEvidence(saved, 'this', () => 'previous'),
    true,
  );
  assert.equal(
    reportMatchesEvidence(saved, 'this', () => 'corrected'),
    false,
  );
});
