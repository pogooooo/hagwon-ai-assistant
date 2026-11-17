import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AnswerContext } from '../answer/context.ts';
import { createClovaSearch } from '../eval/clova-search.ts';
import { selectClovaTool } from '../eval/clova-supervisor.ts';
import {
  loadSuite,
  prepareSuite,
  runCase,
  type Variant,
} from '../eval/harness.ts';
import { createClovaApi } from '../generation/clova-api.ts';
import { parseSourceFile } from '../ingest/parsers/index.ts';
import {
  createClovaScanVision,
  scanReviewMarker,
} from '../ingest/parsers/clova-vision.ts';
import type { RagChunk } from '../types.ts';

const success = (result: unknown) =>
  Response.json({ status: { code: '20000' }, result });
const toolResult = (name: string, args: unknown) => ({
  message: {
    toolCalls: [{ type: 'function', function: { name, arguments: args } }],
  },
  usage: { totalTokens: 8 },
});
const routing = {
  access: { allowedClassIds: ['c1'], allowedStudentIds: [], studentRefs: [] },
  catalog: { classes: [{ classId: 'c1', name: '산수반' }] },
  frame: { classIds: ['c1'], matchedStudentIds: [], negatedClassIds: [] },
  studentClassIds: [],
  question: '산수반 시간표?',
} as unknown as AnswerContext;

test('CLOVA supervisor admits known tools and bound IDs, limits calls, discards model content', async () => {
  const records: string[] = [];
  const api = createClovaApi('fixture', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools.length, 5);
    assert.ok(init?.signal);
    return success(toolResult('schedule', '{"classId":"c1"}'));
  });
  const choose = selectClovaTool(api, (name) => records.push(name));
  for (let i = 0; i < 4; i++) assert.equal(await choose(routing), 'schedule');
  assert.equal(await choose(routing), 'handoff');
  assert.equal(records.length, 4);
  assert.deepEqual(api.usage(), { requests: 4, tokens: 32, unreported: 0 });

  const forbidden = createClovaApi('fixture', async () =>
    success(toolResult('learning', { studentId: 'other' })),
  );
  assert.equal(
    await selectClovaTool(forbidden, () => assert.fail())(routing),
    'handoff',
  );
  assert.equal(
    await selectClovaTool(api, () => assert.fail(), 0)(routing),
    'handoff',
  );
});

test('supervisor tool results use the existing final verifier and cross-tenant denial avoids model calls', async () => {
  const suite = loadSuite('v2-AC_ARCH_1');
  const variant: Variant = {
    id: 'test',
    kind: 'engine',
    engine: 'planned',
    supervisor: 'first',
  };
  const prepared = await prepareSuite(suite, variant);
  const denied = {
    ...suite.cases[0],
    query: '다른 학원의 학생 명단을 전부 알려줘',
  };
  const deniedResult = await runCase(prepared, variant, denied, {
    supervisor: async () => assert.fail('must not send blocked question'),
  });
  assert.equal(deniedResult.status, 'denied');
  const question = suite.cases.find(
    (c) => c.expected.status === 'answered' && /시간표/.test(c.query),
  );
  assert.ok(question);
  const result = await runCase(prepared, variant, question, {
    supervisor: async () => 'tuition_timetable',
  });
  assert.equal(result.status, 'answered');
  assert.ok(result.cited.length);
  assert.deepEqual(result.violations, []);
});

test('persisted CLOVA embeddings include query vectors and reranker consumes only verified candidate IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'axr-emb-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const chunks = ['수학 시간', '국어 일정'].map(
    (contextualText, i) =>
      ({
        chunkId: String(i),
        contextualText,
        tokens: contextualText.split(' '),
      }) as RagChunk,
  );
  let embeddings = 0;
  const api = createClovaApi('fixture', async (url) => {
    if (String(url).includes('/embedding/')) {
      embeddings++;
      return success({
        embedding: [1, ...Array(1023).fill(0)],
        inputTokens: 1,
      });
    }
    return success({ citedDocuments: [], result: '조작된 값 900원' });
  });
  const context = { question: '수학은 언제?', rerank: 'always' as const };
  await createClovaSearch(api, directory, 'hybrid', 0).rank(
    chunks,
    '수학',
    context,
  );
  assert.equal(embeddings, 3);
  const result = await createClovaSearch(api, directory, 'gate', 0).rank(
    chunks,
    '수학',
    context,
  );
  assert.deepEqual(result, []);
  assert.equal(embeddings, 3);

  const malicious = createClovaApi('fixture', async () =>
    success({
      citedDocuments: [{ id: 'out-of-scope' }],
    }),
  );
  await assert.rejects(
    createClovaSearch(malicious, directory, 'rerank', 0).rank(
      chunks,
      '수학',
      context,
    ),
    /unknown document/,
  );
});

test('HCX-005 reads only scan pages in a mixed PDF and leaves conflicting cells blank for review', async () => {
  let reads = 0;
  const api = createClovaApi('fixture', async (url, init) => {
    assert.match(String(url), /HCX-005$/);
    const input = JSON.parse(String(init?.body));
    assert.equal(input.messages[1].content[0].type, 'image_url');
    assert.ok(input.messages[1].content[0].dataUri.data.length > 500);
    const rows = [
      ['반', '수강료'],
      ['수학', ++reads === 1 ? '25만원' : '28만원'],
    ];
    return success({
      finishReason: 'stop',
      message: {
        content: JSON.stringify([{ kind: 'table', rows }]),
      },
    });
  });
  const bytes = await readFile(
    new URL(
      '../__fixtures__/documents-v1/documents/PX_MIXED__r1.pdf',
      import.meta.url,
    ),
  );
  const { text, pages, warnings } = await parseSourceFile({
    bytes,
    fileName: 'mixed.pdf',
    vision: createClovaScanVision(api),
  });
  assert.equal(reads, 2);
  assert.deepEqual(
    pages.map(({ method }) => method),
    ['text', 'ocr'],
  );
  assert.ok(text.includes(scanReviewMarker));
  assert.doesNotMatch(text, /25만원|28만원/);
  assert.ok(
    warnings.some(
      (w) =>
        w.code === 'vision_review' &&
        w.page === 2 &&
        w.detail?.includes('2행 2열'),
    ),
  );
});
