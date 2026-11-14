/**
 * 로컬 개발용 RAG 상담 서버 + 개발 전용 테스트 화면. 운영 배포용이 아니다.
 *
 *   npm run rag:dev            → http://127.0.0.1:8787/dev (테스트 화면)
 *   curl -s localhost:8787/api/rag/query -H 'content-type: application/json' \
 *     -H 'x-dev-user: GA_GUARDIAN_KIM' -d '{"question":"서윤이 10월 성적 알려주세요"}'
 *
 * 자료: 합성 v1 스모크셋, 가상 학원, 개발용 가상 학원, 팀 휴·보강 자료.
 *       미공개 평가 학원(academies-v2 의 나머지)은 이 서버에 올리지 않는다.
 *
 * - 127.0.0.1 에만 바인딩한다. x-dev-user 헤더 / 화면의 계정 선택은 이 dev 서버에서만 허용되는 모의 인증이다.
 * - /api/rag/* 는 운영과 같은 핸들러(응답에 내부 trace 없음). 진단 정보는 /dev/api/* 에서만 돌려준다.
 * - 생성 공급자: RAG_GENERATION_PROVIDER(기본 disabled, mock 가능). 검색기: RAG_DEV_RETRIEVER(bm25|dense|dense-rerank).
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  buildAcademiesStore,
  createAcademyAccessScopePort,
  createAcademyCatalogPort,
  readAcademiesDataset,
  type AcademiesDataset,
} from '../adapters/fixture/load-academies.ts';
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
import { V2_DIR } from '../eval/harness.ts';
import { createGenerationProviderFromEnv } from '../generation/from-env.ts';
import { createRagHttpHandler } from '../http/handlers.ts';
import { InMemoryTokenBucket } from '../http/rate-limit.ts';
import { prepareFileDocument } from '../ingest/ingest-file.ts';
import type { CatalogPort } from '../ports.ts';
import { createRetriever } from '../retrieval/setup.ts';
import { createRagConsultationService } from '../service.ts';
import { IndexJobQueue } from '../store/index-jobs.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import type { RagAccessScope } from '../types.ts';
import {
  generationMode,
  instrumentGeneration,
  instrumentStore,
  previewParse,
  type DevRecorder,
} from './dev-tools.ts';

const port = Number(process.env.RAG_DEV_PORT ?? 8787);
const allowedOrigin =
  process.env.RAG_DEV_ALLOWED_ORIGIN ?? 'http://localhost:3000';
const engine = process.env.RAG_DEV_ENGINE === 'legacy' ? 'legacy' : 'planned';

// 검색기(개발 화면에 표시): 모델을 못 불러오면 BM25 로 내려간다.
const retrieverChoice = process.env.RAG_DEV_RETRIEVER ?? 'bm25';
const retriever = await createRetriever({
  dense: retrieverChoice.startsWith('dense') ? 'on' : 'off',
  reranker: retrieverChoice === 'dense-rerank' ? 'on' : 'off',
});
const strategy = `${retriever.dense ? 'BM25 + e5-small 하이브리드(RRF)' : 'BM25'}${retriever.reranker ? ' + bge 재정렬(애매할 때만)' : ''}`;

const data = readFixtureData();
const academiesV1 = readAcademiesDataset();
const academiesV2Dev = readAcademiesDataset(V2_DIR, {
  folders: ['AC_HANGYEOL'],
});
const makeupSchedule = readAcademiesDataset(
  join(import.meta.dirname, '../../../makeup-schedule/academies'),
);
const academyFixtures = [
  { dataset: academiesV1, label: 'academies-v1' },
  { dataset: academiesV2Dev, label: 'academies-v2(dev)' },
  { dataset: makeupSchedule, label: 'makeup-schedule' },
];
const store = await buildFixtureStore(
  data,
  new InMemoryRagStore({ ranker: retriever.ranker }),
);
const unreadableFixtures = new Set<string>();
for (const { dataset } of academyFixtures) {
  await buildAcademiesStore(dataset, store, {
    ocr: null,
    onUnreadable: (document, reason) => {
      unreadableFixtures.add(document.file);
      console.warn(
        `[rag-dev] 미리보기에서 색인 제외: ${document.file} (${reason})`,
      );
    },
  });
}
const v1Catalog = createFixtureCatalogPort(data);
const academyCatalogs = academyFixtures.map(({ dataset }) =>
  createAcademyCatalogPort(dataset),
);
const catalog: CatalogPort = {
  async getAcademyCatalog(academyId) {
    for (const port of academyCatalogs) {
      const found = await port.getAcademyCatalog(academyId);
      if (found) return found;
    }
    return v1Catalog.getAcademyCatalog(academyId);
  },
};
const accessPorts = [
  ...academyFixtures.map(({ dataset }) =>
    createAcademyAccessScopePort(dataset),
  ),
  createFixtureAccessScopePort(data),
];
async function resolveAccess(userId: string): Promise<RagAccessScope | null> {
  for (const access of accessPorts) {
    const scope = await access.resolveFromServerSession({ userId });
    if (scope) return scope;
  }
  return null;
}

const clock = new SystemClock();
const logger = new ConsoleRagLogger();
const generation = createGenerationProviderFromEnv(process.env);
const conversations = new InMemoryConversationStore();
const handoff = new InMemoryHandoffStore();
const indexQueue = new IndexJobQueue({ documents: store, clock, logger });
const service = createRagConsultationService({
  engine,
  facts: store,
  documents: store,
  catalog,
  generation,
  handoff,
  conversations,
  clock,
  logger,
});
const handler = createRagHttpHandler({
  service,
  clock,
  logger,
  accessScope: {
    resolveFromServerSession: (session: { userId: string }) =>
      resolveAccess(session.userId),
  },
  resolveSession: async (request) => {
    const userId = request.headers.get('x-dev-user');
    return userId ? { userId } : null;
  },
  indexQueue,
  rateLimiter: new InMemoryTokenBucket({ capacity: 20, refillPerMinute: 20 }),
});

// ── 개발 화면용 목록 ───────────────────────────────────────────────
interface DevDocument {
  academyId: string;
  documentId: string;
  revision: number;
  title: string;
  documentType: string;
  visibility: string;
  origin: string;
}
const users = [
  ...data.users.map((u) => ({ ...u, dataset: 'v1-smoke' })),
  ...academyFixtures.flatMap(({ dataset, label }) =>
    dataset.users.map((user) => ({ ...user, dataset: label })),
  ),
].map((u) => ({
  userId: u.user_id,
  role: u.role,
  academyId: u.academy_id,
  dataset: u.dataset,
}));
const academyDocs = (dataset: AcademiesDataset, origin: string) =>
  dataset.documents
    .filter(
      (d) =>
        d.meta.status === 'approved_active' && !unreadableFixtures.has(d.file),
    )
    .map((d) => ({
      academyId: d.file.split('/')[0],
      documentId: d.meta.document_id,
      revision: d.meta.revision,
      title: d.meta.title,
      documentType: d.meta.document_type,
      visibility: d.meta.visibility,
      origin: d.source ? `${origin} · ${d.source.format}` : origin,
    }));
const documents: DevDocument[] = [
  ...data.documents
    .filter((d) => d.status === 'approved_active')
    .map((d) => ({
      academyId: d.academy_id,
      documentId: d.document_id,
      revision: d.revision,
      title: d.title,
      documentType: d.document_type,
      visibility: 'fixture',
      origin: 'v1-smoke',
    })),
  ...academyFixtures.flatMap(({ dataset, label }) =>
    academyDocs(dataset, label),
  ),
];

// ── 개발 전용 API ──────────────────────────────────────────────────
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

async function devApi(request: Request, path: string): Promise<Response> {
  if (path === '/dev/api/meta' && request.method === 'GET') {
    return json(200, {
      users,
      documents,
      engine,
      retriever: {
        choice: retrieverChoice,
        strategy,
        loadMs: retriever.loadMs,
        errors: retriever.errors,
      },
      generation: {
        providerId: generation.providerId,
        mode: generationMode(generation),
        isExternal: generation.isExternal,
        personalDataApproved: generation.personalDataApproved,
      },
    });
  }
  if (request.method !== 'POST') return json(405, { error: 'METHOD' });
  const body = (await request.json()) as Record<string, unknown>;

  if (path === '/dev/api/parse') {
    const bytes = new Uint8Array(
      Buffer.from(String(body.contentBase64 ?? ''), 'base64'),
    );
    return json(
      200,
      await previewParse({ fileName: String(body.fileName ?? ''), bytes }),
    );
  }

  if (path === '/dev/api/upload') {
    const access = await resolveAccess(String(body.userId ?? ''));
    if (!access || access.role !== 'admin')
      return json(403, { error: '관리자 계정으로만 색인할 수 있습니다.' });
    const documentId = `DEV_UPLOAD_${Date.now()}`;
    const meta = {
      academyId: access.academyId,
      documentId,
      revision: 1,
      documentType: String(body.documentType ?? 'announcement'),
      title: String(body.title || body.fileName || documentId),
      visibility: String(body.visibility ?? 'academy_public'),
      validFrom: new Date(clock.now() - 60_000).toISOString(),
    } as Parameters<typeof prepareFileDocument>[0];
    const prepared = await prepareFileDocument(meta, {
      bytes: new Uint8Array(
        Buffer.from(String(body.contentBase64 ?? ''), 'base64'),
      ),
      fileName: String(body.fileName ?? 'upload'),
    });
    if (!prepared.document)
      return json(422, { error: 'PARSE_FAILED', parse: prepared.parsed });
    const job = indexQueue.enqueue({
      jobType: 'upsert',
      document: prepared.document,
      facts: [],
      approve: true,
    });
    await indexQueue.runPending();
    const status = indexQueue.getJob(job.jobId)?.status;
    if (status === 'activated') {
      documents.push({
        academyId: meta.academyId,
        documentId,
        revision: 1,
        title: meta.title,
        documentType: meta.documentType,
        visibility: meta.visibility,
        origin: `업로드 · ${prepared.parsed.format}`,
      });
    }
    return json(200, {
      documentId,
      status,
      parse: {
        format: prepared.parsed.format,
        status: prepared.parsed.status,
        pages: prepared.parsed.pages,
        warnings: prepared.parsed.warnings,
      },
    });
  }

  if (path === '/dev/api/ask') {
    const access = await resolveAccess(String(body.userId ?? ''));
    if (!access) return json(400, { error: '계정을 고르세요.' });
    const question = String(body.question ?? '').slice(0, 500);
    const documentIds = Array.isArray(body.documentIds)
      ? (body.documentIds as unknown[]).map(String)
      : null;
    const recorder: DevRecorder = {
      searches: [],
      factQueries: [],
      generation: { calls: 0, ms: 0 },
    };
    const ports = instrumentStore(store, recorder, documentIds);
    const devService = createRagConsultationService({
      engine,
      facts: ports.facts,
      documents: ports.documents,
      catalog,
      generation: instrumentGeneration(generation, recorder),
      handoff,
      conversations,
      clock,
    });
    const started = performance.now();
    const output = await devService.query({
      access,
      question,
      conversationId: String(body.conversationId ?? 'dev-ui'),
    });
    const totalMs = performance.now() - started;
    const retrievalMs = recorder.searches.reduce((sum, s) => sum + s.ms, 0);
    const factMs = recorder.factQueries.reduce((sum, f) => sum + f.ms, 0);
    const round = (n: number) => Math.round(n * 10) / 10;
    return json(200, {
      answer: output.answer,
      debug: {
        strategy,
        generation: {
          mode: generationMode(generation),
          providerId: generation.providerId,
          calls: recorder.generation.calls,
        },
        timings: {
          totalMs: round(totalMs),
          retrievalMs: round(retrievalMs),
          factLookupMs: round(factMs),
          generationMs: round(recorder.generation.ms),
          routingAndVerificationMs: round(
            totalMs - retrievalMs - factMs - recorder.generation.ms,
          ),
        },
        trace: output.trace,
        searches: recorder.searches,
        factQueries: recorder.factQueries,
        documentFilter: documentIds,
      },
    });
  }
  return json(404, { error: 'NOT_FOUND' });
}

const corsHeaders = {
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-headers': 'content-type, x-dev-user',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const page = readFileSync(join(import.meta.dirname, 'dev-ui.html'), 'utf-8');

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
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/' || url.pathname === '/dev') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  const request = new Request(url, { method: req.method, headers, body });
  let response: Response;
  try {
    response = url.pathname.startsWith('/dev/api/')
      ? await devApi(request, url.pathname)
      : await handler(request);
  } catch (error) {
    response = json(500, { error: (error as Error).message });
  }
  res.writeHead(response.status, {
    ...Object.fromEntries(response.headers),
    ...corsHeaders,
  });
  res.end(await response.text());
}).listen(port, '127.0.0.1', () => {
  console.info(
    `[rag-dev] 테스트 화면 http://127.0.0.1:${port}/dev · API /api/rag/query · 검색기 ${strategy} · 생성 ${generationMode(generation)} (합성 데이터·모의 세션 전용)`,
  );
});
