/**
 * 개발·테스트용 메모리 저장소(문서 revision + 청크 + 정형 사실).
 * 운영 DB(PostgreSQL/SQLite 등) 어댑터로 교체할 때도 아래 불변식을 유지해야 한다.
 *
 * 불변식
 * 1. 검색·조회는 "활성(approved_active) revision"만 대상으로 하며, 권한 필터를 먼저 적용한다.
 * 2. revision 은 불변이다. 같은 revision 에 다른 내용이 오면 거부한다(멱등: 같은 내용은 무시).
 * 3. 더 낮은 revision 이 나중에 도착해도 활성화하지 않는다(순서 역전 방지).
 * 4. 삭제·권한 철회는 즉시 조회에서 제외된다.
 * 5. 사실(fact)은 자신이 속한 문서 revision 이 활성일 때만 보인다.
 * 6. 승인된 새 revision 의 색인이 끝나지 않았거나 실패하면, 그 문서의 이전 revision 은 검색·조회에서 제외한다
 *    (검증되지 않은 구버전을 현재 값으로 답하지 않도록 보류 쪽으로 실패).
 */
import { DEFAULT_RAG_CONFIG } from '../config.ts';
import { buildChunks } from '../ingest/chunking.ts';
import {
  contentHash,
  isSuspiciousInstruction,
  validateDocument,
} from '../ingest/validation.ts';
import type {
  ApprovedFactsPort,
  ChunkSearchQuery,
  FactQuery,
  IndexRevisionResult,
  RagDocumentsPort,
  RagLogger,
  ScoredChunk,
} from '../ports.ts';
import {
  canReadRecord,
  restrictToAllowedStudents,
} from '../retrieval/access-filter.ts';
import { bm25Rank } from '../retrieval/bm25.ts';
import { tokenize } from '../text/normalize.ts';
import { isValidAt, parseInstant, parseOptionalInstant } from '../text/time.ts';
import type {
  ApprovedFact,
  ApprovedFactInput,
  RagAccessScope,
  RagChunk,
  SourceDocumentInput,
  SourceSummary,
  StoredDocumentRevision,
} from '../types.ts';

const keyOf = (documentId: string, revision: number) =>
  `${documentId}#${revision}`;

export interface InMemoryRagStoreOptions {
  logger?: RagLogger;
  maxDocumentChars?: number;
  /** 테스트에서 색인 실패를 주입하기 위한 훅 */
  failIndexing?: (document: SourceDocumentInput) => boolean;
}

export class InMemoryRagStore implements ApprovedFactsPort, RagDocumentsPort {
  private readonly revisions = new Map<string, StoredDocumentRevision>();
  private readonly activeRevision = new Map<string, number>();
  private readonly chunks = new Map<string, RagChunk>();
  private readonly factsByRevision = new Map<string, ApprovedFact[]>();
  /** 승인됐지만 아직 색인·검증이 끝나지 않은(또는 실패한) 최신 revision. 이 문서의 이전 revision 은 '현재 값'으로 쓰지 않는다. */
  private readonly pendingApproved = new Map<string, number>();
  private readonly logger: RagLogger | undefined;
  private readonly maxDocumentChars: number;
  private readonly failIndexing:
    ((document: SourceDocumentInput) => boolean) | undefined;
  private generation = 0;

  constructor(options: InMemoryRagStoreOptions = {}) {
    this.logger = options.logger;
    this.maxDocumentChars =
      options.maxDocumentChars ?? DEFAULT_RAG_CONFIG.maxDocumentChars;
    this.failIndexing = options.failIndexing;
  }

  /** 색인 세대. 문서 활성화·삭제 때마다 증가(캐시 키·관측용). */
  get indexGeneration(): number {
    return this.generation;
  }

