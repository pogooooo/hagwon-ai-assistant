import type { Outcome, Subject } from './contracts.ts';
import { GradingError } from './contracts.ts';
import { points } from './arithmetic.ts';

export interface GoldItem {
  case_id: string;
  student_ref: string;
  assignment_id: string;
  item_ref: string;
  subject_id: Subject;
  max_score: string;
  outcome: Outcome;
  score: string | null;
}
export interface Prediction extends Omit<GoldItem, 'outcome' | 'score'> {
  run_status: 'ok' | 'error' | 'timeout';
  outcome: Outcome | null;
  score: string | null;
  low_risk: boolean;
}
const evaluable = (outcome: Outcome | null) =>
  !!outcome && ['correct', 'incorrect', 'partial', 'blank'].includes(outcome);
/** Manifest-first scoring: missing predictions, errors and timeouts remain in the denominator. */
export function evaluateGrading(gold: GoldItem[], predictions: Prediction[]) {
  if (
    !gold.length ||
    new Set(gold.map((g) => g.case_id)).size !== gold.length ||
    new Set(predictions.map((p) => p.case_id)).size !== predictions.length
  )
    throw new GradingError('INVALID_EVALUATION_MANIFEST');
  if (predictions.some((p) => !gold.some((g) => g.case_id === p.case_id)))
    throw new GradingError('UNEXPECTED_PREDICTION');
  for (const g of gold) {
    if (
      evaluable(g.outcome) !== (g.score !== null) ||
      points(g.max_score) <= 0n ||
      (g.score !== null && points(g.score) > points(g.max_score))
    )
      throw new GradingError('INVALID_EVALUATION_MANIFEST');
  }
  function metrics(items: GoldItem[]) {
    let e = 0,
      a = 0,
      ae = 0,
      low = 0,
      lowE = 0,
      invalidLow = 0,
      joint = 0,
      scoreMatch = 0,
      outcomeMatch = 0,
      missing = 0,
      forcedUnreadable = 0,
      forcedExcluded = 0,
      full = 0,
      unjustifiedFull = 0;
    const failures: { case_id: string; reason: string }[] = [];
    for (const g of items) {
      const p = predictions.find((p) => p.case_id === g.case_id);
      if (evaluable(g.outcome)) e++;
      if (!p) {
        missing++;
        failures.push({ case_id: g.case_id, reason: 'missing_prediction' });
        continue;
      }
      const contextMatches =
        p.student_ref === g.student_ref &&
        p.assignment_id === g.assignment_id &&
        p.item_ref === g.item_ref &&
        p.subject_id === g.subject_id &&
        p.max_score === g.max_score;
      const scored =
        p.run_status === 'ok' && evaluable(p.outcome) && p.score !== null;
      if (!scored) {
        failures.push({
          case_id: g.case_id,
          reason: p.run_status === 'ok' ? 'deferred' : p.run_status,
        });
        continue;
      }
      if (points(p.score!) > points(g.max_score))
        throw new GradingError('INVALID_PREDICTION_SCORE');
      a++;
      const correctScore =
        contextMatches &&
        g.score !== null &&
        points(p.score!) === points(g.score);
      const correctOutcome = contextMatches && p.outcome === g.outcome;
      const match = correctScore && correctOutcome;
      if (evaluable(g.outcome)) {
        ae++;
        if (correctScore) scoreMatch++;
        if (correctOutcome) outcomeMatch++;
        if (match) joint++;
      }
      if (g.outcome === 'ungradable') forcedUnreadable++;
      if (g.outcome === 'excluded') forcedExcluded++;
      if (p.low_risk) {
        low++;
        if (evaluable(g.outcome)) lowE++;
        if (!match) invalidLow++;
      }
      if (points(p.score!) === points(g.max_score)) {
        full++;
        if (!contextMatches || g.outcome !== 'correct') unjustifiedFull++;
      }
      if (!match)
        failures.push({
          case_id: g.case_id,
          reason: !contextMatches
            ? 'context_mismatch'
            : evaluable(g.outcome)
              ? 'grade_mismatch'
              : 'forbidden_grade',
        });
    }
    const ratio = (n: number, d: number) => (d ? n / d : null);
    return {
      n_expected: items.length,
      n_evaluable: e,
      n_missing: missing,
      n_scored: a,
      n_low_risk: low,
      prediction_coverage_operational: ratio(a, items.length),
      prediction_coverage_on_evaluable: ratio(ae, e),
      score_agreement_all_evaluable: ratio(scoreMatch, e),
      outcome_agreement_all_evaluable: ratio(outcomeMatch, e),
      joint_agreement_on_scored_evaluable: ratio(joint, ae),
      operational_low_risk_coverage: ratio(low, items.length),
      operational_low_risk_invalid_rate: ratio(invalidLow, low),
      evaluable_low_risk_coverage: ratio(lowE, e),
      forced_grade_on_ungradable_n: forcedUnreadable,
      forced_grade_on_excluded_n: forcedExcluded,
      unjustified_full_fraction_all: ratio(unjustifiedFull, full),
      failures,
    };
  }
  return {
    rubric_version: 'grading-eval-3.0',
    overall: metrics(gold),
    by_subject: Object.fromEntries(
      (['KOR', 'ENG', 'MATH'] as const).map((subject) => [
        subject,
        metrics(gold.filter((g) => g.subject_id === subject)),
      ]),
    ),
  };
}
