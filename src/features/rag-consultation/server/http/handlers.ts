/**
 * 표준 Fetch API(Request → Response) 핸들러.
 * 이 저장소의 Next.js 는 정적 export(output: 'export')라 API Route 를 쓸 수 없으므로,
 * 별도 백엔드(Node, Next 서버 배포, Workers 등)에서 이 함수를 그대로 마운트한다.
 *
 * - POST {base}/query            : 상담(로그인/방문자 정책은 resolveSession 이 결정)
 * - POST {base}/index            : 문서 등록·재색인(관리자 전용, 같은 학원만)
 * - GET  {base}/index/jobs/{id}  : 색인 작업 상태(관리자 전용, 같은 학원만)
 *
 * 권한(academyId·role·허용 학생)은 항상 서버 세션에서 계산하며 요청 본문 값은 무시한다.
 */
import { z } from 'zod';

import { ragQueryRequestSchema, type RagErrorBody } from '../../contract.ts';
import type { AccessScopePort, Clock, RagLogger } from '../ports.ts';
import type { RagConsultationService } from '../service.ts';
import type { IndexJobQueue } from '../store/index-jobs.ts';
import type { RagAccessScope } from '../types.ts';
import type { RateLimiter } from './rate-limit.ts';

export interface RagHttpOptions<TSession> {
  service: RagConsultationService;
  /** 쿠키/Authorization 헤더 등 기존 인증 규칙으로 서버 세션을 얻는다. 실패 시 null. */
  resolveSession: (request: Request) => Promise<TSession | null>;
  accessScope: AccessScopePort<TSession>;
  clock: Clock;
  indexQueue?: IndexJobQueue;
  rateLimiter?: RateLimiter;
  logger?: RagLogger;
  maxBodyBytes?: number;
  createRequestId?: () => string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function error(
  status: number,
  code: RagErrorBody['error']['code'],
  message: string,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body: RagErrorBody = { error: { code, message }, requestId };
  return json(status, body, extraHeaders);
}

const isoString = z.string().min(10).max(40);
const idString = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const factValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('money'),
    amount: z.number().nonnegative(),
    currency: z.literal('KRW'),
  }),
  z.object({ kind: z.literal('schedule'), text: z.string().max(500) }),
  z.object({ kind: z.literal('text'), text: z.string().max(2000) }),
  z.object({
    kind: z.literal('schedule_change'),
    changeType: z.enum(['cancel', 'makeup']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().max(40).nullable(),
    text: z.string().max(500),
  }),
  z.object({
    kind: z.literal('enrollment'),
    status: z.enum(['open', 'waitlist', 'closed']),
    capacity: z.number().int().nonnegative().nullable(),
    remaining: z.number().int().nonnegative().nullable(),
    text: z.string().max(500),
  }),
  z.object({
    kind: z.literal('accuracy'),
    correct: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    unit: z.string().min(1).max(100),
    dimension: z.enum(['unit', 'question_type', 'overall']).optional(),
  }),
  z.object({
    kind: z.literal('weak_area'),
    unit: z.string().min(1).max(100),
    text: z.string().max(1000),
  }),
]);

