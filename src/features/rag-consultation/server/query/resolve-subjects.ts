/**
 * 학습 분석 질문의 대상 학생 확정.
 * - 근거는 서버 권한(allowedStudentIds)과 서버 대화 상태뿐이다.
 * - 질문 텍스트/요청 힌트는 "허용 범위 안에서 고르는" 용도로만 쓴다.
 * - 복수 자녀 중 누구인지 모호하면 임의로 고르지 않고 clarify.
 */
import type { ConversationState, RagAccessScope } from '../types.ts';
import type { QueryFrame } from './parse-query.ts';

export type SubjectResolution =
  | { kind: 'denied' }
  | { kind: 'clarify'; optionStudentIds: string[] }
  | {
      kind: 'resolved';
      studentIds: string[];
      source: 'explicit' | 'hint' | 'session' | 'single' | 'group' | 'self';
    };

export function resolveSubjects(input: {
  access: RagAccessScope;
  frame: QueryFrame;
  state: ConversationState | null;
  studentIdHint?: string;
}): SubjectResolution {
  const { access, frame, state, studentIdHint } = input;
  const allowed = access.allowedStudentIds;

  if (frame.unauthorizedStudentRefs.length > 0) return { kind: 'denied' };
  if (studentIdHint !== undefined && !allowed.includes(studentIdHint))
    return { kind: 'denied' };
  if (allowed.length === 0) return { kind: 'denied' };

  if (frame.matchedStudentIds.length > 0) {
    return {
      kind: 'resolved',
      studentIds: frame.matchedStudentIds,
      source: 'explicit',
    };
  }
  if (frame.unresolvedRelationWords.length > 0) {
    return { kind: 'clarify', optionStudentIds: [...allowed] };
  }
  if (studentIdHint !== undefined) {
    return { kind: 'resolved', studentIds: [studentIdHint], source: 'hint' };
  }
  if (frame.groupReference) {
    return { kind: 'resolved', studentIds: [...allowed], source: 'group' };
  }

  const sessionStudent = state?.selectedStudentId;
  if (sessionStudent !== undefined && !allowed.includes(sessionStudent)) {
    // 서버 대화 상태가 현재 권한과 맞지 않으면(연결 해제 등) 사용하지 않고 차단한다.
    return { kind: 'denied' };
  }

  if (
    frame.selfReference &&
    access.role === 'student' &&
    allowed.length === 1
  ) {
    return { kind: 'resolved', studentIds: [allowed[0]], source: 'self' };
  }
  if (sessionStudent !== undefined) {
    return {
      kind: 'resolved',
      studentIds: [sessionStudent],
      source: 'session',
    };
  }
  if (allowed.length === 1) {
    return { kind: 'resolved', studentIds: [allowed[0]], source: 'single' };
  }
  const candidates = (state?.candidateStudentIds ?? []).filter((id) =>
    allowed.includes(id),
  );
  return {
    kind: 'clarify',
    optionStudentIds: candidates.length > 0 ? candidates : [...allowed],
  };
}
