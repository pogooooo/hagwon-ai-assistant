/**
 * RAG 상담 도메인 내부 타입.
 * 서버 전용이며 클라이언트 번들에 포함하지 않는다.
 */
import type { RagPublicReasonCode } from '../contract.ts';

export type RagRole = 'visitor' | 'student' | 'guardian' | 'teacher' | 'admin';

/** 서버가 허용 학생에 대해서만 내려주는 표시 이름/별칭(예: "A01", "첫째"). */
export interface RagStudentRef {
  studentId: string;
  displayLabel: string;
  aliases: readonly string[];
}

/**
 * 서버 세션에서 확정되는 권한 컨텍스트.
 * 클라이언트 요청 본문·질문 텍스트로는 절대 만들거나 넓히지 않는다.
 */
export interface RagAccessScope {
  actorId: string;
  academyId: string;
  role: RagRole;
  allowedStudentIds: readonly string[];
  allowedClassIds: readonly string[];
  studentRefs: readonly RagStudentRef[];
  /** 공개 수강료·시간표의 과거 이력 열람 허용 여부(학원 정책). */
  canViewPublicHistory: boolean;
}

export type DocumentType =
  | 'academy_info'
  | 'fee'
  | 'schedule'
  | 'policy'
  | 'facility'
  | 'teacher'
  | 'announcement'
  | 'student_analysis'
  | 'guidance';

/**
 * 문서 revision 상태.
 * draft → indexing → indexed_verified → approved_active 순서로만 최신 답변에 노출된다.
 */
export type DocumentStatus =
  | 'draft'
  | 'indexing'
  | 'indexed_verified'
  | 'approved_active'
  | 'superseded'
  | 'deleted'
  | 'revoked'
  | 'index_failed';

/** academy_public: 같은 학원 이용자 공개, class_members: 허용 반, student_private: 대상 원생 권한자, staff_only: 강사·관리자. */
export type Visibility =
  'academy_public' | 'class_members' | 'student_private' | 'staff_only';

export interface SourceDocumentInput {
  academyId: string;
  documentId: string;
  revision: number;
  documentType: DocumentType;
  title: string;
  text: string;
  visibility: Visibility;
  studentId?: string | null;
  classId?: string | null;
  /** ISO-8601 (오프셋 포함). [validFrom, validTo) 구간으로 해석한다. */
  validFrom: string;
  validTo?: string | null;
  approvedAt?: string | null;
  sourceUpdatedAt?: string | null;
  aclPolicyId?: string | null;
  /** 지정하지 않으면 `${documentId}:r${revision}:body` */
  sourceId?: string;
}

export type DocumentFlag = 'prompt_injection_suspected' | 'empty_text';

export interface StoredDocumentRevision {
  academyId: string;
  documentId: string;
  revision: number;
  documentType: DocumentType;
  title: string;
  visibility: Visibility;
  studentId: string | null;
  classId: string | null;
  validFrom: number;
  validTo: number | null;
  approvedAt: number | null;
  sourceId: string;
  status: DocumentStatus;
  contentHash: string;
  flags: DocumentFlag[];
  chunkIds: string[];
  indexGeneration: number;
}

export interface ChunkLocation {
  kind: 'table_row' | 'paragraph';
  /** 사람이 읽을 수 있는 위치 표시. 예: "표 1 · 2행", "문단 1" */
  label: string;
  tableIndex?: number;
  rowIndex?: number;
  header?: string[];
  paragraphIndex?: number;
}

export interface RagChunk {
  chunkId: string;
  sourceId: string;
  documentId: string;
  revision: number;
  academyId: string;
  studentId: string | null;
  classId: string | null;
  documentType: DocumentType;
  visibility: Visibility;
  validFrom: number;
  validTo: number | null;
  title: string;
  location: ChunkLocation;
  /** 원문 텍스트(표 행은 "헤더: 값" 형태로 구조 보존). */
  text: string;
  /** 제목·대상·기간 메타데이터를 붙인 검색용 텍스트(생성 호출 없는 Contextual Retrieval). */
  contextualText: string;
  tokens: string[];
  suspicious: boolean;
}

