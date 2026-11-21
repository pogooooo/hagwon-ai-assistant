import { createHash, randomUUID } from 'node:crypto';
import {
  accessibleClasses,
  canReadStudent,
} from '../academy-operations/directory.ts';
import {
  one,
  rows,
  transaction,
  type PageContext,
} from '../academy-operations/shared.ts';
import type { OperationsDatabase } from '../academy-operations/database.ts';
import {
  GradingError,
  kstDate,
  readingSchema,
  parse,
  type Assignment,
  type Draft,
  type DraftItem,
  type PhotoSolution,
  type Reading,
  type Result,
} from './contracts.ts';
import {
  aggregate,
  normalizeNumericReading,
  emptyResult,
  propose,
  validateAssignment,
  validateRetained,
} from './scoring.ts';
import { MemoryRawStore, type RawStore } from './raw-store.ts';
import {
  cropAnswer,
  decodeUploads,
  maskStudentAnswers,
  type ImagePage,
} from './media.ts';
import type { GradeProvider } from './provider.ts';
import { comparePhotoAnswer } from './photo-solution.ts';

export const newId = (prefix: string) =>
  prefix + '_' + randomUUID().replaceAll('-', '');
export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export const gradingProviderErrors: Record<string, string> = {
  PROVIDER_AUTHENTICATION_FAILED:
    '네이버가 이 배포의 API 키 또는 접근 권한을 거부했습니다.',
  PROVIDER_RATE_LIMIT:
    '네이버 호출 한도 또는 서비스의 일일 AI 한도에 도달했습니다.',
  PROVIDER_INPUT_NOT_APPROVED:
    '이 제출은 네이버 전송 승인이 설정되지 않았습니다.',
  PROVIDER_REQUEST_REJECTED: '네이버가 사진 채점 요청의 형식을 거부했습니다.',
  PROVIDER_INVALID_OUTPUT:
    'AI 응답에서 문항 번호와 판독 결과를 확인할 수 없습니다.',
  PROVIDER_TEMPORARY_FAILURE:
    '네이버와의 연결이 중단됐거나 응답을 받을 수 없었습니다.',
  PROVIDER_UNAVAILABLE: 'AI 호출을 완료하지 못했습니다.',
};
function providerIssue(error: unknown) {
  return error instanceof GradingError &&
    Object.hasOwn(gradingProviderErrors, error.code)
    ? error.code
    : 'PROVIDER_UNAVAILABLE';
}
export interface Submission {
  id: string;
  tenant: string;
  student: string;
  assignment: string;
  assignment_version: number;
  purpose: 'assessment' | 'correction_evidence';
  target: string | null;
  target_revision: number | null;
  attempt_no: number | null;
  uploaded: number;
  submitted_at: string;
  assessment_date: string;
  date_source: 'teacher_reported' | 'submitted_date';
  expected_pages: number;
  scope: string;
  generation: number;
  fence: number;
  runtime_epoch: string;
  inflight: number;
  expires_at: number;
  processing: string;
  raw_state: string;
  draft_revision: number;
  result_id: string | null;
  current_revision: number | null;
  published_revision: number | null;
  error_code: string | null;
}
export interface Receipt {
  receipt_id: string;
  raw_scope_id: string;
  generation: number;
  status: 'VERIFIED';
  scope_version: string;
  verified_at: string;
  listed_object_count: number;
  remaining_object_count: 0;
  remaining_multipart_count: 0;
  stores_checked: string[];
  provider_retention_policy_ref: string;
}
type Options = {
  provider: GradeProvider;
  practiceProvider?: GradeProvider;
  rawStore?: RawStore;
  now?: () => number;
  rawTtlMs?: number;
  detailPolicy?: Result['analysis_detail_policy'];
  inputPolicyRef?: string;
  restoredBackup?: boolean;
};
const activeStores = new WeakMap<OperationsDatabase, RawStore>();
export function setupGrading(db: OperationsDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grading_v3_assignments(tenant TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tenant,id,version));
    CREATE TABLE IF NOT EXISTS grading_v3_submissions(
      id TEXT PRIMARY KEY,tenant TEXT NOT NULL,student TEXT NOT NULL,assignment TEXT NOT NULL,assignment_version INTEGER NOT NULL,
      purpose TEXT NOT NULL,target TEXT,target_revision INTEGER,attempt_no INTEGER,uploaded INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL,assessment_date TEXT NOT NULL,date_source TEXT NOT NULL,expected_pages INTEGER NOT NULL,
      scope TEXT NOT NULL UNIQUE,generation INTEGER NOT NULL DEFAULT 1,fence INTEGER NOT NULL DEFAULT 1,runtime_epoch TEXT NOT NULL,inflight INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,processing TEXT NOT NULL,raw_state TEXT NOT NULL,draft_revision INTEGER NOT NULL DEFAULT 0,
      result_id TEXT,current_revision INTEGER,published_revision INTEGER,error_code TEXT,
      UNIQUE(tenant,student,assignment,assignment_version,attempt_no),
      FOREIGN KEY(tenant,assignment,assignment_version) REFERENCES grading_v3_assignments(tenant,id,version));
    CREATE TABLE IF NOT EXISTS grading_v3_results(tenant TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,submission TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tenant,id,revision),FOREIGN KEY(submission) REFERENCES grading_v3_submissions(id));
    CREATE TABLE IF NOT EXISTS grading_v3_jobs(id TEXT PRIMARY KEY,submission TEXT NOT NULL UNIQUE,status TEXT NOT NULL,tries INTEGER NOT NULL DEFAULT 0,last_error TEXT);
    CREATE TABLE IF NOT EXISTS grading_v3_practice_consent(submission TEXT PRIMARY KEY REFERENCES grading_v3_submissions(id), actor TEXT NOT NULL, policy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grading_v3_receipts(tenant TEXT NOT NULL,scope TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(tenant,scope,generation));
    CREATE TABLE IF NOT EXISTS grading_v3_generations(tenant TEXT NOT NULL,student TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(tenant,student));
    CREATE TABLE IF NOT EXISTS grading_v3_snapshots(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,student TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grading_v3_reports(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,student TEXT NOT NULL,revision INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS grading_v3_idempotency(tenant TEXT NOT NULL,actor TEXT NOT NULL,endpoint TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(tenant,actor,endpoint,key));
    CREATE INDEX IF NOT EXISTS grading_v3_attempts ON grading_v3_submissions(tenant,student,assignment,assignment_version,attempt_no);
  `);
}
export function requireStaff(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (!['teacher', 'admin'].includes(ctx.actor.role))
    throw new GradingError('FORBIDDEN', 403);
}
export function requireStudent(ctx: PageContext, student: string) {
  ctx.assertCurrentAccess?.();
  if (!canReadStudent(ctx.db, ctx.actor, student))
    throw new GradingError('RESOURCE_NOT_FOUND', 404);
}
export function sourceGeneration(
  db: OperationsDatabase,
  tenant: string,
  student: string,
) {
  return (
    one<{ generation: number }>(
      db,
      'SELECT generation FROM grading_v3_generations WHERE tenant=? AND student=?',
      tenant,
      student,
    )?.generation ?? 0
  );
}
export function invalidate(
  db: OperationsDatabase,
  tenant: string,
  student: string,
) {
  db.prepare(
    'INSERT INTO grading_v3_generations VALUES(?,?,1) ON CONFLICT(tenant,student) DO UPDATE SET generation=generation+1',
  ).run(tenant, student);
  db.prepare(
    "UPDATE grading_v3_reports SET status='stale' WHERE tenant=? AND student=?",
  ).run(tenant, student);
}
export function assignmentFor(
  db: OperationsDatabase,
  tenant: string,
  id: string,
  version: number,
): Assignment {
  const row = one<{ payload: string }>(
    db,
    'SELECT payload FROM grading_v3_assignments WHERE tenant=? AND id=? AND version=?',
    tenant,
    id,
    version,
  );
  if (!row) throw new GradingError('RESOURCE_NOT_FOUND', 404);
  return JSON.parse(row.payload) as Assignment;
}
export function listAssignments(ctx: PageContext) {
  const classes = new Set(
    accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
  );
  return rows<{ payload: string }>(
    ctx.db,
    'SELECT payload FROM grading_v3_assignments WHERE tenant=? ORDER BY rowid DESC',
    ctx.actor.academyId,
  )
    .map((r) => JSON.parse(r.payload) as Assignment)
    .filter((a) => classes.has(a.class_id));
}
export function readSubmission(
  ctx: PageContext,
  id: string,
  staff = false,
): Submission {
  if (staff) requireStaff(ctx);
  const s = one<Submission>(
    ctx.db,
    'SELECT * FROM grading_v3_submissions WHERE id=? AND tenant=?',
    id,
    ctx.actor.academyId,
  );
  if (!s) throw new GradingError('RESOURCE_NOT_FOUND', 404);
  requireStudent(ctx, s.student);
  if (
    ['teacher', 'admin'].includes(ctx.actor.role) &&
    !accessibleClasses(ctx.db, ctx.actor).some(
      (c) =>
        c.id ===
        assignmentFor(ctx.db, s.tenant, s.assignment, s.assignment_version)
          .class_id,
    )
  )
    throw new GradingError('RESOURCE_NOT_FOUND', 404);
  return s;
}
/** Strictly minimal results only. Neither idempotency records nor audit metadata contain drafts. */
export function idempotent<T>(
  ctx: PageContext,
  endpoint: string,
  key: string,
  body: unknown,
  write: () => T,
): T {
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(key))
    throw new GradingError('IDEMPOTENCY_KEY_REQUIRED');
  const hash = digest(body);
  return transaction(ctx.db, () => {
    const old = one<{ digest: string; response: string }>(
      ctx.db,
      'SELECT digest,response FROM grading_v3_idempotency WHERE tenant=? AND actor=? AND endpoint=? AND key=?',
      ctx.actor.academyId,
      ctx.actor.id,
      endpoint,
      key,
    );
    if (old) {
      if (old.digest !== hash)
        throw new GradingError('IDEMPOTENCY_CONFLICT', 409);
      return JSON.parse(old.response) as T;
    }
    const result = write();
    ctx.db
      .prepare('INSERT INTO grading_v3_idempotency VALUES(?,?,?,?,?,?)')
      .run(
        ctx.actor.academyId,
        ctx.actor.id,
        endpoint,
        key,
        hash,
        JSON.stringify(result),
      );
    return result;
  });
}

export class GradingService {
  readonly db: OperationsDatabase;
  readonly raw: RawStore;
  readonly provider: GradeProvider;
  private readonly practiceProvider?: GradeProvider;
  readonly now: () => number;
  readonly ttl: number;
  readonly policy: Result['analysis_detail_policy'];
  readonly epoch = newId('runtime');
  readonly policyRef: string;
  constructor(db: OperationsDatabase, options: Options) {
    this.db = db;
    setupGrading(db);
    const previousStore = activeStores.get(db);
    if (
      previousStore &&
      one<{ n: number }>(
        db,
        'SELECT COUNT(*) n FROM grading_v3_submissions WHERE inflight>0',
      )?.n
    )
      throw new GradingError('RUNTIME_RECOVERY_BUSY', 409);
    if (previousStore && options.rawStore && previousStore !== options.rawStore)
      throw new GradingError('RAW_STORE_REPLACEMENT_REQUIRES_RESTART', 409);
    this.raw = options.rawStore ?? previousStore ?? new MemoryRawStore();
    activeStores.set(db, this.raw);
    this.provider = options.provider;
    this.practiceProvider = options.practiceProvider;
    this.now = options.now ?? Date.now;
    this.ttl = options.rawTtlMs ?? 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.ttl) ||
      this.ttl < 1000 ||
      this.ttl > 24 * 60 * 60 * 1000
    )
      throw new GradingError('INVALID_RETENTION_CONFIG');
    this.policy = options.detailPolicy ?? 'none';
    this.policyRef = options.inputPolicyRef ?? 'unverified-provider-policy';
    // A volatile store cannot recover drafts across restart. Never reopen an old raw scope.
    transaction(db, () => {
      for (const s of rows<Submission>(
        db,
        "SELECT * FROM grading_v3_submissions WHERE raw_state<>'VERIFIED'",
      )) {
        db.prepare(
          "UPDATE grading_v3_submissions SET processing=CASE WHEN processing='CONFIRMED' THEN processing ELSE 'EXPIRED' END,raw_state='CLOSING',fence=fence+1,runtime_epoch=?,inflight=0 WHERE id=?",
        ).run(this.epoch, s.id);
        this.enqueue(s.id);
        invalidate(db, s.tenant, s.student);
      }
      // Open drafts above invalidate their student's generation. An ordinary
      // restart leaves already-verified results and their approved reports intact.
      if (options.restoredBackup) {
        db.prepare(
          "UPDATE grading_v3_reports SET status='stale' WHERE status='approved'",
        ).run();
        for (const s of rows<Submission>(
          db,
          'SELECT * FROM grading_v3_submissions WHERE published_revision IS NOT NULL',
        )) {
          db.prepare(
            'UPDATE grading_v3_submissions SET published_revision=NULL WHERE id=?',
          ).run(s.id);
          invalidate(db, s.tenant, s.student);
        }
      }
    });
  }
  allowsPersonalPractice(ctx: PageContext) {
    return (
      !!this.practiceProvider?.inputAllowed &&
      ctx.actor.academyId === 'AC_TEST_A' &&
      ['TA_DIRECTOR', 'TA_TEACHER', 'TA_STUDENT_001'].includes(ctx.actor.id)
    );
  }
  register(ctx: PageContext, input: unknown, key: string) {
    requireStaff(ctx);
    const definition = validateAssignment(input);
    if (
      !accessibleClasses(this.db, ctx.actor).some(
        (c) => c.id === definition.class_id,
      )
    )
      throw new GradingError('FORBIDDEN', 403);
    return idempotent(ctx, 'assignment', key, definition, () => {
      const a: Assignment = {
        ...definition,
        assignment_id: newId('assignment'),
        assignment_version: 1,
        tenant_id: ctx.actor.academyId,
        approved_by: ctx.actor.id,
        approved_at: new Date(this.now()).toISOString(),
      };
      this.db
        .prepare('INSERT INTO grading_v3_assignments VALUES(?,?,?,?)')
        .run(a.tenant_id, a.assignment_id, 1, JSON.stringify(a));
      return { assignment_id: a.assignment_id, assignment_version: 1 };
    });
  }
  create(
    ctx: PageContext,
    input: {
      assignment_id: string;
      assignment_version: number;
      student_ref: string;
      expected_page_count: number;
      practice_consent?: boolean;
      assessment_date?: string;
      submission_purpose?: 'assessment' | 'correction_evidence';
      target_result_set_id?: string;
      target_result_revision?: number;
    },
    key: string,
  ) {
    const student =
      ctx.actor.role === 'student' ? ctx.actor.studentId : input.student_ref;
    if (!student) throw new GradingError('FORBIDDEN', 403);
    requireStudent(ctx, student);
    const a = assignmentFor(
      this.db,
      ctx.actor.academyId,
      input.assignment_id,
      input.assignment_version,
    );
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM student_class_memberships WHERE academy_id=? AND student_id=? AND class_id=? AND ended_at IS NULL',
        )
        .get(ctx.actor.academyId, student, a.class_id)
    )
      throw new GradingError('FORBIDDEN', 403);
    if (
      !Number.isSafeInteger(input.expected_page_count) ||
      input.expected_page_count < 1 ||
      input.expected_page_count > 10 ||
      Math.max(...a.items.map((i) => i.expected_page_no)) >
        input.expected_page_count
    )
      throw new GradingError('PAGE_COUNT_MISMATCH');
    if (input.assessment_date && !['teacher', 'admin'].includes(ctx.actor.role))
      throw new GradingError('FORBIDDEN', 403);
    if (
      input.practice_consent &&
      !(
        this.allowsPersonalPractice(ctx) &&
        student === 'TA_STU_001' &&
        !input.submission_purpose &&
        a.items.every(
          (i) =>
            i.grading_mode === 'photo_solution' &&
            !i.key &&
            /^\d{1,3}$/.test(i.item_no),
        )
      )
    )
      throw new GradingError('PRACTICE_SCOPE', 403);
    if (
      input.assessment_date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(input.assessment_date) ||
        Number.isNaN(Date.parse(input.assessment_date + 'T00:00:00Z')) ||
        new Date(input.assessment_date + 'T00:00:00Z')
          .toISOString()
          .slice(0, 10) !== input.assessment_date)
    )
      throw new GradingError('INVALID_DATE');
    if (input.submission_purpose === 'correction_evidence') {
      requireStaff(ctx);
      const target = this.result(
        ctx,
        input.target_result_set_id ?? '',
        input.target_result_revision,
      );
      if (
        target.student_ref !== student ||
        target.assignment_id !== a.assignment_id ||
        target.assignment_version !== a.assignment_version ||
        target.revision !== input.target_result_revision
      )
        throw new GradingError('EVIDENCE_REFERENCE_MISMATCH');
    } else if (input.target_result_set_id || input.target_result_revision)
      throw new GradingError('EVIDENCE_REFERENCE_MISMATCH');
    if (
      ['teacher', 'admin'].includes(ctx.actor.role) &&
      !accessibleClasses(this.db, ctx.actor).some((c) => c.id === a.class_id)
    )
      throw new GradingError('FORBIDDEN', 403);
    return idempotent(
      ctx,
      'submission',
      key,
      { ...input, student_ref: student },
      () => {
        const id = newId('submission'),
          scope = newId('raw');
        const at = new Date(this.now()).toISOString();
        this.db
          .prepare(
            `INSERT INTO grading_v3_submissions(id,tenant,student,assignment,assignment_version,purpose,target,target_revision,submitted_at,assessment_date,date_source,expected_pages,scope,runtime_epoch,expires_at,processing,raw_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'RECEIVED','OPEN')`,
          )
          .run(
            id,
            ctx.actor.academyId,
            student,
            a.assignment_id,
            a.assignment_version,
            input.submission_purpose ?? 'assessment',
            input.target_result_set_id ?? null,
            input.target_result_revision ?? null,
            at,
            input.assessment_date ?? kstDate(this.now()),
            input.assessment_date ? 'teacher_reported' : 'submitted_date',
            input.expected_page_count,
            scope,
            this.epoch,
            this.now() + this.ttl,
          );
        if (input.practice_consent)
          this.db
            .prepare('INSERT INTO grading_v3_practice_consent VALUES(?,?,?)')
            .run(id, ctx.actor.id, 'self-practice-deidentified-v1');
        return {
          submission_id: id,
          raw_scope_id: scope,
          generation: 1,
          raw_expires_at: this.now() + this.ttl,
        };
      },
    );
  }
  private current(id: string) {
    const s = one<Submission>(
      this.db,
      'SELECT * FROM grading_v3_submissions WHERE id=?',
      id,
    );
    if (!s) throw new GradingError('RESOURCE_NOT_FOUND', 404);
    return s;
  }
  private open(s: Submission) {
    if (s.raw_state !== 'OPEN' || s.runtime_epoch !== this.epoch)
      throw new GradingError('RAW_CLOSED', 410);
    if (s.expires_at <= this.now()) throw new GradingError('RAW_EXPIRED', 410);
  }
  private async lease<T>(
    id: string,
    work: (s: Submission) => Promise<T>,
  ): Promise<T> {
    const s = this.current(id);
    this.open(s);
    this.db
      .prepare(
        'UPDATE grading_v3_submissions SET inflight=inflight+1 WHERE id=?',
      )
      .run(id);
    try {
      const value = await work(s);
      const live = this.current(id);
      this.open(live);
      if (live.fence !== s.fence) throw new GradingError('RAW_CLOSED', 410);
      return value;
    } finally {
      this.db
        .prepare(
          'UPDATE grading_v3_submissions SET inflight=MAX(0,inflight-1) WHERE id=? AND runtime_epoch=?',
        )
        .run(id, this.epoch);
    }
  }
  private async write(
    s: Submission,
    key: string,
    bytes: Uint8Array,
    mime: string,
  ) {
    const live = this.current(s.id);
    this.open(live);
    if (live.fence !== s.fence) throw new GradingError('RAW_CLOSED', 410);
    await this.raw.put(s.scope, { key, bytes, mime });
    const after = this.current(s.id);
    if (
      after.raw_state !== 'OPEN' ||
      after.fence !== s.fence ||
      after.expires_at <= this.now()
    ) {
      await this.raw.delete(s.scope, key);
      throw new GradingError('RAW_CLOSED', 410);
    }
  }
  async upload(
    ctx: PageContext,
    id: string,
    files: { bytes: Uint8Array; mime: string }[],
    maxBytes?: number,
  ) {
    const current = readSubmission(ctx, id);
    if (current.uploaded || current.processing !== 'RECEIVED')
      throw new GradingError('STATE_CONFLICT', 409);
    this.open(current);
    if (
      !this.db
        .prepare(
          "UPDATE grading_v3_submissions SET processing='UPLOADING' WHERE id=? AND processing='RECEIVED' AND raw_state='OPEN'",
        )
        .run(id).changes
    )
      throw new GradingError('STATE_CONFLICT', 409);
    try {
      await this.lease(id, async (s) => {
        const pages = await decodeUploads(files, maxBytes);
        try {
          if (pages.length !== s.expected_pages)
            throw new GradingError('PAGE_COUNT_MISMATCH');
          for (let n = 0; n < files.length; n++)
            await this.write(s, 'original_' + n, files[n].bytes, files[n].mime);
          for (const page of pages)
            await this.write(s, 'page_' + page.page_no, page.bytes, page.mime);
          ctx.assertCurrentAccess?.();
          readSubmission(ctx, id);
          transaction(this.db, () => {
            this.open(this.current(id));
            const attempt =
              s.purpose === 'assessment'
                ? (one<{ n: number }>(
                    this.db,
                    'SELECT COALESCE(MAX(attempt_no),0)+1 n FROM grading_v3_submissions WHERE tenant=? AND student=? AND assignment=? AND assignment_version=?',
                    s.tenant,
                    s.student,
                    s.assignment,
                    s.assignment_version,
                  )?.n ?? 1)
                : null;
            if (
              !this.db
                .prepare(
                  "UPDATE grading_v3_submissions SET uploaded=1,attempt_no=?,processing='PROCESSING' WHERE id=? AND uploaded=0 AND raw_state='OPEN'",
                )
                .run(attempt, id).changes
            )
              throw new GradingError('STATE_CONFLICT', 409);
            if (s.purpose === 'assessment')
              invalidate(this.db, s.tenant, s.student);
          });
        } finally {
          for (const page of pages) page.bytes.fill(0);
        }
      });
    } catch (error) {
      this.db
        .prepare(
          "UPDATE grading_v3_submissions SET processing='RECEIVED' WHERE id=? AND processing='UPLOADING' AND raw_state='OPEN' AND uploaded=0",
        )
        .run(id);
      throw error;
    }
  }
  async process(ctx: PageContext, id: string) {
    const before = readSubmission(ctx, id);
    if (before.processing !== 'PROCESSING' || before.inflight)
      throw new GradingError('STATE_CONFLICT', 409);
    try {
      await this.lease(id, async (s) => {
        const a = assignmentFor(
          this.db,
          s.tenant,
          s.assignment,
          s.assignment_version,
        );
        const pages: ImagePage[] = [];
        for (let n = 1; n <= s.expected_pages; n++) {
          const p = await this.raw.get(s.scope, 'page_' + n);
          if (!p) throw new GradingError('RAW_EXPIRED', 410);
          pages.push({ bytes: p.bytes, mime: p.mime, page_no: n });
        }
        let readings: Reading[] = [];
        const practice = this.db
          .prepare(
            'SELECT actor FROM grading_v3_practice_consent WHERE submission=? AND policy=?',
          )
          .get(id, 'self-practice-deidentified-v1');
        if (
          practice &&
          (practice.actor !== ctx.actor.id || !this.allowsPersonalPractice(ctx))
        )
          throw new GradingError('PRACTICE_SCOPE', 403);
        const provider = practice ? this.practiceProvider! : this.provider;
        let unavailable: string | undefined;
        try {
          readings = await provider.read(pages, a);
        } catch (error) {
          unavailable = providerIssue(error);
        }
        try {
          readSubmission(ctx, id);
          this.open(this.current(id));
          const verified = new Map<number, Reading[]>();
          if (!unavailable && provider.verifyPage) {
            for (const page of pages) {
              readSubmission(ctx, id);
              this.open(this.current(id));
              try {
                verified.set(page.page_no, await provider.verifyPage(page, a));
              } catch {
                verified.set(page.page_no, []);
              }
            }
          }
          const items: DraftItem[] = [];
          const solutions = new Map<string, PhotoSolution>();
          const failedSolves = new Set<string>();
          for (const page of pages) {
            const defs = a.items.filter(
              (i) =>
                i.grading_mode === 'photo_solution' &&
                i.expected_page_no === page.page_no &&
                i.approval_status === 'approved',
            );
            if (!defs.length || unavailable) continue;
            const blind = await maskStudentAnswers(page, [
              ...readings,
              ...(verified.get(page.page_no) ?? []),
            ]).catch(() => null);
            if (!blind) continue;
            try {
              // Limit completion size and isolate a failed group from the rest of the submission.
              for (let offset = 0; offset < defs.length; offset += 6) {
                const group = defs.slice(offset, offset + 6);
                readSubmission(ctx, id);
                this.open(this.current(id));
                try {
                  if (!provider.solvePage)
                    throw new GradingError('PROVIDER_UNAVAILABLE');
                  for (const [ref, solution] of await provider.solvePage(
                    blind,
                    group,
                  )) {
                    if (group.some((d) => d.item_ref === ref))
                      solutions.set(ref, solution);
                  }
                } catch {
                  for (const def of group) failedSolves.add(def.item_ref);
                }
              }
            } finally {
              blind.bytes.fill(0);
            }
          }
          for (const item of a.items) {
            readSubmission(ctx, id);
            this.open(this.current(id));
            const candidates = readings.filter(
              (r) => r.item_ref === item.item_ref,
            );
            let r: Reading = {
              item_ref: item.item_ref,
              answer_observed: '',
              unit_observed: '',
              answer_status: 'unreadable',
              association_status: 'missing',
              regions: [],
              ambiguity_codes: ['MISSING_REGION'],
            };
            if (candidates.length === 1) {
              const parsed = readingSchema.safeParse(candidates[0]);
              if (
                parsed.success &&
                parsed.data.regions.every(
                  (region) =>
                    region.page_no === item.expected_page_no &&
                    region.page_no <= s.expected_pages,
                )
              )
                r = normalizeNumericReading(item, parsed.data);
            }
            if (
              candidates.length > 1 ||
              readings.some(
                (x) => !a.items.some((i) => i.item_ref === x.item_ref),
              )
            )
              r.ambiguity_codes = ['ASSOCIATION_AMBIGUOUS'];
            if (
              provider.verifyPage &&
              ['readable', 'blank'].includes(r.answer_status) &&
              r.association_status === 'matched'
            ) {
              const second = (verified.get(item.expected_page_no) ?? []).filter(
                (v) => v.item_ref === item.item_ref,
              );
              const checked = readingSchema.safeParse(second[0]);
              const check = checked.success
                ? normalizeNumericReading(item, checked.data)
                : undefined;
              if (
                second.length !== 1 ||
                !check ||
                check.association_status !== 'matched' ||
                check.ambiguity_codes.length ||
                check.regions.some(
                  (region) => region.page_no !== item.expected_page_no,
                ) ||
                check.answer_status !== r.answer_status ||
                check.answer_observed.normalize('NFC').trim() !==
                  r.answer_observed.normalize('NFC').trim() ||
                check.unit_observed !== r.unit_observed
              )
                r = {
                  ...r,
                  answer_status: 'ambiguous',
                  ambiguity_codes: [...r.ambiguity_codes, 'MODEL_DISAGREEMENT'],
                };
            } else if (
              r.answer_status === 'readable' &&
              r.association_status === 'matched' &&
              provider.check
            ) {
              const page = pages.find(
                (p) => p.page_no === item.expected_page_no,
              )!;
              const crop = await cropAnswer(page, r).catch((error) => {
                if (
                  error instanceof GradingError &&
                  error.code === 'MEDIA_BUSY'
                )
                  return null;
                throw error;
              });
              if (crop) {
                try {
                  const check = await provider.check(crop, item);
                  if (
                    check.answer_status !== r.answer_status ||
                    check.answer_observed.normalize('NFC').trim() !==
                      r.answer_observed.normalize('NFC').trim() ||
                    check.unit_observed !== r.unit_observed
                  )
                    r = {
                      ...r,
                      ambiguity_codes: [
                        ...r.ambiguity_codes,
                        'MODEL_DISAGREEMENT',
                      ],
                      answer_status: 'ambiguous',
                    };
                } catch {
                  r = {
                    ...r,
                    ambiguity_codes: [
                      ...r.ambiguity_codes,
                      'MODEL_DISAGREEMENT',
                    ],
                    answer_status: 'ambiguous',
                  };
                } finally {
                  crop.bytes.fill(0);
                }
              } else
                r = {
                  ...r,
                  ambiguity_codes: [...r.ambiguity_codes, 'MISSING_REGION'],
                };
            }
            let proposed =
              unavailable ||
              r.ambiguity_codes.some((code) => code.startsWith('PROVIDER_'))
                ? emptyResult(item, 'PROVIDER_UNAVAILABLE')
                : propose(item, r);
            if (
              ['text_semantic', 'structured_work', 'essay'].includes(
                item.answer_type,
              ) &&
              r.answer_status === 'readable' &&
              r.association_status === 'matched' &&
              !r.ambiguity_codes.length &&
              item.approval_status === 'approved' &&
              item.key?.approval_status === 'approved' &&
              provider.semantic
            ) {
              readSubmission(ctx, id);
              this.open(this.current(id));
              try {
                proposed = aggregate(item, await provider.semantic(item, r));
              } catch {
                proposed = emptyResult(item, 'UNSUPPORTED');
              }
            }
            if (item.grading_mode === 'photo_solution') {
              const solution = solutions.get(item.item_ref);
              if (
                unavailable ||
                failedSolves.has(item.item_ref) ||
                r.ambiguity_codes.some((c) => c.startsWith('PROVIDER_'))
              )
                proposed = emptyResult(item, 'PROVIDER_UNAVAILABLE');
              else if (!solution)
                proposed = emptyResult(item, 'PROBLEM_UNRESOLVED');
              else {
                try {
                  proposed = await comparePhotoAnswer(
                    item,
                    r,
                    solution,
                    provider,
                  );
                } catch {
                  proposed = emptyResult(item, 'UNSUPPORTED');
                }
              }
              items.push({
                extraction: r,
                proposed,
                solution,
                initial_proposal: {
                  outcome: proposed.outcome,
                  score: proposed.score,
                },
                reviewed: false,
              });
            } else items.push({ extraction: r, proposed, reviewed: false });
          }
          const live = this.current(id);
          readSubmission(ctx, id);
          this.open(live);
          if (live.fence !== s.fence || live.processing !== 'PROCESSING')
            throw new GradingError('STATE_CONFLICT', 409);
          const draft: Draft = {
            submission_id: id,
            draft_revision: live.draft_revision + 1,
            items,
          };
          await this.write(
            s,
            'draft',
            new TextEncoder().encode(JSON.stringify(draft)),
            'application/json',
          );
          this.db
            .prepare(
              "UPDATE grading_v3_submissions SET draft_revision=?,processing='REVIEW_REQUIRED',error_code=? WHERE id=? AND raw_state='OPEN'",
            )
            .run(draft.draft_revision, unavailable ?? null, id);
        } finally {
          for (const page of pages) page.bytes.fill(0);
        }
      });
    } catch (error) {
      const live = this.current(id);
      if (live.raw_state === 'OPEN')
        this.db
          .prepare(
            "UPDATE grading_v3_submissions SET processing='FAILED',error_code='PROCESSING_FAILED' WHERE id=?",
          )
          .run(id);
      throw error instanceof GradingError
        ? error
        : new GradingError('PROCESSING_FAILED', 503);
    }
  }
  async draft(ctx: PageContext, id: string) {
    const s = readSubmission(ctx, id, true);
    this.open(s);
    const object = await this.raw.get(s.scope, 'draft');
    if (!object) throw new GradingError('DRAFT_NOT_READY', 409);
    try {
      const value = JSON.parse(new TextDecoder().decode(object.bytes)) as Draft;
      readSubmission(ctx, id, true);
      this.open(this.current(id));
      if (value.draft_revision !== this.current(id).draft_revision)
        throw new GradingError('REVISION_MISMATCH', 412);
      return value;
    } finally {
      object.bytes.fill(0);
    }
  }
  async patch(
    ctx: PageContext,
    id: string,
    expected: number,
    replacements: DraftItem[],
  ) {
    requireStaff(ctx);
    const s = readSubmission(ctx, id, true);
    const old = await this.draft(ctx, id);
    if (expected !== old.draft_revision)
      throw new GradingError('REVISION_MISMATCH', 412);
    const a = assignmentFor(
      this.db,
      s.tenant,
      s.assignment,
      s.assignment_version,
    );
    if (
      replacements.length !== a.items.length ||
      new Set(replacements.map((i) => i.extraction.item_ref)).size !==
        a.items.length
    )
      throw new GradingError('ITEM_SET_MISMATCH');
    const items = a.items.map((def) => {
      const candidate = replacements.find(
        (i) => i.extraction.item_ref === def.item_ref,
      );
      if (!candidate) throw new GradingError('ITEM_SET_MISMATCH');
      const extraction = parse(readingSchema, candidate.extraction);
      if (
        typeof candidate.reviewed !== 'boolean' ||
        extraction.regions.some((r) => r.page_no !== def.expected_page_no)
      )
        throw new GradingError('VALIDATION_FAILED');
      const previous = old.items.find(
        (i) => i.extraction.item_ref === def.item_ref,
      )!;
      const reviewReference = (
        candidate.review_reference ?? previous.review_reference
      )?.trim();
      if (
        def.grading_mode === 'photo_solution' &&
        !reviewReference &&
        !previous.solution &&
        !['ungradable', 'excluded'].includes(candidate.proposed.outcome)
      )
        throw new GradingError('REVIEW_REFERENCE_REQUIRED');
      if (
        reviewReference &&
        (def.grading_mode !== 'photo_solution' || reviewReference.length > 1200)
      )
        throw new GradingError('VALIDATION_FAILED');
      const proposed = validateRetained(
        def,
        candidate.proposed,
        reviewReference || previous.solution?.answer,
      );
      if (
        candidate.reviewed &&
        !['ungradable', 'excluded'].includes(proposed.outcome) &&
        (extraction.answer_status === 'unreadable' ||
          extraction.answer_status === 'ambiguous' ||
          extraction.association_status !== 'matched' ||
          extraction.ambiguity_codes.length ||
          !extraction.regions.length)
      )
        throw new GradingError('REVIEW_UNRESOLVED');
      return {
        ...previous,
        extraction,
        proposed,
        reviewed: candidate.reviewed,
        review_reference: reviewReference,
      };
    });
    const next: Draft = {
      submission_id: id,
      draft_revision: expected + 1,
      items,
    };
    await this.lease(id, async (lease) => {
      // A write lease prevents purge completion while an asynchronous store PUT is in flight.
      if (this.current(id).draft_revision !== expected)
        throw new GradingError('REVISION_MISMATCH', 412);
      await this.write(
        lease,
        'draft_' + next.draft_revision,
        new TextEncoder().encode(JSON.stringify(next)),
        'application/json',
      );
      readSubmission(ctx, id, true);
      if (
        !this.db
          .prepare(
            "UPDATE grading_v3_submissions SET draft_revision=?,processing=? WHERE id=? AND draft_revision=? AND raw_state='OPEN'",
          )
          .run(
            next.draft_revision,
            items.every((i) => i.reviewed)
              ? 'READY_TO_CONFIRM'
              : 'REVIEW_REQUIRED',
            id,
            expected,
          ).changes
      )
        throw new GradingError('REVISION_MISMATCH', 412);
      await this.write(
        lease,
        'draft',
        new TextEncoder().encode(JSON.stringify(next)),
        'application/json',
      );
    });
    return { draft_revision: next.draft_revision };
  }
  private retained(items: DraftItem[]) {
    return items.map(({ proposed }) => ({
      ...proposed,
      criteria_scores: this.policy === 'none' ? [] : proposed.criteria_scores,
      criteria_collection_state:
        this.policy === 'none'
          ? ('disabled' as const)
          : proposed.criteria_collection_state,
      observed_error_codes:
        this.policy === 'criteria_and_codes'
          ? proposed.observed_error_codes
          : [],
      error_annotation_state:
        this.policy === 'criteria_and_codes'
          ? proposed.error_annotation_state
          : ('disabled' as const),
    }));
  }
  private enqueue(id: string) {
    this.db
      .prepare(
        "INSERT INTO grading_v3_jobs(id,submission,status) VALUES(?,?,'pending') ON CONFLICT(submission) DO NOTHING",
      )
      .run(newId('purge'), id);
  }
  async confirm(ctx: PageContext, id: string, expected: number, key: string) {
    requireStaff(ctx);
    const s = readSubmission(ctx, id, true);
    if (s.purpose !== 'assessment')
      throw new GradingError('CORRECTION_REQUIRES_REVISION');
    const existing = one<{ response: string; digest: string }>(
      this.db,
      'SELECT response,digest FROM grading_v3_idempotency WHERE tenant=? AND actor=? AND endpoint=? AND key=?',
      ctx.actor.academyId,
      ctx.actor.id,
      'confirm:' + id,
      key,
    );
    if (existing) {
      if (existing.digest !== digest({ expected }))
        throw new GradingError('IDEMPOTENCY_CONFLICT', 409);
      return JSON.parse(existing.response) as {
        result_set_id: string;
        revision: number;
      };
    }
    const draft = await this.draft(ctx, id);
    if (expected !== draft.draft_revision)
      throw new GradingError('REVISION_MISMATCH', 412);
    if (!draft.items.every((i) => i.reviewed))
      throw new GradingError('TEACHER_REVIEW_REQUIRED');
    return idempotent(ctx, 'confirm:' + id, key, { expected }, () => {
      const live = readSubmission(ctx, id, true);
      this.open(live);
      if (live.draft_revision !== expected || live.result_id)
        throw new GradingError('REVISION_MISMATCH', 412);
      const result: Result = {
        schema_version: '3.0',
        tenant_id: s.tenant,
        student_ref: s.student,
        assignment_id: s.assignment,
        assignment_version: s.assignment_version,
        submission_id: id,
        attempt_no: live.attempt_no!,
        result_set_id: newId('result'),
        revision: 1,
        previous_revision: null,
        submitted_at: s.submitted_at,
        confirmed_at: new Date(this.now()).toISOString(),
        confirmed_by: ctx.actor.id,
        assessment_date: s.assessment_date,
        assessment_date_source: s.date_source,
        raw_scope_id: s.scope,
        raw_generation: s.generation,
        retention_policy_version: 'volatile-raw-v1',
        analysis_detail_policy: this.policy,
        items: this.retained(draft.items),
      };
      this.db
        .prepare('INSERT INTO grading_v3_results VALUES(?,?,?,?,?)')
        .run(s.tenant, result.result_set_id, 1, id, JSON.stringify(result));
      this.db
        .prepare(
          "UPDATE grading_v3_submissions SET result_id=?,current_revision=1,published_revision=NULL,processing='CONFIRMED',raw_state='CLOSING',fence=fence+1 WHERE id=?",
        )
        .run(result.result_set_id, id);
      this.enqueue(id);
      invalidate(this.db, s.tenant, s.student);
      return { result_set_id: result.result_set_id, revision: 1 };
    });
  }
  async cancel(ctx: PageContext, id: string) {
    const s = readSubmission(ctx, id);
    if (s.result_id) requireStaff(ctx);
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE grading_v3_submissions SET raw_state=CASE WHEN raw_state='VERIFIED' THEN raw_state ELSE 'CLOSING' END,processing=CASE WHEN result_id IS NULL THEN 'CANCELLED' ELSE processing END,fence=fence+1,published_revision=NULL WHERE id=?",
        )
        .run(id);
      this.enqueue(id);
      invalidate(this.db, s.tenant, s.student);
    });
    await this.purge(id);
  }
  async purge(id: string) {
    let s = this.current(id);
    if (s.raw_state === 'VERIFIED') return true;
    if (s.raw_state === 'OPEN' || s.inflight) return false;
    this.db
      .prepare(
        "UPDATE grading_v3_submissions SET raw_state='PURGE_PENDING' WHERE id=?",
      )
      .run(id);
    try {
      const keys = await this.raw.list(s.scope);
      for (const key of keys) await this.raw.delete(s.scope, key);
      const remaining = await this.raw.list(s.scope);
      s = this.current(id);
      if (remaining.length || s.inflight || s.raw_state === 'OPEN')
        throw new Error('PURGE_NOT_VERIFIED');
      transaction(this.db, () => {
        const live = this.current(id);
        if (live.raw_state === 'VERIFIED') return;
        if (live.inflight || live.raw_state === 'OPEN')
          throw new GradingError('PURGE_NOT_VERIFIED', 409);
        const receipt: Receipt = {
          receipt_id: newId('receipt'),
          raw_scope_id: s.scope,
          generation: s.generation,
          scope_version: 'volatile-raw-v1',
          status: 'VERIFIED',
          verified_at: new Date(this.now()).toISOString(),
          listed_object_count: keys.length,
          remaining_object_count: 0,
          remaining_multipart_count: 0,
          stores_checked: [this.raw.name],
          provider_retention_policy_ref:
            one<{ policy: string }>(
              this.db,
              'SELECT policy FROM grading_v3_practice_consent WHERE submission=?',
              s.id,
            )?.policy ?? this.policyRef,
        };
        this.db
          .prepare(
            'INSERT INTO grading_v3_receipts VALUES(?,?,?,?) ON CONFLICT(tenant,scope,generation) DO NOTHING',
          )
          .run(s.tenant, s.scope, s.generation, JSON.stringify(receipt));
        this.db
          .prepare(
            "UPDATE grading_v3_submissions SET raw_state='VERIFIED',error_code=NULL,published_revision=CASE WHEN processing='CONFIRMED' THEN current_revision ELSE NULL END WHERE id=?",
          )
          .run(id);
        this.db
          .prepare(
            "UPDATE grading_v3_jobs SET status='done',last_error=NULL WHERE submission=?",
          )
          .run(id);
        // A correction's scope publishes its target head, never an independent attempt.
        if (
          s.purpose === 'correction_evidence' &&
          s.target &&
          s.processing === 'CONFIRMED'
        ) {
          this.db
            .prepare(
              'UPDATE grading_v3_submissions SET published_revision=current_revision WHERE tenant=? AND result_id=? AND current_revision=?',
            )
            .run(s.tenant, s.target, s.target_revision! + 1);
        }
        invalidate(this.db, s.tenant, s.student);
      });
      return true;
    } catch {
      this.db
        .prepare(
          "UPDATE grading_v3_submissions SET raw_state='PURGE_RETRY',error_code='PURGE_NOT_VERIFIED' WHERE id=?",
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE grading_v3_jobs SET status='retry',tries=tries+1,last_error='PURGE_NOT_VERIFIED' WHERE submission=?",
        )
        .run(id);
      return false;
    }
  }
  async sweep() {
    transaction(this.db, () => {
      for (const s of rows<Submission>(
        this.db,
        "SELECT * FROM grading_v3_submissions WHERE raw_state='OPEN' AND expires_at<=?",
        this.now(),
      )) {
        this.db
          .prepare(
            "UPDATE grading_v3_submissions SET processing='EXPIRED',raw_state='CLOSING',fence=fence+1 WHERE id=? AND raw_state='OPEN'",
          )
          .run(s.id);
        this.enqueue(s.id);
        if (s.uploaded) invalidate(this.db, s.tenant, s.student);
      }
    });
    for (const s of rows<{ id: string }>(
      this.db,
      "SELECT id FROM grading_v3_submissions WHERE raw_state NOT IN ('OPEN','VERIFIED') ORDER BY expires_at LIMIT 100",
    ))
      await this.purge(s.id);
  }
  result(ctx: PageContext, id: string, revision?: number): Result {
    const head = one<Submission>(
      this.db,
      'SELECT * FROM grading_v3_submissions WHERE tenant=? AND result_id=? AND purpose=?',
      ctx.actor.academyId,
      id,
      'assessment',
    );
    if (!head) throw new GradingError('RESOURCE_NOT_FOUND', 404);
    readSubmission(ctx, head.id);
    if (revision !== undefined) requireStaff(ctx);
    if (
      revision === undefined &&
      (!head.published_revision ||
        head.published_revision !== head.current_revision)
    )
      throw new GradingError('PURGE_NOT_VERIFIED', 409);
    const r = one<{ payload: string }>(
      this.db,
      'SELECT payload FROM grading_v3_results WHERE tenant=? AND id=? AND revision=?',
      head.tenant,
      id,
      revision ?? head.current_revision!,
    );
    if (!r) throw new GradingError('RESOURCE_NOT_FOUND', 404);
    const result = JSON.parse(r.payload) as Result;
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM grading_v3_receipts WHERE tenant=? AND scope=? AND generation=?',
        )
        .get(head.tenant, result.raw_scope_id, result.raw_generation)
    )
      throw new GradingError('PURGE_NOT_VERIFIED', 409);
    return result;
  }
  async photo(ctx: PageContext, id: string, page: number) {
    const s = readSubmission(ctx, id, true);
    this.open(s);
    const object = await this.raw.get(s.scope, 'page_' + page);
    if (!object) throw new GradingError('RESOURCE_NOT_FOUND', 404);
    try {
      readSubmission(ctx, id, true);
      this.open(this.current(id));
      return object;
    } catch (error) {
      object.bytes.fill(0);
      throw error;
    }
  }
  async revise(
    ctx: PageContext,
    resultId: string,
    input: {
      expected_result_revision: number;
      reason_code:
        'DATE_CORRECTION' | 'EXCLUSION_CORRECTION' | 'SCORE_CORRECTION';
      assessment_date?: string;
      new_submission_id?: string;
      expected_evidence_draft_revision?: number;
      expected_evidence_raw_generation?: number;
      excluded_items?: string[];
    },
    key: string,
  ) {
    requireStaff(ctx);
    const old = this.result(
      ctx,
      resultId,
      input.reason_code === 'SCORE_CORRECTION'
        ? input.expected_result_revision
        : undefined,
    );
    if (old.revision !== input.expected_result_revision)
      throw new GradingError('REVISION_MISMATCH', 412);
    let evidence: Submission | undefined;
    let replacement = old.items;
    if (input.reason_code === 'DATE_CORRECTION') {
      if (
        !input.assessment_date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.assessment_date) ||
        Number.isNaN(Date.parse(input.assessment_date + 'T00:00:00Z')) ||
        new Date(input.assessment_date + 'T00:00:00Z')
          .toISOString()
          .slice(0, 10) !== input.assessment_date
      )
        throw new GradingError('INVALID_DATE');
    } else if (input.reason_code === 'EXCLUSION_CORRECTION') {
      if (
        !input.excluded_items?.length ||
        input.excluded_items.some(
          (id) => !old.items.some((i) => i.item_ref === id),
        )
      )
        throw new GradingError('ITEM_REFERENCE_MISMATCH');
      replacement = old.items.map((i) =>
        input.excluded_items!.includes(i.item_ref)
          ? {
              ...i,
              outcome: 'excluded',
              score: null,
              exclusion_reason: 'TEACHER_EXCLUDED',
              criteria_scores: [],
              criteria_collection_state: 'disabled',
              observed_error_codes: [],
              error_annotation_state: 'disabled',
            }
          : i,
      );
    } else {
      evidence = readSubmission(ctx, input.new_submission_id ?? '', true);
      this.open(evidence);
      if (
        evidence.purpose !== 'correction_evidence' ||
        evidence.target !== resultId ||
        evidence.target_revision !== old.revision ||
        evidence.student !== old.student_ref ||
        evidence.assignment !== old.assignment_id ||
        evidence.assignment_version !== old.assignment_version ||
        evidence.generation !== input.expected_evidence_raw_generation
      )
        throw new GradingError('EVIDENCE_REFERENCE_MISMATCH');
      const draft = await this.draft(ctx, evidence.id);
      if (draft.draft_revision !== input.expected_evidence_draft_revision)
        throw new GradingError('REVISION_MISMATCH', 412);
      if (!draft.items.every((i) => i.reviewed))
        throw new GradingError('TEACHER_REVIEW_REQUIRED');
      replacement = this.retained(draft.items);
    }
    return idempotent(ctx, 'revision:' + resultId, key, input, () => {
      const head = readSubmission(ctx, old.submission_id, true);
      if (head.current_revision !== old.revision)
        throw new GradingError('REVISION_MISMATCH', 412);
      if (evidence) {
        this.open(this.current(evidence.id));
        if (
          this.current(evidence.id).draft_revision !==
          input.expected_evidence_draft_revision
        )
          throw new GradingError('REVISION_MISMATCH', 412);
      }
      const result: Result = {
        ...old,
        items: replacement,
        revision: old.revision + 1,
        previous_revision: old.revision,
        confirmed_at: new Date(this.now()).toISOString(),
        confirmed_by: ctx.actor.id,
        ...(input.assessment_date
          ? {
              assessment_date: input.assessment_date,
              assessment_date_source: 'teacher_reported' as const,
            }
          : {}),
        ...(evidence
          ? {
              raw_scope_id: evidence.scope,
              raw_generation: evidence.generation,
            }
          : {}),
      };
      this.db
        .prepare('INSERT INTO grading_v3_results VALUES(?,?,?,?,?)')
        .run(
          old.tenant_id,
          resultId,
          result.revision,
          old.submission_id,
          JSON.stringify(result),
        );
      this.db
        .prepare(
          'UPDATE grading_v3_submissions SET current_revision=?,published_revision=?,assessment_date=?,date_source=? WHERE id=?',
        )
        .run(
          result.revision,
          evidence ? null : result.revision,
          result.assessment_date,
          result.assessment_date_source,
          old.submission_id,
        );
      if (evidence) {
        this.db
          .prepare(
            "UPDATE grading_v3_submissions SET processing='CONFIRMED',raw_state='CLOSING',fence=fence+1 WHERE id=?",
          )
          .run(evidence.id);
        this.enqueue(evidence.id);
      }
      invalidate(this.db, old.tenant_id, old.student_ref);
      return { result_set_id: resultId, revision: result.revision };
    });
  }
}