  async upsertIndexedRevision(input: {
    document: SourceDocumentInput;
    facts?: ApprovedFactInput[];
    approve: boolean;
  }): Promise<IndexRevisionResult> {
    const { document, approve } = input;
    const facts = input.facts ?? [];
    const base = {
      documentId: document.documentId,
      revision: document.revision,
    };

    const validation = validateDocument(document, facts, {
      maxDocumentChars: this.maxDocumentChars,
    });
    if (!validation.ok) {
      this.log('INVALID_DOCUMENT', document);
      return {
        ...base,
        status: 'rejected',
        reviewRequired: true,
        errorCode: 'INVALID_DOCUMENT',
      };
    }

    const key = keyOf(document.documentId, document.revision);
    const hash = contentHash(document, facts);
    const existing = this.revisions.get(key);
    if (
      existing &&
      existing.status === 'index_failed' &&
      existing.contentHash === hash
    ) {
      // 색인 실패한 revision 의 재시도: 이전 시도 흔적을 지우고 다시 색인한다.
      for (const chunkId of existing.chunkIds) this.chunks.delete(chunkId);
      this.factsByRevision.delete(key);
      this.revisions.delete(key);
    } else if (existing) {
      if (existing.contentHash !== hash) {
        this.log('REVISION_CONFLICT', document);
        return {
          ...base,
          status: 'rejected',
          reviewRequired: true,
          errorCode: 'REVISION_CONFLICT',
        };
      }
      if (existing.status === 'deleted' || existing.status === 'revoked') {
        return {
          ...base,
          status: 'rejected',
          reviewRequired: true,
          errorCode: 'STALE_REVISION',
        };
      }
      if (approve && existing.status === 'indexed_verified') {
        return this.activateRevision(document.documentId, document.revision);
      }
      return {
        ...base,
        status: 'unchanged',
        reviewRequired: existing.flags.length > 0,
      };
    }

    const active = this.activeRevision.get(document.documentId);
    if (active !== undefined && active > document.revision) {
      this.log('STALE_REVISION', document);
      return {
        ...base,
        status: 'rejected',
        reviewRequired: false,
        errorCode: 'STALE_REVISION',
      };
    }

    if (approve) {
      const pending = this.pendingApproved.get(document.documentId) ?? 0;
      if (document.revision > pending)
        this.pendingApproved.set(document.documentId, document.revision);
    }

    const sourceId =
      document.sourceId ?? `${document.documentId}:r${document.revision}:body`;
    const stored: StoredDocumentRevision = {
      academyId: document.academyId,
      documentId: document.documentId,
      revision: document.revision,
      documentType: document.documentType,
      title: document.title,
      visibility: document.visibility,
      studentId: document.studentId ?? null,
      classId: document.classId ?? null,
      validFrom: parseInstant(document.validFrom),
      validTo: parseOptionalInstant(document.validTo),
      approvedAt: parseOptionalInstant(document.approvedAt),
      sourceId,
      status: 'indexing',
      contentHash: hash,
      flags: [],
      chunkIds: [],
      indexGeneration: this.generation,
    };
    this.revisions.set(key, stored);

    if (this.failIndexing?.(document)) {
      stored.status = 'index_failed';
      this.log('INDEX_FAILED', document);
      return {
        ...base,
        status: 'failed',
        reviewRequired: true,
        errorCode: 'INDEX_FAILED',
      };
    }

    const chunks = buildChunks(stored, document.text, isSuspiciousInstruction);
    if (
      chunks.length === 0 ||
      chunks.some((chunk) => chunk.sourceId !== sourceId)
    ) {
      stored.status = 'index_failed';
      return {
        ...base,
        status: 'failed',
        reviewRequired: true,
        errorCode: 'INDEX_FAILED',
      };
    }
    for (const chunk of chunks) this.chunks.set(chunk.chunkId, chunk);
    stored.chunkIds = chunks.map((chunk) => chunk.chunkId);
    if (chunks.some((chunk) => chunk.suspicious))
      stored.flags.push('prompt_injection_suspected');

    this.factsByRevision.set(
      key,
      facts.map((fact) => ({
        factId: fact.factId,
        sourceId: fact.sourceId,
        documentId: fact.documentId,
        revision: fact.revision,
        academyId: fact.academyId,
        subjectType: fact.subjectType,
        subjectId: fact.subjectId,
        factType: fact.factType,
        value: fact.value,
        period: fact.period,
        validFrom: parseInstant(fact.validFrom),
        validTo: parseOptionalInstant(fact.validTo),
        approvalStatus: fact.approvalStatus,
        assignmentIds: fact.assignmentIds ?? [],
      })),
    );
    stored.status = 'indexed_verified';

    if (!approve) {
      return {
        ...base,
        status: 'staged',
        reviewRequired: stored.flags.length > 0,
      };
    }
    return this.activateRevision(document.documentId, document.revision);
  }

