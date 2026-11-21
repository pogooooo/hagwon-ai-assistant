import { accessibleStudents } from '../academy-operations/directory.ts';
import { rows, type PageContext } from '../academy-operations/shared.ts';
import { listAssignments, type Submission } from './service.ts';

export const gradingStates: Record<string, string> = {
  RECEIVED: '사진 제출 대기',
  PROCESSING: '판독 중',
  REVIEW_REQUIRED: '강사 확인 필요',
  READY_TO_CONFIRM: '확정 가능',
  CONFIRMED: '검수 확정',
  EXPIRED: '사진 보존기한 종료',
  FAILED: '처리 실패',
  CANCELLED: '처리 취소',
  OPEN: '임시 보관',
  CLOSING: '삭제 준비',
  PURGE_PENDING: '삭제 확인 중',
  PURGE_RETRY: '삭제 재시도 중',
  VERIFIED: '자체 임시자료 삭제 확인',
};

export function gradingOverview(ctx: PageContext) {
  const assignments = listAssignments(ctx);
  const students = accessibleStudents(ctx.db, ctx.actor);
  const pupils = new Map(students.map((s) => [s.id, s]));
  const definitions = new Map(
    assignments.map((a) => [a.assignment_id + ':' + a.assignment_version, a]),
  );
  const entries = rows<
    Pick<
      Submission,
      | 'id'
      | 'student'
      | 'assignment'
      | 'assignment_version'
      | 'processing'
      | 'raw_state'
      | 'assessment_date'
      | 'purpose'
    > & { published: number }
  >(
    ctx.db,
    `SELECT s.id,s.student,s.assignment,s.assignment_version,s.processing,s.raw_state,s.assessment_date,s.purpose,
       EXISTS(SELECT 1 FROM grading_v3_results r JOIN grading_v3_receipts receipt
         ON receipt.tenant=r.tenant AND receipt.scope=json_extract(r.payload,'$.raw_scope_id')
           AND receipt.generation=json_extract(r.payload,'$.raw_generation')
         WHERE r.tenant=s.tenant AND r.id=s.result_id AND r.revision=s.current_revision
           AND s.published_revision=r.revision AND s.purpose='assessment') AS published
       FROM grading_v3_submissions s WHERE s.tenant=? ORDER BY s.submitted_at DESC,s.id DESC`,
    ctx.actor.academyId,
  ).flatMap((s) => {
    const assignment = definitions.get(
        s.assignment + ':' + s.assignment_version,
      ),
      student = pupils.get(s.student);
    if (
      !assignment ||
      !student ||
      (s.purpose !== 'assessment' &&
        !['teacher', 'admin'].includes(ctx.actor.role))
    )
      return [];
    return [
      {
        ...s,
        title: assignment.title,
        studentName: student.name,
        classId: assignment.class_id,
        href: '/grading?submission=' + encodeURIComponent(s.id),
      },
    ];
  });
  const review = entries.filter(
    (s) =>
      s.raw_state === 'OPEN' &&
      ['REVIEW_REQUIRED', 'READY_TO_CONFIRM'].includes(s.processing),
  );
  const purge = entries.filter((s) =>
    ['PURGE_PENDING', 'PURGE_RETRY', 'CLOSING'].includes(s.raw_state),
  );
  return {
    assignments,
    students,
    entries,
    review,
    purge,
    results: entries.filter((s) => s.published),
  };
}
