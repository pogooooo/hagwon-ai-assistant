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
 * 7. 승인 시각(asOf)과 적용 시각을 구분한다. 조회 시점에 알려진 개정 중
 *    질문한 적용 시점에 시작된 가장 높은 개정을 사용한다.
 */
import { createHash } from 'node:crypto';

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
import { Bm25Ranker, type ChunkRanker } from '../retrieval/rankers.ts';
import { compactText } from '../text/normalize.ts';
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

const scopedKey = (academyId: string, id: string) =>
  JSON.stringify([academyId, id]);
const keyOf = ({
  academyId,
  documentId,
  revision,
}: Pick<StoredDocumentRevision, 'academyId' | 'documentId' | 'revision'>) =>
  JSON.stringify([academyId, documentId, revision]);

function sameSearchScope(a: StoredDocumentRevision, b: StoredDocumentRevision) {
  return (
    a.academyId === b.academyId &&
    a.documentType === b.documentType &&
    a.visibility === b.visibility &&
    a.studentId === b.studentId &&
    a.classId === b.classId &&
    a.validFrom === b.validFrom &&
    a.validTo === b.validTo &&
    JSON.stringify(a.extraction?.pages) === JSON.stringify(b.extraction?.pages)
  );
}

function canReadRevision(
  access: RagAccessScope,
  stored: StoredDocumentRevision,
  known: readonly StoredDocumentRevision[],
  targets: readonly string[],
): boolean {
  // Effective time chooses the content. A published access restriction takes
  // effect at approval, even if that revision's content applies later.
  return (
    canReadRecord(access, stored, targets) &&
    known.every(
      (revision) =>
        revision.revision <= stored.revision ||
        canReadRecord(access, revision, targets),
    )
  );
}

export interface InMemoryRagStoreOptions {
  logger?: RagLogger;
  maxDocumentChars?: number;
  /** 테스트에서 색인 실패를 주입하기 위한 훅 */
  failIndexing?: (document: SourceDocumentInput) => boolean;
  /**
   * 권한 필터를 통과한 후보의 순위 전략(기본: 단어 + 한글 2-gram BM25).
   * Kiwi·임베딩·RRF·재정렬 실험용(retrieval/rankers.ts). 후보 집합(보안 범위)은 바꾸지 않는다.
   */
  ranker?: ChunkRanker;
}

export class InMemoryRagStore implements ApprovedFactsPort, RagDocumentsPort {
  private readonly revisions = new Map<string, StoredDocumentRevision>();
  private readonly activeRevision = new Map<string, number>();
  private readonly revisionBySource = new Map<string, string>();
  private readonly chunks = new Map<string, RagChunk>();
  private readonly factsByRevision = new Map<string, ApprovedFact[]>();
  /** 승인됐지만 아직 색인·검증이 끝나지 않은(또는 실패한) 최신 revision. 이 문서의 이전 revision 은 '현재 값'으로 쓰지 않는다. */
  private readonly pendingApproved = new Map<string, number>();
  private readonly logger: RagLogger | undefined;
  private readonly maxDocumentChars: number;
  private readonly ranker: ChunkRanker;
  private readonly factChunkIndex = new Map<
    string,
    Map<
      string,
      Array<{
        factType: ApprovedFact['factType'];
        subjectType: ApprovedFact['subjectType'];
        subjectId: string;
        period: string | null;
      }>
    >
  >();
  /** revision 키 → 정규화 본문 해시(중복 업로드 감지) */
  private readonly textHashes = new Map<string, string>();
  private readonly failIndexing:
    ((document: SourceDocumentInput) => boolean) | undefined;
  private generation = 0;

