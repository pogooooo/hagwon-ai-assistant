/**
 * HTTP 계약 테스트: 인증 fail-closed, 입력 검증, 클라이언트 권한 필드 무시, 호출 제한, 관리자 색인 API.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createFixtureAccessScopePort,
  createFixtureCatalogPort,
} from '../adapters/fixture/load-fixture.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
  MemoryRagLogger,
} from '../adapters/memory/index.ts';
import { DisabledGenerationProvider } from '../generation/providers.ts';
import { createRagHttpHandler } from '../http/handlers.ts';
import { InMemoryTokenBucket } from '../http/rate-limit.ts';
import { createRagConsultationService } from '../service.ts';
import { IndexJobQueue } from '../store/index-jobs.ts';
import { parseInstant } from '../text/time.ts';
import { freshEnv } from './helpers.ts';

const env = await freshEnv();
const clock = new FixedClock(parseInstant('2026-11-01T18:00:00+09:00'));
const logger = new MemoryRagLogger();
const service = createRagConsultationService({
  facts: env.store,
  documents: env.store,
  catalog: createFixtureCatalogPort(env.data),
  generation: new DisabledGenerationProvider(),
  handoff: new InMemoryHandoffStore(),
  conversations: new InMemoryConversationStore(),
  clock,
  logger,
});
const handler = createRagHttpHandler({
  service,
  clock,
  logger,
  accessScope: createFixtureAccessScopePort(env.data),
  resolveSession: async (request) => {
    const userId = request.headers.get('x-test-user');
    return userId ? { userId } : null;
  },
  indexQueue: new IndexJobQueue({ documents: env.store, clock }),
  rateLimiter: new InMemoryTokenBucket({ capacity: 3, refillPerMinute: 1 }),
});

function post(
  path: string,
  body: unknown,
  user?: string,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request(`http://localhost/api/rag${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-test-user': user } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

describe('POST /api/rag/query', () => {
  test('세션이 없으면 401(fail-closed)', async () => {
    const response = await post('/query', { question: '수강료?' });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  test('메서드·형식·크기·스키마 검증', async () => {
    const get = await handler(
      new Request('http://localhost/api/rag/query', {
        headers: { 'x-test-user': 'ADMIN_B' },
      }),
    );
    assert.equal(get.status, 405);
    const text = await post('/query', 'question=hi', 'ADMIN_B', {
      'content-type': 'text/plain',
    });
    assert.equal(text.status, 415);
    const big = await post('/query', { question: 'a'.repeat(5000) }, 'ADMIN_B');
    assert.equal(big.status, 413);
    const invalid = await post('/query', { question: '' }, 'ADMIN_B');
    assert.equal(invalid.status, 400);
  });

  test('본문의 role/academyId/allowedStudentIds 는 권한에 영향을 주지 않는다', async () => {
    const response = await post(
      '/query',
      {
        question: 'A01의 10월 정답률 알려줘',
        role: 'admin',
        academyId: 'AC_A',
        allowedStudentIds: ['ST_A01'],
        userId: 'ADMIN_A',
      },
      'GUARDIAN_A02',
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'denied');
    assert.deepEqual(Object.keys(body).sort(), [
      'answer',
      'citations',
      'requestId',
      'status',
    ]);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('정상 응답에는 내부 trace 가 포함되지 않는다', async () => {
    const response = await post(
      '/query',
      { question: 'A02의 10월 정답률은?', conversationId: 'c-1' },
      'GUARDIAN_A',
    );
    const body = await response.json();
    assert.equal(body.status, 'answered');
    assert.equal(body.trace, undefined);
    assert.equal(body.citations[0].sourceId, 'D_S2_OCT:r1:body');
  });

  test('사용자별 호출 제한 초과 시 429 + Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1)
      statuses.push(
        (await post('/query', { question: '수강료?' }, 'VISITOR_A')).status,
      );
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.equal(statuses[3], 429);
    const limited = await post('/query', { question: '수강료?' }, 'VISITOR_A');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('관리자 색인 API', () => {
  const document = {
    academyId: 'AC_A',
    documentId: 'D_NOTICE_TEST',
    revision: 1,
    documentType: 'announcement',
    title: 'A학원 셔틀 안내',
    text: '셔틀버스는 평일 운행합니다.',
    visibility: 'academy_public',
    validFrom: '2026-10-01T00:00:00+09:00',
  };

  test('관리자가 아니면 403, 다른 학원 문서는 403', async () => {
    assert.equal(
      (await post('/index', { document, approve: true }, 'GUARDIAN_A')).status,
      403,
    );
    assert.equal(
      (await post('/index', { document, approve: true }, 'ADMIN_B')).status,
      403,
    );
  });

  test('관리자 색인 → 202, 작업 상태 조회는 같은 학원 관리자만', async () => {
    const response = await post(
      '/index',
      { document, approve: true },
      'ADMIN_A',
    );
    assert.equal(response.status, 202);
    const job = await response.json();
    assert.equal(job.status, 'activated');
    const status = await handler(
      new Request(`http://localhost/api/rag/index/jobs/${job.jobId}`, {
        headers: { 'x-test-user': 'ADMIN_A' },
      }),
    );
    assert.equal(status.status, 200);
    const other = await handler(
      new Request(`http://localhost/api/rag/index/jobs/${job.jobId}`, {
        headers: { 'x-test-user': 'ADMIN_B' },
      }),
    );
    assert.equal(other.status, 404);
  });
});
