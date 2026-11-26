/**
 * 4번 기능(파일 기반 RAG 상담)의 공개 계약.
 *
 * 이 파일은 웹/Capacitor 클라이언트에서도 import 할 수 있도록
 * 서버 전용 코드·비밀값·내부 ID 규칙을 포함하지 않는다.
 */
import { z } from 'zod';

export const RAG_ANSWER_STATUSES = [
  'answered',
  'partial',
  'abstained',
  'clarify',
  'denied',
  'handoff',
] as const;

export type RagAnswerStatus = (typeof RAG_ANSWER_STATUSES)[number];

/** 사용자에게 노출해도 되는 사유 코드. 내부 오류 유형(WRONG_ENTITY 등)은 로그에만 남긴다. */
export const RAG_PUBLIC_REASON_CODES = [
  'INSUFFICIENT_EVIDENCE',
  'PARTIAL_EVIDENCE',
  'CONFLICTING_EVIDENCE',
  'AMBIGUOUS_SUBJECT',
  'OUT_OF_SCOPE',
  'UNSUPPORTED_REQUEST',
  'CAUSAL_CLAIM_NOT_SUPPORTED',
  'PREDICTION_NOT_SUPPORTED',
  'MISATTRIBUTION_REQUEST',
  'GENERATION_UNAVAILABLE',
  'GENERATION_REJECTED',
  'PERSONAL_DATA_TRANSFER_NOT_APPROVED',
] as const;

export type RagPublicReasonCode = (typeof RAG_PUBLIC_REASON_CODES)[number];

export interface RagCitation {
  /** 서버가 발급한 인용 가능한 출처 ID. 모델이나 사용자가 만든 값은 들어가지 않는다. */
  sourceId: string;
  documentId: string;
  title: string;
  /** 페이지/절/표 행 등 근거 위치. */
  location?: string;
  revision?: number;
}

export interface RagHandoffInfo {
  /** true 이면 담당자 상담 연결을 권장한다. 실제 배정은 9번 기능이 담당한다. */
  needed: boolean;
  reasonCode: RagPublicReasonCode;
}

export interface RagAnswer {
  status: RagAnswerStatus;
  answer: string;
  citations: RagCitation[];
  /** 답변에 필요했지만 확인되지 않은 항목(민감한 내부 정보 제외). */
  missingFields?: string[];
  /** status=clarify 일 때 사용자가 고를 수 있는 대상 표시 이름. */
  clarifyOptions?: string[];
  handoff?: RagHandoffInfo;
  requestId: string;
}

/**
 * 상담 요청 본문.
 * - academyId, role, allowedStudentIds 등은 받지 않는다(받아도 무시). 권한은 서버 세션에서만 계산한다.
 * - studentId 는 조회 대상을 가리키는 "힌트"일 뿐이며, 서버 권한 범위 밖이면 denied 가 된다.
 */
export const ragQueryRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  studentId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  conversationId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .optional(),
});

export type RagQueryRequest = z.infer<typeof ragQueryRequestSchema>;

export interface RagErrorBody {
  error: {
    code:
      | 'INVALID_REQUEST'
      | 'UNAUTHENTICATED'
      | 'METHOD_NOT_ALLOWED'
      | 'PAYLOAD_TOO_LARGE'
      | 'UNSUPPORTED_MEDIA_TYPE'
      | 'RATE_LIMITED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'INTERNAL_ERROR';
    message: string;
  };
  requestId: string;
}