  constructor(options: InMemoryRagStoreOptions = {}) {
    this.logger = options.logger;
    this.maxDocumentChars =
      options.maxDocumentChars ?? DEFAULT_RAG_CONFIG.maxDocumentChars;
    this.failIndexing = options.failIndexing;
    this.ranker = options.ranker ?? new Bm25Ranker();
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

    const { academyId, documentId, revision } = document;
    const documentKey = scopedKey(academyId, documentId);
    const key = keyOf(document);
    const sourceId = document.sourceId ?? `${documentId}:r${revision}:body`;
    const sourceKey = scopedKey(academyId, sourceId);
    const owner = this.revisionBySource.get(sourceKey);
    const hash = contentHash(document, facts);
    const approvedAt = parseOptionalInstant(document.approvedAt);
    const existing = this.revisions.get(key);
    const approvalConflict =
      existing?.activatedAt != null &&
      approve &&
      existing.approvedAt !== approvedAt;
    if (
      (owner !== undefined && owner !== key) ||
      (existing && existing.contentHash !== hash) ||
      approvalConflict
    ) {
      this.log('REVISION_CONFLICT', document);
      return {
        ...base,
        status: 'rejected',
        reviewRequired: true,
        errorCode: 'REVISION_CONFLICT',
      };
    }
    if (existing && existing.status === 'index_failed') {
      // 색인 실패한 revision 의 재시도: 이전 시도 흔적을 지우고 다시 색인한다.
      for (const chunkId of existing.chunkIds)
        this.chunks.delete(scopedKey(academyId, chunkId));
      this.factsByRevision.delete(key);
      this.factChunkIndex.delete(key);
      this.revisions.delete(key);
    } else if (existing) {
      if (existing.status === 'deleted' || existing.status === 'revoked') {
        return {
          ...base,
          status: 'rejected',
          reviewRequired: true,
          errorCode: 'STALE_REVISION',
        };
      }
      if (approve && existing.status === 'indexed_verified') {
        return this.activateRevision(
          documentId,
          revision,
          academyId,
          approvedAt,
        );
      }
      return {
        ...base,
        status: 'unchanged',
        reviewRequired: existing.flags.length > 0,
      };
    }

    const active = this.activeRevision.get(documentKey);
    if (active !== undefined && active > revision) {
      this.log('STALE_REVISION', document);
      return {
        ...base,
        status: 'rejected',
        reviewRequired: false,
        errorCode: 'STALE_REVISION',
      };
    }

    if (approve) {
      const pending = this.pendingApproved.get(documentKey) ?? 0;
      if (revision > pending) this.pendingApproved.set(documentKey, revision);
      // A failed approved update can make an earlier revision ineligible.
      this.generation += 1;
    }

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
      approvedAt,
      activatedAt: null,
      sourceId,
      status: 'indexing',
      contentHash: hash,
      flags: [],
      chunkIds: [],
      indexGeneration: this.generation,
      ...(document.extraction ? { extraction: document.extraction } : {}),
    };
    this.revisions.set(key, stored);
    this.revisionBySource.set(sourceKey, key);
    // Preserve paragraph and table boundaries when comparing the contents of two sources.
    const textHash = createHash('sha256')
      .update(document.text.replace(/\r\n?/g, '\n').trim())
      .digest('hex');
    this.textHashes.set(key, textHash);
    const original = [...this.revisions.values()].find(
      (other) =>
        other !== stored &&
        sameSearchScope(other, stored) &&
        other.documentId !== stored.documentId &&
        (other.status === 'approved_active' ||
          other.status === 'indexed_verified') &&
        !other.flags.includes('duplicate_content') &&
        this.textHashes.get(keyOf(other)) === textHash,
    );
    if (original) {
      stored.flags.push('duplicate_content');
      stored.duplicateOf = original.documentId;
    }
    if (document.extraction?.status === 'needs_review')
      stored.flags.push('ocr_needs_review');
    if (document.extraction?.warnings?.some((w) => w.startsWith('pii_masked')))
      stored.flags.push('pii_masked');

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
    for (const chunk of chunks)
      this.chunks.set(scopedKey(academyId, chunk.chunkId), chunk);
    stored.chunkIds = chunks.map((chunk) => chunk.chunkId);
    if (chunks.some((chunk) => chunk.suspicious))
      stored.flags.push('prompt_injection_suspected');