  /** 승인된 revision 을 원자적으로 활성 전환한다. 이전 활성 revision 은 superseded. */
  activateRevision(documentId: string, revision: number): IndexRevisionResult {
    const base = { documentId, revision };
    const stored = this.revisions.get(keyOf(documentId, revision));
    if (!stored || stored.status !== 'indexed_verified') {
      return {
        ...base,
        status: 'rejected',
        reviewRequired: false,
        errorCode: 'NOT_APPROVED',
      };
    }
    const active = this.activeRevision.get(documentId);
    if (active !== undefined && active > revision) {
      return {
        ...base,
        status: 'rejected',
        reviewRequired: false,
        errorCode: 'STALE_REVISION',
      };
    }
    if (active !== undefined) {
      const previous = this.revisions.get(keyOf(documentId, active));
      if (previous) previous.status = 'superseded';
    }
    stored.status = 'approved_active';
    this.activeRevision.set(documentId, revision);
    if ((this.pendingApproved.get(documentId) ?? 0) <= revision)
      this.pendingApproved.delete(documentId);
    this.generation += 1;
    stored.indexGeneration = this.generation;
    this.logger?.log({
      event: 'rag.index',
      status: 'activated',
      documentId,
      revision,
    });
    return {
      ...base,
      status: 'activated',
      reviewRequired: stored.flags.length > 0,
    };
  }

  async revokeRevision(input: {
    documentId: string;
    revision?: number;
    reason: 'deleted' | 'revoked';
  }): Promise<void> {
    for (const stored of this.revisions.values()) {
      if (stored.documentId !== input.documentId) continue;
      if (input.revision !== undefined && stored.revision !== input.revision)
        continue;
      stored.status = input.reason;
      if (this.activeRevision.get(stored.documentId) === stored.revision) {
        this.activeRevision.delete(stored.documentId);
      }
    }
    if (
      input.revision === undefined ||
      this.pendingApproved.get(input.documentId) === input.revision
    ) {
      this.pendingApproved.delete(input.documentId);
    }
    this.generation += 1;
    this.logger?.log({
      event: 'rag.index',
      status: input.reason,
      documentId: input.documentId,
      revision: input.revision,
    });
  }

  /** 문서에 승인됐지만 아직 활성화되지 못한 revision 이 있는지(운영 알림·상태 조회용). */
  hasPendingApprovedRevision(documentId: string): boolean {
    const pending = this.pendingApproved.get(documentId);
    return (
      pending !== undefined &&
      pending > (this.activeRevision.get(documentId) ?? 0)
    );
  }

  getRevisionStatus(documentId: string, revision: number) {
    return this.revisions.get(keyOf(documentId, revision))?.status ?? null;
  }

  private activeRevisions(): StoredDocumentRevision[] {
    const result: StoredDocumentRevision[] = [];
    for (const [documentId, revision] of this.activeRevision) {
      const pending = this.pendingApproved.get(documentId);
      if (pending !== undefined && pending > revision) continue;
      const stored = this.revisions.get(keyOf(documentId, revision));
      if (stored && stored.status === 'approved_active') result.push(stored);
    }
    return result;
  }

  async queryApprovedFacts(query: FactQuery): Promise<ApprovedFact[]> {
    const targets = restrictToAllowedStudents(query.access, query.studentIds);
    const effectiveAt = query.effectiveAt ?? query.asOf;
    const historyAllowed =
      Boolean(query.includeHistory) && query.access.canViewPublicHistory;
    const result: ApprovedFact[] = [];

    for (const stored of this.activeRevisions()) {
      if (!canReadRecord(query.access, stored, targets)) continue;
      const facts =
        this.factsByRevision.get(keyOf(stored.documentId, stored.revision)) ??
        [];
      for (const fact of facts) {
        if (fact.approvalStatus !== 'approved') continue;
        if (fact.academyId !== query.access.academyId) continue;
        if (!query.factTypes.includes(fact.factType)) continue;
        if (fact.subjectType === 'student') {
          if (!targets.includes(fact.subjectId)) continue;
          // 학습 분석은 "현재 시각에 공개된 revision" 만 사용한다.
          if (!isValidAt(fact.validFrom, fact.validTo, query.asOf)) continue;
        } else {
          const current = isValidAt(fact.validFrom, fact.validTo, effectiveAt);
          const past =
            historyAllowed &&
            stored.visibility === 'academy_public' &&
            fact.validTo !== null &&
            fact.validTo <= effectiveAt;
          if (!current && !past) continue;
        }
        result.push(fact);
      }
    }
    return result.sort((a, b) => a.factId.localeCompare(b.factId));
  }