export type FactType =
  | 'monthly_fee'
  | 'schedule'
  | 'teacher'
  | 'facility'
  | 'makeup_policy'
  | 'holiday'
  | 'accuracy'
  | 'notice'
  | 'contact'
  | 'capacity';

export type FactValue =
  | { kind: 'money'; amount: number; currency: 'KRW' }
  | { kind: 'schedule'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'holiday'; date: string; text: string }
  | { kind: 'accuracy'; correct: number; total: number; unit: string };

export interface ApprovedFactInput {
  factId: string;
  sourceId: string;
  documentId: string;
  revision: number;
  academyId: string;
  subjectType: 'student' | 'class' | 'academy';
  subjectId: string;
  factType: FactType;
  value: FactValue;
  /** 학습 분석 기간(YYYY-MM). 정형 학원 정보는 null. */
  period: string | null;
  validFrom: string;
  validTo?: string | null;
  approvalStatus: 'approved' | 'pending_review';
  assignmentIds?: string[];
}

export interface ApprovedFact {
  factId: string;
  sourceId: string;
  documentId: string;
  revision: number;
  academyId: string;
  subjectType: 'student' | 'class' | 'academy';
  subjectId: string;
  factType: FactType;
  value: FactValue;
  period: string | null;
  validFrom: number;
  validTo: number | null;
  approvalStatus: 'approved' | 'pending_review';
  assignmentIds: string[];
}

export interface AcademyClass {
  classId: string;
  name: string;
  aliases: readonly string[];
}

/** 현재 사용자의 학원에 한정된 카탈로그. 다른 학원의 이름·반은 절대 포함하지 않는다. */
export interface AcademyCatalog {
  academyId: string;
  displayName: string;
  aliases: readonly string[];
  classes: readonly AcademyClass[];
  /** 학습 분석 단원명(예: 일차방정식, 함수). */
  units: readonly string[];
}

/** 대화 상태는 서버에만 저장한다(클라이언트가 보낸 값으로 복원하지 않음). */
export interface ConversationState {
  selectedStudentId?: string;
  candidateStudentIds?: string[];
  selectedPeriod?: string;
  previousFrame?: {
    domain: 'analysis' | 'info';
    units: string[];
    periods: string[];
  };
}

export interface SourceSummary {
  sourceId: string;
  documentId: string;
  revision: number;
  title: string;
  location?: string;
}

/** 로그·내부 진단용 오류 유형(사용자 응답에는 노출하지 않음). */
export type RagInternalErrorType =
  | 'WRONG_ENTITY'
  | 'WRONG_PERIOD'
  | 'TABLE_CELL_MISMATCH'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CONTRADICTION'
  | 'STALE_REVISION'
  | 'CITATION_UNSUPPORTED'
  | 'NUMBER_UNSUPPORTED'
  | 'GENERATION_FAILED'
  | 'ACCESS_DENIED'
  | 'CROSS_TENANT_REFERENCE'
  | 'BULK_STUDENT_REQUEST'
  | 'SHARE_OR_PERMISSION_CHANGE'
  | 'CITATION_FORGERY'
  | 'PROMPT_INJECTION_DIRECTIVE'
  | 'UNEXPECTED_ERROR'
  | 'HANDOFF_DRAFT_FAILED';

export interface RagTrace {
  requestId: string;
  domain: 'analysis' | 'info' | 'security' | 'none';
  intent: string;
  /** 검색·조회 단계에서 후보로 읽은 청크/사실 ID(권한 필터 이후). */
  retrievedChunkIds: string[];
  retrievedFactIds: string[];
  usedFactIds: string[];
  generationCalls: number;
  /** 생성 모델에 실제 전달한 사실/출처 ID. */
  generationInputFactIds: string[];
  generationInputSourceIds: string[];
  reasonCode?: RagPublicReasonCode;
  internalErrors: RagInternalErrorType[];
  targetStudentIds: string[];
}
