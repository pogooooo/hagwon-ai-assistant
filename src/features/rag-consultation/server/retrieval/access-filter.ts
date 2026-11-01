/**
 * 모든 검색·정형 조회가 공통으로 쓰는 "검색 전" 권한 판정.
 * 결과를 모은 뒤 숨기는 방식(후단 필터)을 쓰지 않는다.
 */
import type { RagAccessScope, Visibility } from '../types.ts';

export interface AccessControlledRecord {
  academyId: string;
  visibility: Visibility;
  studentId: string | null;
  classId: string | null;
}

/**
 * @param targetStudentIds 이번 질문에서 조회하기로 확정한 학생(허용 학생의 부분집합).
 *   허용된 형제라도 이번 질문 대상이 아니면 개인 자료를 읽지 않는다.
 */
export function canReadRecord(
  access: RagAccessScope,
  record: AccessControlledRecord,
  targetStudentIds: readonly string[],
): boolean {
  if (record.academyId !== access.academyId) return false;

  if (record.studentId !== null) {
    return (
      access.allowedStudentIds.includes(record.studentId) &&
      targetStudentIds.includes(record.studentId)
    );
  }

  switch (record.visibility) {
    case 'academy_public':
      return true;
    case 'class_members':
      return (
        record.classId !== null &&
        access.allowedClassIds.includes(record.classId)
      );
    case 'staff_only':
      return access.role === 'teacher' || access.role === 'admin';
    case 'student_private':
      // 대상 학생이 없는 개인 문서는 해석할 수 없으므로 거부(fail-closed)
      return false;
    default:
      return false;
  }
}

/** 요청된 대상 학생을 서버 허용 범위로 한 번 더 제한한다(심층 방어). */
export function restrictToAllowedStudents(
  access: RagAccessScope,
  studentIds: readonly string[],
): string[] {
  return studentIds.filter((id) => access.allowedStudentIds.includes(id));
}