    this.factsByRevision.set(
      key,
      facts.flatMap((fact) => {
        const validFrom = Math.max(
          stored.validFrom,
          parseInstant(fact.validFrom),
        );
        const validTo = Math.min(
          stored.validTo ?? Infinity,
          parseOptionalInstant(fact.validTo) ?? Infinity,
        );
        if (validTo <= validFrom) return [];
        return [
          {
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
            validFrom,
            validTo: Number.isFinite(validTo) ? validTo : null,
            approvalStatus: fact.approvalStatus,
            assignmentIds:
              fact.assignmentIds ??
              fact.assignments?.map((a) => a.assignmentId) ??
              [],
            assignments: fact.assignments ?? [],
            evidence: fact.evidence ?? null,
            classId: stored.classId,
          },
        ];
      }),
    );
    stored.status = 'indexed_verified';

    if (!approve) {
      return {
        ...base,
        status: 'staged',
        reviewRequired: stored.flags.length > 0,
      };
    }
    return this.activateRevision(documentId, revision, academyId);
  }

  private uniqueAcademyForDocument(documentId: string): string | undefined {
    const academyIds = new Set(
      [...this.revisions.values()]
        .filter((stored) => stored.documentId === documentId)
        .map((stored) => stored.academyId),
    );
    return academyIds.size === 1 ? [...academyIds][0] : undefined;
  }

  /** 승인된 revision 을 원자적으로 활성 전환한다. 이전 활성 revision 은 superseded. */
  activateRevision(
    documentId: string,
    revision: number,
    academyId = this.uniqueAcademyForDocument(documentId),
    approvedAt?: number | null,
  ): IndexRevisionResult {
    const base = { documentId, revision };
    const stored = academyId
      ? this.revisions.get(keyOf({ academyId, documentId, revision }))
      : undefined;
    if (!stored || stored.status !== 'indexed_verified') {
      return {
        ...base,
        status: 'rejected',
        reviewRequired: false,
        errorCode: 'NOT_APPROVED',
      };
    }
    const documentKey = scopedKey(stored.academyId, documentId);
    const active = this.activeRevision.get(documentKey);
    if (active !== undefined && active > revision) {
      return {
        ...base,
        status: 'rejected',
        reviewRequired: false,
        errorCode: 'STALE_REVISION',
      };
    }
    if (active !== undefined) {
      const previous = this.revisions.get(
        keyOf({ academyId: stored.academyId, documentId, revision: active }),
      );
      if (previous) previous.status = 'superseded';
    }
    stored.status = 'approved_active';
    if (approvedAt !== undefined) stored.approvedAt = approvedAt;
    // 승인 시각은 자료를 알 수 있는 시점이다. 적용 기간은 조회할 때 별도로 판단한다.
    stored.activatedAt = stored.approvedAt ?? stored.validFrom;
    this.activeRevision.set(documentKey, revision);
    if ((this.pendingApproved.get(documentKey) ?? 0) <= revision)
      this.pendingApproved.delete(documentKey);
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
    academyId?: string;
    documentId: string;
    revision?: number;
    reason: 'deleted' | 'revoked';
  }): Promise<void> {
    const { documentId } = input;
    const academyId =
      input.academyId ?? this.uniqueAcademyForDocument(documentId);
    if (!academyId) return;
    const documentKey = scopedKey(academyId, documentId);
    for (const stored of this.revisions.values()) {
      if (stored.academyId !== academyId || stored.documentId !== documentId)
        continue;
      if (input.revision !== undefined && stored.revision !== input.revision)
        continue;
      stored.status = input.reason;
    }
    // 남아 있는 활성화 이력 중 가장 높은 revision 을 최신으로 다시 계산한다(특정 revision 철회 시 롤백).
    const remaining = [...this.revisions.values()]
      .filter(
        (stored) =>
          stored.academyId === academyId &&
          stored.documentId === documentId &&
          (stored.status === 'approved_active' ||
            stored.status === 'superseded'),
      )
      .map((stored) => stored.revision);
    if (remaining.length > 0)
      this.activeRevision.set(documentKey, Math.max(...remaining));
    else this.activeRevision.delete(documentKey);
    if (
      input.revision === undefined ||
      this.pendingApproved.get(documentKey) === input.revision
    ) {
      this.pendingApproved.delete(documentKey);
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
  hasPendingApprovedRevision(
    documentId: string,
    academyId = this.uniqueAcademyForDocument(documentId),
  ): boolean {
    if (!academyId) return false;
    const documentKey = scopedKey(academyId, documentId);
    const pending = this.pendingApproved.get(documentKey);
    return (
      pending !== undefined &&
      pending > (this.activeRevision.get(documentKey) ?? 0)
    );
  }

  getRevisionStatus(
    documentId: string,
    revision: number,
    academyId = this.uniqueAcademyForDocument(documentId),
  ) {
    return academyId
      ? (this.revisions.get(keyOf({ academyId, documentId, revision }))
          ?.status ?? null)
      : null;
  }

  private knownRevisions(academyId: string, asOf: number) {
    const documents = new Map<string, StoredDocumentRevision[]>();
    for (const stored of this.revisions.values()) {
      if (stored.academyId !== academyId) continue;
      if (stored.status !== 'approved_active' && stored.status !== 'superseded')
        continue;
      if (stored.activatedAt === null || stored.activatedAt > asOf) continue;
      const revisions = documents.get(stored.documentId) ?? [];
      revisions.push(stored);
      documents.set(stored.documentId, revisions);
    }
    for (const revisions of documents.values())
      revisions.sort((a, b) => b.revision - a.revision);
    return documents;
  }

  private applicableRevision(
    revisions: readonly StoredDocumentRevision[],
    asOf: number,
    effectiveAt: number,
  ): StoredDocumentRevision | undefined {
    const selected = revisions.find(
      (stored) => stored.validFrom <= effectiveAt,
    );
    if (!selected) return;
    const { academyId, documentId } = selected;
    const pending = this.pendingApproved.get(scopedKey(academyId, documentId));
    if (pending !== undefined && pending > selected.revision) {
      const update = this.revisions.get(
        keyOf({ academyId, documentId, revision: pending }),
      );
      if (
        update &&
        (update.approvedAt ?? update.validFrom) <= asOf &&
        update.validFrom <= effectiveAt
      )
        return;
    }
    return selected;
  }

  private revisionsStartingIn(
    revisions: readonly StoredDocumentRevision[],
    asOf: number,
    from: number,
    until: number,
  ): StoredDocumentRevision[] {
    return revisions.filter(
      (stored) =>
        stored.validFrom >= from &&
        stored.validFrom < until &&
        this.applicableRevision(revisions, asOf, stored.validFrom) === stored,
    );
  }

  async queryApprovedFacts(query: FactQuery): Promise<ApprovedFact[]> {
    const targets = restrictToAllowedStudents(query.access, query.studentIds);
    const effectiveAt = query.effectiveAt ?? query.asOf;
    const historyAllowed =
      Boolean(query.includeHistory) && query.access.canViewPublicHistory;
    const result: ApprovedFact[] = [];

    const known = this.knownRevisions(query.access.academyId, query.asOf);
    for (const revisions of known.values()) {
      const current = this.applicableRevision(
        revisions,
        query.asOf,
        query.asOf,
      );
      const effective =
        effectiveAt > query.asOf
          ? this.applicableRevision(revisions, query.asOf, effectiveAt)
          : current;
      const selected = new Set([current, effective]);
      if (query.startsIn) {
        for (const upcoming of this.revisionsStartingIn(
          revisions,
          query.asOf,
          Math.max(query.startsIn.from, query.asOf + 1),
          query.startsIn.until,
        ))
          selected.add(upcoming);
      }
      for (const stored of selected) {
        if (!stored) continue;
        if (!canReadRevision(query.access, stored, revisions, targets))
          continue;
        const facts = this.factsByRevision.get(keyOf(stored)) ?? [];
        for (const fact of facts) {
          if (fact.approvalStatus !== 'approved') continue;
          if (fact.academyId !== query.access.academyId) continue;
          if (!query.factTypes.includes(fact.factType)) continue;
          if (fact.subjectType === 'student') {
            if (stored !== current || !targets.includes(fact.subjectId))
              continue;
            // 학습 분석은 "현재 시각에 공개된 revision" 만 사용한다.
            if (!isValidAt(fact.validFrom, fact.validTo, query.asOf)) continue;
          } else {
            if (!query.startsIn && stored !== effective) continue;
            const applies = isValidAt(
              fact.validFrom,
              fact.validTo,
              effectiveAt,
            );
            const past =
              historyAllowed &&
              stored.visibility === 'academy_public' &&
              fact.validTo !== null &&
              fact.validTo <= effectiveAt;
            const startsIn = query.startsIn;
            if (
              startsIn
                ? fact.validFrom < startsIn.from ||
                  fact.validFrom >= startsIn.until
                : !applies && !past
            )
              continue;
          }
          result.push(fact);
        }
      }
    }
    return result.sort((a, b) => a.factId.localeCompare(b.factId));
  }

  async searchApprovedChunks(query: ChunkSearchQuery): Promise<ScoredChunk[]> {
    const generation = this.generation;
    const targets = restrictToAllowedStudents(query.access, query.studentIds);
    const candidates: RagChunk[] = [];
    const known = this.knownRevisions(query.access.academyId, query.asOf);
    const effectiveAt = Math.max(query.asOf, query.effectiveAt ?? query.asOf);
    const eligible = [...known.values()].flatMap((revisions) => {
      const current = this.applicableRevision(
        revisions,
        query.asOf,
        effectiveAt,
      );
      const upcoming =
        effectiveAt === query.asOf && query.upcomingUntil !== undefined
          ? this.revisionsStartingIn(
              revisions,
              query.asOf,
              query.asOf + 1,
              query.upcomingUntil + 1,
            ).filter((stored) => stored.visibility === 'academy_public')
          : [];
      if (current && isValidAt(current.validFrom, current.validTo, effectiveAt))
        upcoming.push(current);
      return upcoming.filter(
        (stored) =>
          canReadRevision(query.access, stored, revisions, targets) &&
          (!query.documentTypes ||
            query.documentTypes.includes(stored.documentType)),
      );
    });
    const eligibleById = new Map(
      eligible.map((stored) => [stored.documentId, stored]),
    );
    for (const stored of eligible) {
      const original = stored.duplicateOf
        ? eligibleById.get(stored.duplicateOf)
        : undefined;
      if (
        original &&
        sameSearchScope(original, stored) &&
        this.textHashes.get(keyOf(original)) ===
          this.textHashes.get(keyOf(stored))
      )
        continue;
      for (const chunkId of stored.chunkIds) {
        const chunk = this.chunks.get(scopedKey(stored.academyId, chunkId));
        if (!chunk) continue;
        if (chunk.suspicious && !query.includeSuspicious) continue;
        candidates.push(chunk);
      }
    }
    const ranked = await this.ranker.rank(candidates, query.query, {
      question: query.question,
      rerank: query.rerank,
    });
    // An asynchronous ranker may return after an approval or withdrawal.
    if (generation !== this.generation) return [];
    return ranked.slice(0, query.limit).map(({ chunk, score, signals }) => ({
      chunk,
      score,
      ...(signals ? { signals } : {}),
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
    locateClassNames?: readonly string[];
  }): Promise<SourceSummary | null> {
    const targets = restrictToAllowedStudents(input.access, input.studentIds);
    const at = input.effectiveAt ?? input.asOf;
    const effectiveAt = Math.max(input.asOf, at);
    for (const revisions of this.knownRevisions(
      input.access.academyId,
      input.asOf,
    ).values()) {
      const stored = this.applicableRevision(
        revisions,
        input.asOf,
        effectiveAt,
      );
      if (!stored) continue;
      if (stored.sourceId !== input.sourceId) continue;
      if (!canReadRevision(input.access, stored, revisions, targets))
        return null;
      const current = isValidAt(stored.validFrom, stored.validTo, at);
      const past =
        Boolean(input.includeHistory) &&
        input.access.canViewPublicHistory &&
        stored.visibility === 'academy_public' &&
        stored.validTo !== null &&
        stored.validTo <= at;
      if (!current && !past) return null;
      if (
        input.locate &&
        (keyOf(input.locate) !== keyOf(stored) ||
          input.locate.sourceId !== stored.sourceId)
      )
        return null;
      const located = input.locate
        ? this.locateFact(input.locate, {
            classNames: input.locateClassNames ?? [],
          })
        : null;
      if (
        input.locate?.value.kind === 'accuracy' &&
        input.locate.value.basis === 'classified_assessed' &&
        !located
      )
        return null;
      let location = located?.location.label;
      if (located && input.locate?.value.kind === 'money') {
        const columns = moneyColumns(located, input.locate.value.amount);
        if (columns.length === 1)
          location += ' · 열 ' + located.location.header?.[columns[0]];
      }
      if (
        located &&
        input.locate?.value.kind === 'enrollment' &&
        input.locateClassNames?.length
      ) {
        const columns = enrollmentColumns(located);
        if (columns)
          location +=
            ' · 열 ' +
            columns.map((index) => located.location.header?.[index]).join(', ');
      }
      return {
        sourceId: stored.sourceId,
        documentId: stored.documentId,
        revision: stored.revision,
        title: stored.title,
        location,
      };
    }
    return null;
  }

  async corpusContains(input: {
    access: RagAccessScope;
    studentIds: readonly string[];
    asOf: number;
    term: string;
  }): Promise<boolean> {
    const needle = input.term.replace(/\s/g, '').toLowerCase();
    if (!needle) return false;
    const targets = restrictToAllowedStudents(input.access, input.studentIds);
    for (const revisions of this.knownRevisions(
      input.access.academyId,
      input.asOf,
    ).values()) {
      const stored = this.applicableRevision(revisions, input.asOf, input.asOf);
      if (!stored || !isValidAt(stored.validFrom, stored.validTo, input.asOf))
        continue;
      if (!canReadRevision(input.access, stored, revisions, targets)) continue;
      for (const chunkId of stored.chunkIds) {
        const chunk = this.chunks.get(scopedKey(stored.academyId, chunkId));
        if (
          chunk &&
          chunk.contextualText.replace(/\s/g, '').toLowerCase().includes(needle)
        )
          return true;
      }
    }
    return false;
  }

  /** 청크 위치에서 확인되는 정형 사실의 종류·대상(값 제외). 같은 revision 의 사실 위치를 한 번만 계산해 둔다. */
  factRefsAtChunk(
    chunkId: string,
    academyId?: string,
  ): Array<{
    factType: ApprovedFact['factType'];
    subjectType: ApprovedFact['subjectType'];
    subjectId: string;
    period: string | null;
  }> {
    const sourceId = chunkId.split('#')[0];
    const matches = academyId
      ? [this.revisionBySource.get(scopedKey(academyId, sourceId))]
      : [...this.revisions.values()]
          .filter((stored) => stored.sourceId === sourceId)
          .map(keyOf);
    const key = matches.length === 1 ? matches[0] : undefined;
    const stored = key ? this.revisions.get(key) : undefined;
    if (
      !key ||
      !stored ||
      (stored.status !== 'approved_active' && stored.status !== 'superseded')
    )
      return [];
    let index = this.factChunkIndex.get(key);
    if (!index) {
      index = new Map();
      for (const fact of this.factsByRevision.get(key) ?? []) {
        const chunk = this.locateFact(fact);
        if (!chunk) continue;
        const list = index.get(chunk.chunkId) ?? [];
        list.push({
          factType: fact.factType,
          subjectType: fact.subjectType,
          subjectId: fact.subjectId,
          period: fact.period,
        });
        index.set(chunk.chunkId, list);
      }
      this.factChunkIndex.set(key, index);
    }
    return index.get(chunkId) ?? [];
  }

  /** 사실 값이 실제로 등장하는 청크 위치(표 행 등)를 찾는다. */
  private locateFact(
    fact: ApprovedFact,
    citation?: { classNames: readonly string[] },
  ): RagChunk | null {
    const stored = this.revisions.get(keyOf(fact));
    if (!stored) return null;
    const chunks = stored.chunkIds
      .map((id) => this.chunks.get(scopedKey(stored.academyId, id)))
      .filter((chunk): chunk is RagChunk => Boolean(chunk));
    if (
      fact.value.kind === 'accuracy' &&
      fact.value.basis === 'classified_assessed'
    ) {
      const value = fact.value;
      const expected = compactText(
        `${value.unit}${value.referenceOnly ? ' (참고용)' : ''}: ${value.total}문항 중 ${value.correct}문항 정답.`,
      );
      const locations = chunks.filter(
        (chunk) =>
          !chunk.suspicious &&
          !chunk.extraction?.needsReview &&
          !chunk.extraction?.uncertainTokens.length &&
          compactText(chunk.text) === expected,
      );
      return locations.length === 1 ? locations[0] : null;
    }
    if (citation && fact.value.kind === 'money') {
      const amount = fact.value.amount;
      const rows = chunks.filter(
        (chunk) => moneyColumns(chunk, amount).length > 0,
      );
      // Same amount in more than one row does not locate the class or period.
      return rows.length === 1 ? rows[0] : null;
    }
    if (citation?.classNames.length && fact.value.kind === 'enrollment') {
      const names = citation.classNames.map(compactText);
      const text = compactText(fact.value.text);
      const rows = chunks.filter((chunk) => {
        const columns = enrollmentColumns(chunk);
        if (!columns || !text) return false;
        const [key, status] = columns;
        const cells = chunk.location.cells ?? [];
        return (
          names.includes(compactText(cells[key] ?? '')) &&
          compactText(cells[status] ?? '') === text
        );
      });
      return rows.length === 1 ? rows[0] : null;
    }
    if (citation && fact.value.kind === 'weak_area') {
      const diagnosis = compactText(fact.value.text);
      const unit = compactText(fact.value.unit);
      const locations =
        unit && diagnosis
          ? chunks.filter(
              (chunk) =>
                !chunk.suspicious &&
                !chunk.extraction?.needsReview &&
                !chunk.extraction?.uncertainTokens.length &&
                matchesWeakArea(chunk, unit, diagnosis),
            )
          : [];
      return locations.length === 1 ? locations[0] : null;
    }
    const needles = factNeedles(fact);
    if (fact.factType === 'teacher' && citation?.classNames.length) {
      const names = citation.classNames.map((name) =>
        name.replace(/\s/g, '').toLowerCase(),
      );
      const rows = chunks.filter(
        (chunk) =>
          !chunk.suspicious &&
          chunk.location.kind === 'table_row' &&
          chunk.location.cells?.some((cell) =>
            names.includes(cell.replace(/\s/g, '').toLowerCase()),
          ) &&
          needles.some((needle) =>
            chunk.text.replace(/\s/g, '').includes(needle),
          ),
      );
      return rows.length === 1 ? rows[0] : null;
    }
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

const WEAK_UNIT_LABEL = /^(?:(?:판정|진단|취약)?(?:단원|영역)|단원명|영역명)$/;
const WEAK_NOTE_LABEL =
  /^(?:판정내용|분석내용|진단내용|진단|관찰내용|관찰|오답내용|취약점|내용)$/;

/** Keep the diagnosed unit and the observation in the same source row or entry. */
function matchesWeakArea(
  chunk: RagChunk,
  unit: string,
  diagnosis: string,
): boolean {
  const { header, cells } = chunk.location;
  if (chunk.location.kind === 'table_row' && header && cells) {
    const labels = header.map(compactText);
    const unitColumn = labels.findIndex((label) => WEAK_UNIT_LABEL.test(label));
    const noteColumn = labels.findIndex((label) => WEAK_NOTE_LABEL.test(label));
    return (
      unitColumn >= 0 &&
      noteColumn >= 0 &&
      compactText(cells[unitColumn] ?? '') === unit &&
      compactText(cells[noteColumn] ?? '').startsWith(diagnosis)
    );
  }

  let labeledUnit = '';
  for (const line of chunk.text.split('\n')) {
    const text = compactText(line.replace(/^\s*[-*•]\s+|\*\*|__/g, ''));
    const key = /^([^:：]+)[:：](.*)$/.exec(text);
    if (!key) continue;
    const [, label, value] = key;
    if (label === unit && value.startsWith(diagnosis)) return true;
    if (WEAK_UNIT_LABEL.test(label)) {
      if (
        [':', '：', '—', '–', '-'].some((separator) =>
          value.startsWith(unit + separator + diagnosis),
        )
      )
        return true;
      const embedded =
        /^(.+?)(판정내용|분석내용|진단내용|관찰내용)[:：](.+)$/.exec(value);
      if (embedded && embedded[1] === unit && embedded[3].startsWith(diagnosis))
        return true;
      labeledUnit = value;
    } else if (
      WEAK_NOTE_LABEL.test(label) &&
      labeledUnit === unit &&
      value.startsWith(diagnosis)
    ) {
      return true;
    } else {
      labeledUnit = '';
    }
  }
  return false;
}

function enrollmentColumns(chunk: RagChunk): [number, number] | undefined {
  if (
    chunk.location.kind !== 'table_row' ||
    chunk.suspicious ||
    chunk.extraction?.needsReview ||
    chunk.extraction?.uncertainTokens.length
  )
    return;
  const header = (chunk.location.header ?? []).map(compactText);
  const key = header.findIndex((label) =>
    /^(?:반|반명|반이름|강좌|강좌명|과정|과정명)$/.test(label),
  );
  const status = header.findIndex((label) =>
    /^(?:모집상태|모집현황|등록상태|등록현황|상태)$/.test(label),
  );
  return key >= 0 && status >= 0 ? [key, status] : undefined;
}

function moneyColumns(chunk: RagChunk, amount: number): number[] {
  if (chunk.location.kind !== 'table_row' || chunk.suspicious) return [];
  return (chunk.location.cells ?? []).flatMap((cell, index) => {
    const amountCell = cell.trim().match(/^(\d[\d,]*)\s*원?$/);
    return index > 0 &&
      amountCell &&
      Number(amountCell[1].replace(/,/g, '')) === amount
      ? [index]
      : [];
  });
}

function factNeedles(fact: ApprovedFact): string[] {
  switch (fact.value.kind) {
    case 'money':
      return [String(fact.value.amount)];
    case 'accuracy':
      return [fact.value.unit, `${fact.value.correct}`];
    case 'schedule_change': {
      const [, month, day] = fact.value.date.split('-').map(Number);
      return [fact.value.date, `${month}월${day}일`];
    }
    case 'weak_area':
      return [fact.value.unit.replace(/\s/g, '')];
    case 'schedule':
    case 'text':
    case 'enrollment':
      return [fact.value.text.replace(/\s/g, '').slice(0, 20)];
    default:
      return [];
  }
}
