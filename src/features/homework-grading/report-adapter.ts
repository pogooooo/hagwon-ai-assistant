import type { OperationsDatabase } from '../academy-operations/database.ts';
import { computeFacts } from './facts.ts';

export function photoReportStats(
  db: OperationsDatabase,
  academyId: string,
  student: string,
  classId: string,
  period: string,
) {
  const [year, month] = period.split('-').map(Number);
  const s = computeFacts(
    db,
    academyId,
    {
      student_ref: student,
      from_date: period + '-01',
      to_date_exclusive: new Date(Date.UTC(year, month, 1))
        .toISOString()
        .slice(0, 10),
      comparison_period: null,
      subjects: ['KOR', 'ENG', 'MATH'],
      attempt_policy: 'latest_in_window',
      statistics_policy_version: 'grading-stats-3.0',
    },
    Date.now(),
    new Set([classId]),
  );
  const overall = s.facts.filter(
    (f) => f.period_role === 'primary' && f.primary_skill_id === null,
  );
  return {
    // Result revisions are immutable. Snapshot-local fact IDs change on every read.
    sources: s.result_refs,
    total: overall.reduce((n, f) => n + f.n_evaluable, 0),
    correct: overall.reduce((n, f) => n + f.n_correct, 0),
    unknown: s.availability.reduce(
      (n, a) => n + a.n_pending_items + a.n_unavailable_items,
      0,
    ),
    excluded: overall.reduce((n, f) => n + f.n_ungradable + f.n_excluded, 0),
    types: s.facts
      .filter((f) => f.period_role === 'primary' && f.primary_skill_id !== null)
      .map((f) => ({
        id: `v3:${f.subject_id}:${f.taxonomy_version}:${f.primary_skill_id}`,
        name: f.skill_label ?? f.primary_skill_id!,
        total: f.n_evaluable,
        wrong: f.n_incorrect + f.n_partial + f.n_blank,
      })),
  };
}