  async searchApprovedChunks(query: ChunkSearchQuery): Promise<ScoredChunk[]> {
    const targets = restrictToAllowedStudents(query.access, query.studentIds);
    const candidates: RagChunk[] = [];
    for (const stored of this.activeRevisions()) {
      if (!canReadRecord(query.access, stored, targets)) continue;
      if (!isValidAt(stored.validFrom, stored.validTo, query.asOf)) continue;
      if (
        query.documentTypes &&
        !query.documentTypes.includes(stored.documentType)
      )
        continue;
      for (const chunkId of stored.chunkIds) {
        const chunk = this.chunks.get(chunkId);
        if (!chunk) continue;
        if (chunk.suspicious && !query.includeSuspicious) continue;
        candidates.push(chunk);
      }
    }
    const ranked = bm25Rank(
      candidates.map((chunk) => ({
        id: chunk.chunkId,
        tokens: chunk.tokens,
        chunk,
      })),
      tokenize(query.query),
    );
    return ranked.slice(0, query.limit).map(({ document, score }) => ({
      chunk: document.chunk,
      score,
    }));
  }

  async getCitableSource(input: {
    access: RagAccessScope;
    studentIds: readonly string[];
    sourceId: string;
    asOf: number;
    effectiveAt?: number;
    includeHistory?: boolean;
    locate?: ApprovedFact;
  }): Promise<SourceSummary | null> {
    const targets = restrictToAllowedStudents(input.access, input.studentIds);
    const at = input.effectiveAt ?? input.asOf;
    for (const stored of this.activeRevisions()) {
      if (stored.sourceId !== input.sourceId) continue;
      if (!canReadRecord(input.access, stored, targets)) return null;
      const current = isValidAt(stored.validFrom, stored.validTo, at);
      const past =
        Boolean(input.includeHistory) &&
        input.access.canViewPublicHistory &&
        stored.visibility === 'academy_public' &&
        stored.validTo !== null &&
        stored.validTo <= at;
      if (!current && !past) return null;
      const located = input.locate ? this.locateFact(input.locate) : null;
      return {
        sourceId: stored.sourceId,
        documentId: stored.documentId,
        revision: stored.revision,
        title: stored.title,
        location: located?.location.label,
      };
    }
    return null;
  }

  /** 사실 값이 실제로 등장하는 청크 위치(표 행 등)를 찾는다. */
  private locateFact(fact: ApprovedFact): RagChunk | null {
    const stored = this.revisions.get(keyOf(fact.documentId, fact.revision));
    if (!stored) return null;
    const chunks = stored.chunkIds
      .map((id) => this.chunks.get(id))
      .filter((chunk): chunk is RagChunk => Boolean(chunk));
    const needles = factNeedles(fact);
    return (
      chunks.find((chunk) =>
        needles.some((needle) =>
          chunk.text.replace(/\s/g, '').includes(needle),
        ),
      ) ??
      chunks[0] ??
      null
    );
  }

  private log(errorType: string, document: SourceDocumentInput) {
    this.logger?.log({
      event: 'rag.index',
      status: 'rejected',
      errorType,
      documentId: document.documentId,
      revision: document.revision,
    });
  }
}

function factNeedles(fact: ApprovedFact): string[] {
  switch (fact.value.kind) {
    case 'money':
      return [String(fact.value.amount)];
    case 'accuracy':
      return [fact.value.unit, `${fact.value.correct}`];
    case 'holiday':
      return [fact.value.date];
    default:
      return [];
  }
}
