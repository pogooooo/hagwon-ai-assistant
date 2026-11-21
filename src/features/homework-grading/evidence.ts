import type { OperationsDatabase } from '../academy-operations/database.ts';
import { one, rows } from '../academy-operations/shared.ts';
import type {
  ApprovedFactInput,
  SourceDocumentInput,
} from '../rag-consultation/server/index.ts';
import { computeFacts } from './facts.ts';
import {
  submissionAssignment,
  sourceGeneration,
  type Submission,
} from './service.ts';
import { subjectNames, type Subject } from './contracts.ts';

/** Build fresh, class-scoped facts. No persistent vector copy of a student's raw work. */
export function gradingEvidence(
  db: OperationsDatabase,
  tenant: string,
): { documents: SourceDocumentInput[]; facts: ApprovedFactInput[] } {
  const output: {
    documents: SourceDocumentInput[];
    facts: ApprovedFactInput[];
  } = { documents: [], facts: [] };
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='grading_v3_submissions'",
      )
      .get()
  )
    return output;
  if (
    !db
      .prepare('SELECT 1 FROM grading_v3_submissions WHERE tenant=? LIMIT 1')
      .get(tenant)
  )
    return output;
  // This synchronous adapter is also called inside consultation's commit transaction.
  // It must not begin a second SQLite transaction or invoke any external service.
  const collect = () => {
    const submissions = rows<Submission>(
      db,
      "SELECT s.* FROM grading_v3_submissions s JOIN students st ON st.id=s.student AND st.academy_id=s.tenant WHERE s.tenant=? AND s.purpose='assessment' AND s.uploaded=1",
      tenant,
    );
    const groups = new Map<
      string,
      { student: string; classId: string; month: string; subject: Subject }
    >();
    for (const s of submissions) {
      const assignment = submissionAssignment(db, s);
      // Only an active roster link may supply consultation material.
      if (
        !db
          .prepare(
            'SELECT 1 FROM student_class_memberships WHERE academy_id=? AND student_id=? AND class_id=? AND ended_at IS NULL',
          )
          .get(tenant, s.student, assignment.class_id)
      )
        continue;
      const month = s.assessment_date.slice(0, 7);
      for (const subject of new Set(assignment.items.map((i) => i.subject_id)))
        groups.set([s.student, assignment.class_id, month, subject].join(':'), {
          student: s.student,
          classId: assignment.class_id,
          month,
          subject,
        });
    }
    for (const { student, classId, month, subject } of groups.values()) {
      const [year, m] = month.split('-').map(Number),
        end = new Date(Date.UTC(year, m, 1)).toISOString().slice(0, 10);
      const snapshot = computeFacts(
        db,
        tenant,
        {
          student_ref: student,
          from_date: month + '-01',
          to_date_exclusive: end,
          comparison_period: null,
          subjects: [subject],
          attempt_policy: 'latest_in_window',
          statistics_policy_version: 'grading-stats-3.0',
        },
        Date.now(),
        new Set([classId]),
      );
      const generation = sourceGeneration(db, tenant, student);
      const at =
        snapshot.result_refs
          .map((r) => {
            const value = one<{ payload: string }>(
              db,
              'SELECT payload FROM grading_v3_results WHERE tenant=? AND id=? AND revision=?',
              tenant,
              r.result_set_id,
              r.revision,
            );
            return value
              ? (JSON.parse(value.payload) as { confirmed_at: string })
                  .confirmed_at
              : '';
          })
          .sort()
          .at(-1) ?? snapshot.generated_at;
      const documentId = `grading-${student}-${classId}-${month}-${subject}`,
        sourceId = `${documentId}:g${generation}`;
      const facts: ApprovedFactInput[] = [];
      const lines = [
        `${month} 사진 숙제 확정 기록. 기간 내 최근 풀이 기준. 판독 불가·제외는 정답률 분모에서 제외. 검수·삭제 대기 자료를 이전 점수로 대체하지 않음.`,
      ];
      const definitions = submissions
        .filter((s) => s.student === student)
        .flatMap((s) => submissionAssignment(db, s).items);
      for (const f of snapshot.facts.filter(
        (f) => f.period_role === 'primary' && f.n_evaluable > 0,
      )) {
        const label = f.primary_skill_id
          ? (definitions.find(
              (d) =>
                d.primary_skill_id === f.primary_skill_id &&
                d.taxonomy_version === f.taxonomy_version,
            )?.skill_label ?? f.primary_skill_id)
          : '전체';
        lines.push(
          `${label}: ${f.n_evaluable}문항 중 ${f.n_correct}문항 정답.`,
          `${subjectNames[f.subject_id]} ${label}의 부가 기록: 오답 ${f.n_incorrect}, 부분 정답 ${f.n_partial}, 미응답 ${f.n_blank}. 점수 ${f.score_sum}/${f.max_score_sum}.`,
        );
        facts.push({
          factId: `${sourceId}:${f.subject_id}:${f.primary_skill_id ?? 'overall'}:${f.taxonomy_version ?? 'none'}`,
          sourceId,
          documentId,
          revision: generation,
          academyId: tenant,
          subjectType: 'student',
          subjectId: student,
          factType: 'accuracy',
          period: month,
          validFrom: at,
          approvalStatus: 'approved',
          value: {
            kind: 'accuracy',
            unit: label,
            dimension: f.primary_skill_id ? 'question_type' : 'overall',
            correct: f.n_correct,
            total: f.n_evaluable,
            referenceOnly: false,
            basis: 'classified_assessed',
            subject: subjectNames[f.subject_id],
          },
          evidence: `grading-stats-3.0. ${month} 기간 내 최근 풀이, ${f.n_evaluable} 평가 문항. 부분 정답·미응답은 정답 문항에 포함하지 않음. 원문 삭제 확인 후 공개된 현재 revision만 사용.`,
        });
      }
      if (!facts.length) continue;
      for (const a of snapshot.availability)
        if (a.n_pending_items || a.n_unavailable_items)
          lines.push(
            `${subjectNames[a.subject_id]} 대기 ${a.n_pending_items}문항, 확인 불가 ${a.n_unavailable_items}문항.`,
          );
      output.documents.push({
        academyId: tenant,
        documentId,
        revision: generation,
        sourceId,
        title: `${month} ${subjectNames[subject]} 사진 숙제 확정 분석`,
        documentType: 'student_analysis',
        text: lines.join('\n\n'),
        visibility: 'student_private',
        studentId: student,
        classId,
        validFrom: at,
        approvedAt: at,
        sourceUpdatedAt: at,
      });
      output.facts.push(...facts);
    }
    return output;
  };
  return collect();
}

export function gradingCatalog(db: OperationsDatabase, tenant: string) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='grading_v3_assignments'",
      )
      .get()
  )
    return { subjects: [], units: [] };
  const items = rows<{ payload: string }>(
    db,
    'SELECT payload FROM grading_v3_assignments WHERE tenant=?',
    tenant,
  ).flatMap((r) => {
    const a = JSON.parse(r.payload) as import('./contracts.ts').Assignment;
    return a.scope
      ? [{ subject_id: a.scope.subject, skill_label: a.scope.skill }]
      : a.items;
  });
  return {
    subjects: [...new Set(items.map((i) => subjectNames[i.subject_id]))],
    units: [...new Set(items.map((i) => i.skill_label))],
  };
}
