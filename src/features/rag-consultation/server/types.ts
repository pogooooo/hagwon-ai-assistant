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
  /** 서버가 아는 이 학생의 수강 반(“첫째 반 수강료”처럼 반을 대신 지칭할 때 사용) */
  classIds?: readonly string[];
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
  /** 원본 파일 파싱 결과(PDF·스캔·DOCX·HWPX 등). Markdown 원문을 직접 넣을 때는 생략 */
  extraction?: DocumentExtraction;
  /** 지정하지 않으면 `${documentId}:r${revision}:body` */
  sourceId?: string;
}

export type DocumentFlag =
  | 'prompt_injection_suspected'
  | 'empty_text'
  /** 스캔(OCR) 페이지의 판독 신뢰도가 낮아 사람이 검수해야 함 */
  | 'ocr_needs_review'
  /** 색인 전 개인정보(주민번호·개인 휴대폰)를 가림 */
  | 'pii_masked'
  /** 같은 학원의 다른 활성 문서와 본문이 같음(중복 업로드) — 검색에서 제외 */
  | 'duplicate_content';

/** 원본 파일 파싱 결과 요약(ingest/parsers 가 만든다). 페이지 품질은 청크의 판독 신뢰도 판단에 쓴다. */
export interface DocumentExtraction {
  fileName?: string;
  format: string;
  status: 'ok' | 'needs_review' | 'partial';
  pages: Array<{
    page: number;
    method: 'text' | 'ocr' | 'empty';
    confidence?: number;
    rotation?: number;
    uncertainTokens?: string[];
    needsReview?: boolean;
  }>;
  warnings?: string[];
}

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
  /** 이 revision 이 효력을 갖기 시작한 시각 = 승인 시각(없으면 유효 시작). 활성화 전에는 null. */
  activatedAt: number | null;
  sourceId: string;
  status: DocumentStatus;
  contentHash: string;
  flags: DocumentFlag[];
  chunkIds: string[];
  indexGeneration: number;
  extraction?: DocumentExtraction;
  /** duplicate_content 인 경우 같은 본문을 가진 원본 문서 ID */
  duplicateOf?: string;
}

export interface ChunkLocation {
  kind: 'table_row' | 'paragraph';
  /** 사람이 읽을 수 있는 위치 표시. 예: "표 1 · 2행", "문단 1" */
  label: string;
  tableIndex?: number;
  rowIndex?: number;
  header?: string[];
  paragraphIndex?: number;
  /** 문서의 절 제목(## 제목) */
  section?: string;
  /** 표 행의 셀 값(헤더와 같은 순서) — 질문한 칸만 골라 인용할 때 사용 */
  cells?: string[];
  /** 원본 파일의 쪽 번호(PDF 등). 정규화 Markdown 의 `<!-- page N -->` 에서 온다 */
  page?: number;
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
  /** 원본이 OCR 인 청크의 판독 품질. uncertainTokens 에 든 값(금액·날짜 등)은 답변 근거로 쓰지 않는다 */
  extraction?: {
    method: 'text' | 'ocr' | 'empty';
    confidence?: number;
    uncertainTokens: string[];
    needsReview: boolean;
  };
}

export type FactType =
  | 'monthly_fee'
  | 'material_fee'
  | 'schedule'
  | 'teacher'
  | 'facility'
  | 'makeup_policy'
  | 'enrollment_status'
  | 'schedule_change'
  | 'accuracy'
  | 'weak_area'
  | 'learning_guidance'
  | 'notice'
  | 'contact';

/** unit: 단원별, question_type: 문항 유형별, overall: 전체 합계(3번 기능 산출) */
export type AccuracyDimension = 'unit' | 'question_type' | 'overall';

export type FactValue =
  | { kind: 'money'; amount: number; currency: 'KRW' }
  | { kind: 'schedule'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'schedule_change';
      changeType: 'cancel' | 'makeup';
      /** YYYY-MM-DD (KST) */
      date: string;
      time: string | null;
      text: string;
    }
  | {
      kind: 'enrollment';
      status: 'open' | 'waitlist' | 'closed';
      capacity: number | null;
      remaining: number | null;
      text: string;
    }
  | {
      kind: 'accuracy';
      correct: number;
      total: number;
      /** 단원명·유형명, overall 이면 "전체" */
      unit: string;
      dimension?: AccuracyDimension;
    }
  | { kind: 'weak_area'; unit: string; text: string };

/** 분석 사실의 근거 숙제(3·6번 기능). */
export interface FactAssignment {
  assignmentId: string;
  title: string;
}

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
  assignments?: FactAssignment[];
  /** 근거 문항 등 보충 설명(예: "5·7·12번 오답") */
  evidence?: string | null;
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
  assignments: FactAssignment[];
  evidence: string | null;
  /** 사실이 속한 문서의 반(과목 구분용, 예: 같은 학생의 수학·국어 리포트) */
  classId: string | null;
}

export interface AcademyClass {
  classId: string;
  name: string;
  aliases: readonly string[];
  subject?: string;
  grade?: string;
}

/**
 * 학원 원생 명부(서버 전용). 권한 밖 학생을 이름으로 지칭했는지 판별하는 데만 쓰며,
 * 이름·존재 여부를 응답에 노출하지 않는다.
 */
export interface StudentDirectoryEntry {
  studentId: string;
  names: readonly string[];
}

/** 현재 사용자의 학원에 한정된 카탈로그. 다른 학원의 이름·반은 절대 포함하지 않는다. */
export interface AcademyCatalog {
  academyId: string;
  displayName: string;
  aliases: readonly string[];
  classes: readonly AcademyClass[];
  /** 학습 분석 단원명(예: 일차방정식, 함수). */
  units: readonly string[];
  /** 학습 분석 문항 유형명(예: 계산, 서술형). */
  questionTypes?: readonly string[];
  studentDirectory?: readonly StudentDirectoryEntry[];
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
  /** 스캔(OCR) 문서의 판독이 불확실한 수치를 답에 쓰려 함 → 검수 필요 */
  | 'OCR_UNCERTAIN'
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
