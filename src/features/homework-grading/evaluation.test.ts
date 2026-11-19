import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateGrading,
  type GoldItem,
  type Prediction,
} from './evaluation.ts';

test('evaluation version 3 preserves omitted, timeout, forbidden and wrong-subject cases', () => {
  const gold: GoldItem[] = Array.from({ length: 6 }, (_, n) => ({
    case_id: 'case_' + n,
    student_ref: 'student_1',
    assignment_id: 'assignment_1',
    item_ref: 'item_' + n,
    subject_id: n < 2 ? 'KOR' : n < 4 ? 'ENG' : 'MATH',
    max_score: '1',
    outcome: n === 4 ? 'ungradable' : 'correct',
    score: n === 4 ? null : '1',
  }));
  const predictions: Prediction[] = gold.slice(0, 5).map((g) => ({
    ...g,
    run_status: 'ok',
    outcome: 'correct',
    score: '1',
    low_risk: true,
  }));
  predictions[1].run_status = 'timeout';
  predictions[3].student_ref = 'other_student';
  const result = evaluateGrading(gold, predictions);
  assert.equal(result.rubric_version, 'grading-eval-3.0');
  assert.equal(result.overall.n_expected, 6);
  assert.equal(result.overall.n_missing, 1);
  assert.equal(result.overall.n_evaluable, 5);
  assert.equal(result.overall.score_agreement_all_evaluable, 2 / 5);
  assert.equal(result.overall.prediction_coverage_operational, 4 / 6);
  assert.equal(result.overall.prediction_coverage_on_evaluable, 3 / 5);
  assert.equal(result.overall.forced_grade_on_ungradable_n, 1);
  assert.equal(result.overall.operational_low_risk_invalid_rate, 2 / 4);
  assert.equal(result.by_subject.ENG.n_expected, 2);
  assert.equal(result.by_subject.ENG.score_agreement_all_evaluable, 0.5);
});
test('zero denominators stay null and duplicate/unexpected predictions fail', () => {
  const g: GoldItem = {
    case_id: 'c1',
    student_ref: 's1',
    assignment_id: 'a1',
    item_ref: 'i1',
    subject_id: 'MATH',
    max_score: '1',
    outcome: 'ungradable',
    score: null,
  };
  const p: Prediction = { ...g, run_status: 'ok', low_risk: false };
  assert.equal(
    evaluateGrading([g], [p]).overall.score_agreement_all_evaluable,
    null,
  );
  assert.throws(() => evaluateGrading([g], [p, p]));
  assert.throws(() => evaluateGrading([g], [{ ...p, case_id: 'other' }]));
});
