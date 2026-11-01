/**
 * 로컬 개발용 RAG 상담 서버(합성 데이터 + 모의 세션). 운영 배포용이 아니다.
 *
 *   npm run rag:dev
 *   curl -s localhost:8787/api/rag/query -H 'content-type: application/json' \
 *     -H 'x-dev-user: GUARDIAN_A' -d '{"question":"A01의 10월 일차방정식 정답률은?"}'
 *
 * - 127.0.0.1 에만 바인딩한다.
 * - x-dev-user 헤더로 합성 계정을 고르는 것은 이 dev 서버에서만 허용되는 모의 인증이다.
 * - 생성 공급자는 RAG_GENERATION_PROVIDER(기본 disabled, mock 가능) 환경 변수로 고른다.
 */
import { createServer } from 'node:http';

import {
  buildFixtureStore,
  createFixtureAccessScopePort,
  createFixtureCatalogPort,
  readFixtureData,
} from '../adapters/fixture/load-fixture.ts';
import {
  ConsoleRagLogger,
  InMemoryConversationStore,
  InMemoryHandoffStore,
  SystemClock,
} from '../adapters/memory/index.ts';
import { createGenerationProviderFromEnv } from '../generation/from-env.ts';
import { createRagHttpHandler } from '../http/handlers.ts';
import { InMemoryTokenBucket } from '../http/rate-limit.ts';
import { createRagConsultationService } from '../service.ts';
import { IndexJobQueue } from '../store/index-jobs.ts';

const port = Number(process.env.RAG_DEV_PORT ?? 8787);
const allowedOrigin =
  process.env.RAG_DEV_ALLOWED_ORIGIN ?? 'http://localhost:3000';

const data = readFixtureData();
const store = await buildFixtureStore(data);
const clock = new SystemClock();
const logger = new ConsoleRagLogger();
const service = createRagConsultationService({
  facts: store,
  documents: store,
  catalog: createFixtureCatalogPort(data),
  generation: createGenerationProviderFromEnv(process.env),
  handoff: new InMemoryHandoffStore(),
  conversations: new InMemoryConversationStore(),
  clock,
  logger,
});
const handler = createRagHttpHandler({
  service,
  clock,
  logger,
  accessScope: createFixtureAccessScopePort(data),
  resolveSession: async (request) => {
    const userId = request.headers.get('x-dev-user');
    return userId ? { userId } : null;
  },
  indexQueue: new IndexJobQueue({ documents: store, clock, logger }),
  rateLimiter: new InMemoryTokenBucket({ capacity: 20, refillPerMinute: 20 }),
});

const corsHeaders = {
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-headers': 'content-type, x-dev-user',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
  }
  const body =
    chunks.length > 0 && req.method !== 'GET'
      ? Buffer.concat(chunks)
      : undefined;
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body,
  });
  const response = await handler(request);
  res.writeHead(response.status, {
    ...Object.fromEntries(response.headers),
    ...corsHeaders,
  });
  res.end(await response.text());
}).listen(port, '127.0.0.1', () => {
  console.info(
    `[rag-dev] http://127.0.0.1:${port}/api/rag/query (합성 데이터·모의 세션 전용)`,
  );
});