const indexRequestSchema = z.object({
  approve: z.boolean(),
  document: z.object({
    academyId: idString,
    documentId: idString,
    revision: z.number().int().positive(),
    documentType: z.enum([
      'academy_info',
      'fee',
      'schedule',
      'policy',
      'facility',
      'teacher',
      'announcement',
      'student_analysis',
      'guidance',
    ]),
    title: z.string().min(1).max(300),
    text: z.string().min(1).max(200_000),
    visibility: z.enum([
      'academy_public',
      'class_members',
      'student_private',
      'staff_only',
    ]),
    studentId: idString.nullable().optional(),
    classId: idString.nullable().optional(),
    validFrom: isoString,
    validTo: isoString.nullable().optional(),
    approvedAt: isoString.nullable().optional(),
    sourceId: idString.optional(),
  }),
  facts: z
    .array(
      z.object({
        factId: idString,
        sourceId: idString,
        documentId: idString,
        revision: z.number().int().positive(),
        academyId: idString,
        subjectType: z.enum(['student', 'class', 'academy']),
        subjectId: idString,
        factType: z.enum([
          'monthly_fee',
          'material_fee',
          'schedule',
          'teacher',
          'facility',
          'makeup_policy',
          'enrollment_status',
          'schedule_change',
          'accuracy',
          'weak_area',
          'learning_guidance',
          'notice',
          'contact',
        ]),
        value: factValueSchema,
        period: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .nullable(),
        validFrom: isoString,
        validTo: isoString.nullable().optional(),
        approvalStatus: z.enum(['approved', 'pending_review']),
        assignmentIds: z.array(idString).max(200).optional(),
        assignments: z
          .array(
            z.object({
              assignmentId: idString,
              title: z.string().min(1).max(200),
            }),
          )
          .max(200)
          .optional(),
        evidence: z.string().max(500).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
});

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: 413 | 400 | 415 }
> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json'))
    return { ok: false, status: 415 };
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return { ok: false, status: 413 };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes)
    return { ok: false, status: 413 };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function createRagHttpHandler<TSession>(
  options: RagHttpOptions<TSession>,
) {
  const createRequestId =
    options.createRequestId ?? (() => globalThis.crypto.randomUUID());
  const maxBodyBytes = options.maxBodyBytes ?? 4_096;

  async function authenticate(
    request: Request,
  ): Promise<RagAccessScope | null> {
    const session = await options.resolveSession(request);
    if (!session) return null;
    return options.accessScope.resolveFromServerSession(session);
  }

  function logHttpError(requestId: string, status: number, errorType: string) {
    options.logger?.log({
      event: 'rag.http_error',
      requestId,
      status: String(status),
      errorType,
    });
  }

  async function handleQuery(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    const access = await authenticate(request);
    if (!access)
      return error(401, 'UNAUTHENTICATED', '로그인이 필요합니다.', requestId);

    if (options.rateLimiter) {
      const limit = options.rateLimiter.consume(
        `query:${access.actorId}`,
        options.clock.now(),
      );
      if (!limit.allowed) {
        return error(
          429,
          'RATE_LIMITED',
          '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
          requestId,
          {
            'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)),
          },
        );
      }
    }

    const body = await readJsonBody(request, maxBodyBytes);
    if (!body.ok) {
      if (body.status === 413)
        return error(
          413,
          'PAYLOAD_TOO_LARGE',
          '요청이 너무 깁니다.',
          requestId,
        );
      if (body.status === 415)
        return error(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'JSON 요청만 지원합니다.',
          requestId,
        );
      return error(
        400,
        'INVALID_REQUEST',
        '요청 형식이 올바르지 않습니다.',
        requestId,
      );
    }
    const parsed = ragQueryRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return error(
        400,
        'INVALID_REQUEST',
        '요청 형식이 올바르지 않습니다.',
        requestId,
      );

    const { answer } = await options.service.query({
      access,
      question: parsed.data.question,
      studentIdHint: parsed.data.studentId,
      conversationId: parsed.data.conversationId,
    });
    return json(200, answer);
  }

  async function handleIndex(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    const access = await authenticate(request);
    if (!access)
      return error(401, 'UNAUTHENTICATED', '로그인이 필요합니다.', requestId);
    if (access.role !== 'admin' || !options.indexQueue) {
      return error(403, 'FORBIDDEN', '권한이 없습니다.', requestId);
    }
    const body = await readJsonBody(request, 512_000);
    if (!body.ok)
      return error(
        body.status === 413 ? 413 : 400,
        body.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
        '요청 형식이 올바르지 않습니다.',
        requestId,
      );
    const parsed = indexRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return error(
        400,
        'INVALID_REQUEST',
        '요청 형식이 올바르지 않습니다.',
        requestId,
      );
    const { document, facts, approve } = parsed.data;
    if (
      document.academyId !== access.academyId ||
      (facts ?? []).some((fact) => fact.academyId !== access.academyId)
    ) {
      return error(403, 'FORBIDDEN', '권한이 없습니다.', requestId);
    }
    const job = options.indexQueue.enqueue({
      jobType: 'upsert',
      document,
      facts: facts ?? [],
      approve,
    });
    await options.indexQueue.runPending();
    const current = options.indexQueue.getJob(job.jobId) ?? job;
    return json(202, {
      jobId: current.jobId,
      status: current.status,
      attempts: current.attempts,
      reviewRequired: current.reviewRequired,
      errorCode: current.errorCode,
      requestId,
    });
  }

  async function handleJobStatus(
    request: Request,
    requestId: string,
    jobId: string,
  ): Promise<Response> {
    const access = await authenticate(request);
    if (!access)
      return error(401, 'UNAUTHENTICATED', '로그인이 필요합니다.', requestId);
    const job = options.indexQueue?.getJob(jobId);
    // 다른 학원의 작업은 존재 여부를 드러내지 않고 404 로 응답한다.
    if (access.role !== 'admin' || !job || job.academyId !== access.academyId) {
      return error(404, 'NOT_FOUND', '작업을 찾을 수 없습니다.', requestId);
    }
    return json(200, {
      jobId: job.jobId,
      status: job.status,
      attempts: job.attempts,
      reviewRequired: job.reviewRequired,
      errorCode: job.errorCode,
      documentId: job.documentId,
      revision: job.revision,
      requestId,
    });
  }

  /** @param path 마운트 지점 이후 경로(예: "/query", "/index", "/index/jobs/abc") */
  return async function handle(
    request: Request,
    path?: string,
  ): Promise<Response> {
    const requestId = createRequestId();
    const route =
      path ?? new URL(request.url).pathname.replace(/^.*\/api\/rag/, '');
    try {
      if (route === '/query' || route === '/query/') {
        if (request.method !== 'POST')
          return error(
            405,
            'METHOD_NOT_ALLOWED',
            'POST 만 지원합니다.',
            requestId,
            { allow: 'POST' },
          );
        return await handleQuery(request, requestId);
      }
      if (route === '/index' || route === '/index/') {
        if (request.method !== 'POST')
          return error(
            405,
            'METHOD_NOT_ALLOWED',
            'POST 만 지원합니다.',
            requestId,
            { allow: 'POST' },
          );
        return await handleIndex(request, requestId);
      }
      const jobMatch = route.match(
        /^\/index\/jobs\/([A-Za-z0-9_-]{1,128})\/?$/,
      );
      if (jobMatch) {
        if (request.method !== 'GET')
          return error(
            405,
            'METHOD_NOT_ALLOWED',
            'GET 만 지원합니다.',
            requestId,
            { allow: 'GET' },
          );
        return await handleJobStatus(request, requestId, jobMatch[1]);
      }
      return error(404, 'NOT_FOUND', '경로를 찾을 수 없습니다.', requestId);
    } catch {
      logHttpError(requestId, 500, 'UNEXPECTED_ERROR');
      return error(
        500,
        'INTERNAL_ERROR',
        '일시적인 오류가 발생했습니다.',
        requestId,
      );
    }
  };
}
