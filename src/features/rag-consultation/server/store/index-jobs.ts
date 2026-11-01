/**
 * 색인 작업 큐(Transactional Outbox 의 해커톤용 축소판).
 * - idempotencyKey = documentId:revision:jobType 로 중복 이벤트를 하나로 합친다.
 * - 같은 문서의 낮은 revision 부터 처리하고, 늦게 도착한 낮은 revision 은 저장소가 거부한다.
 * - 실패 시 지수 백오프로 재시도, 최대 횟수 초과 시 dead(운영자 확인 필요).
 * - 새 revision 이 검증되기 전까지 이전 revision 이 활성으로 남지만, 삭제·철회는 즉시 반영된다.
 *
 * 운영 DB 에서는 "문서/채점 변경 + 작업 행"을 같은 트랜잭션으로 저장해야 한다(메모리 구현은 단일 프로세스 가정).
 */
import type {
  Clock,
  IndexRevisionResult,
  RagDocumentsPort,
  RagLogger,
} from '../ports.ts';
import type { ApprovedFactInput, SourceDocumentInput } from '../types.ts';

export type IndexJobStatus =
  | 'pending'
  | 'running'
  | 'activated'
  | 'staged'
  | 'unchanged'
  | 'revoked'
  | 'rejected'
  | 'dead';

export type IndexJobPayload =
  | {
      jobType: 'upsert';
      document: SourceDocumentInput;
      facts: ApprovedFactInput[];
      approve: boolean;
    }
  | {
      jobType: 'revoke';
      academyId: string;
      documentId: string;
      revision?: number;
      reason: 'deleted' | 'revoked';
    };

export interface IndexJob {
  jobId: string;
  idempotencyKey: string;
  academyId: string;
  documentId: string;
  revision: number | null;
  jobType: IndexJobPayload['jobType'];
  status: IndexJobStatus;
  attempts: number;
  nextAttemptAt: number;
  errorCode?: IndexRevisionResult['errorCode'] | 'EXCEPTION';
  reviewRequired: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface IndexJobQueueOptions {
  documents: RagDocumentsPort;
  clock: Clock;
  logger?: RagLogger;
  maxAttempts?: number;
  baseBackoffMs?: number;
  createJobId?: () => string;
}

export class IndexJobQueue {
  private readonly jobs = new Map<string, IndexJob>();
  private readonly payloads = new Map<string, IndexJobPayload>();
  private readonly byKey = new Map<string, string>();
  private readonly documents: RagDocumentsPort;
  private readonly clock: Clock;
  private readonly logger: RagLogger | undefined;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly createJobId: () => string;
  private running: Promise<void> | null = null;

  constructor(options: IndexJobQueueOptions) {
    this.documents = options.documents;
    this.clock = options.clock;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.createJobId =
      options.createJobId ?? (() => globalThis.crypto.randomUUID());
  }

  enqueue(payload: IndexJobPayload): IndexJob {
    const documentId =
      payload.jobType === 'upsert'
        ? payload.document.documentId
        : payload.documentId;
    const revision =
      payload.jobType === 'upsert'
        ? payload.document.revision
        : (payload.revision ?? null);
    const academyId =
      payload.jobType === 'upsert'
        ? payload.document.academyId
        : payload.academyId;
    const idempotencyKey = `${documentId}:${revision ?? 'all'}:${payload.jobType}`;
    const existingId = this.byKey.get(idempotencyKey);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      // 실패로 끝난 작업만 같은 키로 다시 받는다. 진행/성공 작업은 그대로 반환(중복 이벤트 무시).
      if (
        existing &&
        existing.status !== 'dead' &&
        existing.status !== 'rejected'
      )
        return { ...existing };
    }
    const now = this.clock.now();
    const job: IndexJob = {
      jobId: this.createJobId(),
      idempotencyKey,
      academyId,
      documentId,
      revision,
      jobType: payload.jobType,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      reviewRequired: false,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.jobId, job);
    this.payloads.set(job.jobId, payload);
    this.byKey.set(idempotencyKey, job.jobId);
    return { ...job };
  }

  getJob(jobId: string): IndexJob | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /** 대기 중인 작업을 처리한다. 동시에 여러 번 호출돼도 한 번에 하나만 실행한다. */
  async runPending(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    const now = this.clock.now();
    const ready = [...this.jobs.values()]
      .filter((job) => job.status === 'pending' && job.nextAttemptAt <= now)
      .sort(
        (a, b) =>
          a.documentId.localeCompare(b.documentId) ||
          (a.revision ?? Number.MAX_SAFE_INTEGER) -
            (b.revision ?? Number.MAX_SAFE_INTEGER) ||
          a.createdAt - b.createdAt,
      );
    for (const job of ready) {
      await this.process(job);
    }
  }

  private async process(job: IndexJob): Promise<void> {
    const payload = this.payloads.get(job.jobId);
    if (!payload) return;
    job.status = 'running';
    job.attempts += 1;
    job.updatedAt = this.clock.now();
    try {
      if (payload.jobType === 'revoke') {
        await this.documents.revokeRevision({
          documentId: payload.documentId,
          revision: payload.revision,
          reason: payload.reason,
        });
        job.status = 'revoked';
      } else {
        const result = await this.documents.upsertIndexedRevision({
          document: payload.document,
          facts: payload.facts,
          approve: payload.approve,
        });
        job.reviewRequired = result.reviewRequired;
        job.errorCode = result.errorCode;
        if (result.status === 'failed') {
          this.scheduleRetry(job);
        } else {
          job.status = result.status;
        }
      }
    } catch {
      job.errorCode = 'EXCEPTION';
      this.scheduleRetry(job);
    }
    job.updatedAt = this.clock.now();
    this.logger?.log({
      event: 'rag.index',
      status: job.status,
      errorType: job.errorCode,
      documentId: job.documentId,
      revision: job.revision ?? undefined,
    });
  }

  private scheduleRetry(job: IndexJob) {
    if (job.attempts >= this.maxAttempts) {
      job.status = 'dead';
      return;
    }
    job.status = 'pending';
    job.nextAttemptAt =
      this.clock.now() + this.baseBackoffMs * 2 ** (job.attempts - 1);
  }
}
