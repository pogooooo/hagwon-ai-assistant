/**
 * 실제 PDF → 파싱 → 색인 → 검색 → 답변 통합 테스트.
 * 1) HTTP 색인 API 로 PDF 파일(base64)을 올리고, 같은 학원 보호자가 질문하면 그 PDF 의 쪽 위치를 인용해 답한다.
 * 2) 개발용 가상 학원(academies-v2 AC_HANGYEOL)의 원본 PDF(표·2단 소식지)만으로 답이 나오는 질문.
 * 텍스트를 미리 뽑아 넣지 않고 원본 파일만 입력한다(OCR 은 끔 — 스캔 PDF 는 이 테스트 대상이 아님).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
} from '../adapters/fixture/load-academies.ts';
import {
  createFixtureAccessScopePort,
  createFixtureCatalogPort,
  readFixtureData,
} from '../adapters/fixture/load-fixture.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
  MemoryRagLogger,
} from '../adapters/memory/index.ts';
import { V2_DIR } from '../eval/harness.ts';
import { DisabledGenerationProvider } from '../generation/providers.ts';
import { createRagHttpHandler } from '../http/handlers.ts';
import { InMemoryTokenBucket } from '../http/rate-limit.ts';
import { createRagConsultationService } from '../service.ts';
import { IndexJobQueue } from '../store/index-jobs.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF = readFileSync(
  join(
    HERE,
    '..',
    '__fixtures__',
    'documents-v1',
    'documents',
    'PX_FEE_TABLE__r1.pdf',
  ),
);

describe('PDF 업로드 → 색인 → 질문(HTTP)', async () => {
  // 빈 저장소: 답의 근거는 올린 PDF 하나뿐이다.
  const data = readFixtureData();
  const store = new InMemoryRagStore();
  const clock = new FixedClock(parseInstant('2026-12-02T18:00:00+09:00'));
  const logger = new MemoryRagLogger();
  const service = createRagConsultationService({
    facts: store,
    documents: store,
    catalog: createFixtureCatalogPort(data),
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
    accessScope: createFixtureAccessScopePort(data),
    resolveSession: async (request) => {
      const userId = request.headers.get('x-test-user');
      return userId ? { userId } : null;
    },
    indexQueue: new IndexJobQueue({ documents: store, clock }),
    rateLimiter: new InMemoryTokenBucket({
      capacity: 100,
      refillPerMinute: 100,
    }),
  });
  const post = (path: string, body: unknown, user: string) =>
    handler(
      new Request(`http://localhost/api/rag${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': user },
        body: JSON.stringify(body),
      }),
    );

  const upload = await post(
    '/index',
    {
      approve: true,
      file: {
        fileName: '겨울학기_수강료.pdf',
        contentBase64: PDF.toString('base64'),
      },
      document: {
        academyId: 'AC_A',
        documentId: 'PX_FEE_TABLE',
        revision: 1,
        documentType: 'fee',
        title: '겨울학기 수강료표',
        visibility: 'academy_public',
        validFrom: '2026-12-01T00:00:00+09:00',
      },
    },
    'ADMIN_A',
  );

  test('관리자 PDF 색인은 파싱 결과와 함께 활성화된다', async () => {
    assert.equal(upload.status, 202);
    const job = await upload.json();
    assert.equal(job.status, 'activated');
    assert.equal(job.parse.format, 'pdf');
    assert.equal(job.parse.status, 'ok');
  });

  test('보호자 질문 → PDF 문단을 쪽 위치와 함께 인용', async () => {
    const response = await post(
      '/query',
      { question: '수강료 납부는 언제까지 해야 돼요?' },
      'GUARDIAN_A',
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    // 저장소에 수강료 정형 사실이 없어(올린 PDF 하나뿐) 납부 기한만 답하는 부분 답변도 정상이다.
    assert.ok(['answered', 'partial'].includes(body.status), body.status);
    assert.match(body.answer, /매월 5일까지/);
    assert.equal(body.citations[0].sourceId, 'PX_FEE_TABLE:r1:body');
    assert.match(body.citations[0].location ?? '', /1쪽/);
    assert.equal(body.trace, undefined);
  });

  test('다른 학원 계정에는 그 PDF 내용이 보이지 않는다', async () => {
    const response = await post(
      '/query',
      { question: '수강료 납부는 언제까지 해야 돼요?' },
      'ADMIN_B',
    );
    const body = await response.json();
    assert.notEqual(body.status, 'answered');
    assert.ok(
      !(body.citations ?? []).some(
        (c: { sourceId: string }) => c.sourceId === 'PX_FEE_TABLE:r1:body',
      ),
    );
  });
});

describe('개발용 가상 학원 원본 PDF 로만 답하기(서비스)', async () => {
  const dataset = readAcademiesDataset(V2_DIR, { folders: ['AC_HANGYEOL'] });
  const store = await buildAcademiesStore(dataset, new InMemoryRagStore(), {
    ocr: null,
  });
  const catalog = createAcademyCatalogPort(dataset);
  const ask = async (userId: string, question: string, asOf: string) => {
    const user = dataset.users.find((u) => u.user_id === userId);
    if (!user) throw new Error(userId);
    const service = createRagConsultationService({
      facts: store,
      documents: store,
      catalog,
      generation: new DisabledGenerationProvider(),
      handoff: new InMemoryHandoffStore(),
      conversations: new InMemoryConversationStore(),
      clock: new FixedClock(parseInstant(asOf)),
    });
    return service.query({
      access: toAcademyAccessScope(user, dataset.students),
      question,
    });
  };

  test('PDF 표(과정별 수업 구성) 행의 값으로 답하고 표 위치를 인용', async () => {
    const output = await ask(
      'HK_VISITOR',
      '초등 실험탐구반 일주일에 몇번이고 한번에 몇분 수업해요?',
      '2026-11-10T18:00:00+09:00',
    );
    assert.equal(output.answer.status, 'answered');
    assert.match(output.answer.answer, /주 2회/);
    assert.match(output.answer.answer, /90분/);
    assert.doesNotMatch(output.answer.answer, /180분/);
    const citation = output.answer.citations[0];
    assert.equal(citation.sourceId, 'HK_FEE_2026:r1:body');
    assert.match(citation.location ?? '', /1쪽/);
  });

  test('2단 편집 소식지 PDF 의 기사 문단으로 답한다', async () => {
    const output = await ask(
      'HK_VISITOR',
      '가을 과학탐구대회 상 받은 학생 몇명이에요?',
      '2026-11-10T18:00:00+09:00',
    );
    assert.equal(output.answer.status, 'answered');
    assert.match(output.answer.answer, /은상 1명/);
    assert.match(output.answer.answer, /동상 2명/);
    assert.equal(
      output.answer.citations[0].sourceId,
      'HK_NEWSLETTER_2026_11:r1:body',
    );
  });
});
