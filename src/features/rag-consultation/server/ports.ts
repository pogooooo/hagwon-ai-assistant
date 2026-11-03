/**
 * 다른 기능(3·5·7·8·9번)과 연결되는 포트(어댑터 경계).
 * 실제 연동 시 비즈니스 로직이 아닌 이 인터페이스의 구현체만 교체한다.
 */
import type {
  AcademyCatalog,
  ApprovedFact,
  ApprovedFactInput,
  ConversationState,
  FactType,
  RagAccessScope,
  RagChunk,
  SourceDocumentInput,
  SourceSummary,
} from './types.ts';

/** 5·8번 기능: 인증된 서버 세션 → 권한 컨텍스트. 실패/미인증이면 null(fail-closed). */
export interface AccessScopePort<TSession> {
  resolveFromServerSession(session: TSession): Promise<RagAccessScope | null>;
}

export interface FactQuery {
  access: RagAccessScope;
  /** 조회 대상 학생(이미 access.allowedStudentIds 의 부분집합이어야 함). 학원/반 사실 조회 시 빈 배열. */
  studentIds: readonly string[];
  factTypes: readonly FactType[];
  /** 실제 서버 시각. 학습 분석 사실은 이 시각에 공개된 revision 만 보인다. */
  asOf: number;
  /** 정형 학원 정보의 적용 시점(질문의 "11월 4일 기준"). 없으면 asOf. */
  effectiveAt?: number;
  /** 공개 정형 정보의 과거 이력 포함 여부(권한 정책에서 허용된 경우만 반영). */
  includeHistory?: boolean;
}

/** 3·7번 기능: 승인된 정형 사실(점수·정답률·수강료·일정 등) 조회. */
export interface ApprovedFactsPort {
  queryApprovedFacts(query: FactQuery): Promise<ApprovedFact[]>;
}

export interface ChunkSearchQuery {
  access: RagAccessScope;
  studentIds: readonly string[];
  asOf: number;
  query: string;
  limit: number;
  documentTypes?: readonly string[];
  /** 프롬프트 인젝션 의심 청크 포함 여부(기본 false). */
  includeSuspicious?: boolean;
  /**
   * 사용자 원문 질문. 의미 검색(임베딩)과 재정렬은 키워드 묶음(query)이 아니라 이 원문을 쓴다.
   * 비어 있으면 query 를 쓴다.
   */
  question?: string;
  /** 재정렬 사용: never(기본) | auto(검색 순위가 애매할 때만) | always */
  rerank?: 'never' | 'auto' | 'always';
}

export interface ScoredChunk {
  chunk: RagChunk;
  score: number;
  /** 순위 신호(하이브리드·재정렬 사용 시): 근거 신뢰도 판단용 */
  signals?: {
    lexicalRank?: number;
    denseRank?: number;
    denseScore?: number;
    rerankScore?: number;
  };
}

export interface IndexRevisionResult {
  status: 'activated' | 'staged' | 'unchanged' | 'rejected' | 'failed';
  documentId: string;
  revision: number;
  reviewRequired: boolean;
  errorCode?:
    | 'INVALID_DOCUMENT'
    | 'REVISION_CONFLICT'
    | 'STALE_REVISION'
    | 'NOT_APPROVED'
    | 'INDEX_FAILED';
}

/** 7번 기능: 문서 색인·검색·변경/삭제 반영. */
export interface RagDocumentsPort {
  searchApprovedChunks(query: ChunkSearchQuery): Promise<ScoredChunk[]>;
  /** 인용 직전 재검증용. 권한·상태·버전이 유효하지 않으면 null. */
  getCitableSource(input: {
    access: RagAccessScope;
    studentIds: readonly string[];
    sourceId: string;
    asOf: number;
    /** 정형 학원 정보의 적용 시점(없으면 asOf) */
    effectiveAt?: number;
    /** 공개 정형 정보의 과거 이력 인용 허용 여부 */
    includeHistory?: boolean;
    /** 이 사실 값이 실제로 등장하는 위치(표 행 등)를 함께 찾는다. */
    locate?: ApprovedFact;
    /** Optional catalog identity for locating a class-specific fact in a table. */
    locateClassNames?: readonly string[];
  }): Promise<SourceSummary | null>;
  upsertIndexedRevision(input: {
    document: SourceDocumentInput;
    facts?: ApprovedFactInput[];
    approve: boolean;
  }): Promise<IndexRevisionResult>;
  revokeRevision(input: {
    documentId: string;
    revision?: number;
    reason: 'deleted' | 'revoked';
  }): Promise<void>;
  /**
   * (선택) 청크 위치에서 확인되는 정형 사실의 종류·대상. 검색 기반 의도 판별에 쓴다(값은 주지 않음 —
   * 값은 반드시 ApprovedFactsPort 로 권한·유효기간을 거쳐 조회).
   */
  /**
   * (선택) 권한 범위 안의 승인 자료에 이 낱말(공백 무시)이 한 번이라도 나오는지.
   * "자료에 전혀 없는 개념"을 묻는 질문을 보류할 때 쓴다.
   */
  corpusContains?(input: {
    access: RagAccessScope;
    studentIds: readonly string[];
    asOf: number;
    term: string;
  }): Promise<boolean>;
  factRefsAtChunk?(chunkId: string): Array<{
    factType: FactType;
    subjectType: 'student' | 'class' | 'academy';
    subjectId: string;
    period: string | null;
  }>;
}

/** 5번 기능: 학원·반·단원 카탈로그(현재 학원 한정). */
export interface CatalogPort {
  getAcademyCatalog(academyId: string): Promise<AcademyCatalog | null>;
}

export type GenerationAvailability =
  'available' | 'rate_limited' | 'unavailable' | 'quota_exhausted' | 'disabled';

export interface GenerationFactInput {
  factId: string;
  sourceId: string;
  /** 외부 전송 시 가명 처리된 대상 표시(예: "학생"). */
  subjectLabel: string;
  factType: FactType;
  period: string | null;
  /** 코드에서 확정한 값의 문자열 표현. 모델이 재계산하지 않는다. */
  valueText: string;
}

export interface GenerationSourceInput {
  sourceId: string;
  title: string;
  location: string;
  text: string;
}

export interface GenerationInput {
  requestId: string;
  question: string;
  facts: GenerationFactInput[];
  sources: GenerationSourceInput[];
  containsPersonalData: boolean;
}

export type GenerationErrorKind =
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'quota_exhausted'
  | 'invalid_response'
  | 'network_error';

export type GenerationResult =
  | { ok: true; rawText: string }
  | { ok: false; error: GenerationErrorKind; retryAfterMs?: number };

/** 생성 공급자. 질문당 최대 1회 호출하며 자동 공급자 전환은 하지 않는다. */
export interface GenerationPort {
  readonly providerId: string;
  /** 외부 네트워크로 데이터를 보내는 공급자인지 여부. */
  readonly isExternal: boolean;
  /** 약관·미성년 이용·국외 처리 검토가 끝나 개인 학습 데이터 전송이 승인됐는지. */
  readonly personalDataApproved: boolean;
  availability(now: number): GenerationAvailability;
  generateGroundedAnswer(
    input: GenerationInput,
    options: { timeoutMs: number; now: number },
  ): Promise<GenerationResult>;
}

export interface HandoffDraftInput {
  requestId: string;
  academyId: string;
  actorId: string;
  reasonCode: string;
  studentIds: string[];
  question: string;
}

/** 9번 기능: 담당자 연결. 실제 배정·예약 UI는 9번 기능이 담당한다. */
export interface HandoffPort {
  createRequestOrDraft(input: HandoffDraftInput): Promise<{ draftId: string }>;
}

/** 서버 측 대화 상태. actorId 로 격리해 다른 사용자의 대화를 불러올 수 없게 한다. */
export interface ConversationStatePort {
  load(
    actorId: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  save(
    actorId: string,
    conversationId: string,
    state: ConversationState,
  ): Promise<void>;
}

export interface Clock {
  now(): number;
}

/** 개인정보를 남기지 않는 최소 로그. 질문·답변 원문은 전달하지 않는다. */
export interface RagLogger {
  log(event: RagLogEvent): void;
}

export interface RagLogEvent {
  event: 'rag.query' | 'rag.index' | 'rag.generation' | 'rag.http_error';
  requestId?: string;
  status?: string;
  reasonCode?: string;
  intent?: string;
  latencyMs?: number;
  sourceIds?: string[];
  generationCalls?: number;
  errorType?: string;
  documentId?: string;
  revision?: number;
}
