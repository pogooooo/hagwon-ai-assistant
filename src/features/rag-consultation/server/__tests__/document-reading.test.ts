import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { runQuery } from './helpers.ts';
import { documentRequirements } from '../answer/document-reading.ts';
import { createOperationsGeneration } from '../../../academy-operations/runtime-generation.ts';
import type { GenerationInput, GenerationPort } from '../ports.ts';
import type { AcademyCatalog, RagAccessScope } from '../types.ts';
import { loadSuite, prepareSuite, runCase } from '../eval/harness.ts';
import { VARIANTS } from '../eval/variants.ts';

const access: RagAccessScope = {
  actorId: 'v',
  academyId: 'A',
  role: 'visitor',
  allowedStudentIds: [],
  allowedClassIds: [],
  studentRefs: [],
  canViewPublicHistory: false,
};
const catalog: AcademyCatalog = {
  academyId: 'A',
  displayName: '솔길',
  aliases: [],
  classes: [],
  units: [],
};
async function setup(reply: (input: GenerationInput) => unknown) {
  const store = new InMemoryRagStore();
  const inputs: GenerationInput[] = [];
  const generation: GenerationPort = {
    providerId: 'clova:HCX-007',
    isExternal: true,
    personalDataApproved: false,
    availability: () => 'available',
    generateGroundedAnswer: async (input) => {
      inputs.push(input);
      return { ok: true, rawText: JSON.stringify(reply(input)) };
    },
  };
  const register = (
    id: string,
    text: string,
    options: {
      visibility?: 'academy_public' | 'staff_only';
      approve?: boolean;
      validTo?: string;
    } = {},
  ) =>
    store.upsertIndexedRevision({
      approve: options.approve ?? true,
      document: {
        academyId: 'A',
        documentId: id,
        revision: 1,
        documentType: 'academy_info',
        title: id,
        text,
        visibility: options.visibility ?? 'academy_public',
        validFrom: '2026-01-01T00:00:00+09:00',
        approvedAt: '2026-01-01T00:00:00+09:00',
        validTo: options.validTo,
      },
    });
  const ask = (question: string) =>
    runQuery(
      {
        store,
        catalog: { getAcademyCatalog: async () => catalog },
        resolveScope: () => access,
      },
      {
        question,
        asOf: '2026-11-17T12:00:00+09:00',
        userId: 'v',
        engine: 'planned',
        generation,
      },
    );
  return { store, register, ask, inputs };
}
const reading = (i: GenerationInput) => ({
  question: i.question,
  ambiguous: false,
  items: i.requirements!.map((request) => ({
    request,
    complete: true,
    quotes: i.sources.map((s) => ({ sourceId: s.sourceId, quote: s.text })),
  })),
});

test('full question and every request survive model extraction; original paragraphs retain conditions', async () => {
  const env = await setup(reading);
  await env.register(
    'facility',
    '## 시설\n공간은 별관 3층입니다. 운영 시간은 평일 14:00~18:00이며 공휴일은 제외합니다.',
  );
  const r = await env.ask('공간 위치와 운영 시간은?');
  assert.equal(r.answer.status, 'answered');
  assert.match(r.answer.answer, /3층/);
  assert.match(r.answer.answer, /14:00~18:00/);
  assert.match(r.answer.answer, /공휴일은 제외/);
  assert.equal(r.answer.citations[0].documentId, 'facility');
  assert.ok(r.answer.citations[0].location);
  assert.deepEqual(
    env.inputs[0].requirements,
    documentRequirements('공간 위치와 운영 시간은?'),
  );
});

test('a specialized parking shortcut must not consume the other compound requirement', async () => {
  const env = await setup(reading);
  await env.register('address', '## 위치\n학원 주소는 구름로 85, 7층입니다.');
  await env.register('parking', '## 주차\n주차는 건물 뒤에서 80분 무료입니다.');
  const result = await env.ask('학원 주소와 주차 무료 시간은?');
  assert.equal(result.answer.status, 'answered');
  assert.match(result.answer.answer, /구름로 85/);
  assert.match(result.answer.answer, /80분/);
  assert.equal(env.inputs.length, 1);
  assert.deepEqual(
    new Set(result.answer.citations.map((c) => c.documentId)),
    new Set(['address', 'parking']),
  );
});
for (const fault of [
  'omitted-request',
  'invented-request',
  'altered-quote',
  'unknown-source',
  'duplicate-request',
  'ambiguous',
])
  test('invalid model reading is rejected: ' + fault, async () => {
    const env = await setup((i) => {
      const r = reading(i);
      if (fault === 'omitted-request') r.items.pop();
      if (fault === 'invented-request') r.items[0].request = '등록 마감일';
      if (fault === 'altered-quote')
        r.items[0].quotes[0].quote = '가격 9,900원';
      if (fault === 'unknown-source') r.items[0].quotes[0].sourceId = '999';
      if (fault === 'duplicate-request') r.items[1] = r.items[0];
      if (fault === 'ambiguous') r.ambiguous = true;
      return r;
    });
    await env.register(
      'fixture',
      '## 공간\n공간 위치는 3층이고 운영 시간은 14:00~18:00입니다.',
    );
    const r = await env.ask('공간 위치와 운영 시간은?');
    assert.equal(r.answer.status, 'abstained');
    assert.equal(r.answer.citations.length, 0);
  });
test('a missing requested attribute stays partial even when another paragraph is citable', async () => {
  const env = await setup((i) => {
    const r = reading(i);
    r.items[1].quotes = [];
    r.items[1].complete = false;
    return r;
  });
  await env.register('fixture', '## 공간\n공간 위치는 3층입니다.');
  const r = await env.ask('공간 위치와 운영 시간은?');
  assert.equal(r.answer.status, 'partial');
  assert.match(r.answer.answer, /확인되지 않은 항목/);
  assert.match(r.answer.answer, /3층/);
});
test('no evidence is not rendered as a negative answer or a related location', async () => {
  const env = await setup((i) => ({
    question: i.question,
    ambiguous: false,
    items: i.requirements!.map((request) => ({
      request,
      complete: false,
      quotes: [],
    })),
  }));
  await env.register('fixture', '## 공간\n공간 위치는 3층입니다.');
  const r = await env.ask('공간에서 식사해도 되나요?');
  assert.equal(r.answer.status, 'abstained');
  assert.doesNotMatch(r.answer.answer, /3층/);
});
test('unapproved, staff-only and expired records never enter public reader input', async () => {
  const env = await setup(reading);
  await env.register('public', '## 공간\n공간 위치는 3층입니다.');
  await env.register('private', '## 공간\n공간 암호 7788', {
    visibility: 'staff_only',
  });
  await env.register('draft', '## 공간\n공간 암호 9988', { approve: false });
  await env.register('old', '## 공간\n공간 암호 1122', {
    validTo: '2026-01-31T00:00:00+09:00',
  });
  await env.ask('공간 위치는?');
  assert.equal(env.inputs.length, 1);
  assert.doesNotMatch(JSON.stringify(env.inputs), /7788|9988|1122/);
});
test('revocation during inference removes the final answer and citation', async () => {
  const env = await setup(reading);
  await env.register('public', '## 공간\n공간 위치는 3층입니다.');
  const original = env.store.searchApprovedChunks.bind(env.store);
  env.store.searchApprovedChunks = async (q) => {
    const found = await original(q);
    await env.store.revokeRevision({
      academyId: 'A',
      documentId: 'public',
      reason: 'revoked',
    });
    return found;
  };
  const r = await env.ask('공간 위치는?');
  assert.equal(r.answer.status, 'abstained');
  assert.equal(r.answer.citations.length, 0);
});
test('NAVER call budget persists across provider recreation and rejects Gemini configuration', async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const fetchImpl: typeof fetch = async (url) => {
    assert.match(String(url), /^https:\/\/clovastudio\.stream\.ntruss\.com\//);
    calls++;
    return Response.json({
      status: { code: '20000' },
      result: { finishReason: 'stop', message: { content: '{}' } },
    });
  };
  const env = {
    RAG_CLOVA_API_KEY: 'synthetic-key',
    RAG_GEMINI_API_KEY: 'unused',
    RAG_GENERATION_PROVIDER: 'gemini',
    RAG_GENERATION_DAILY_CALL_LIMIT: '1',
  };
  const input: GenerationInput = {
    requestId: 'test',
    question: '안내',
    facts: [],
    sources: [],
    containsPersonalData: false,
  };
  assert.equal(
    (
      await createOperationsGeneration(
        env,
        fetchImpl,
        db,
      ).generateGroundedAnswer(input, { now: Date.now(), timeoutMs: 1000 })
    ).ok,
    true,
  );
  assert.equal(
    (
      await createOperationsGeneration(
        env,
        fetchImpl,
        db,
      ).generateGroundedAnswer(input, { now: Date.now(), timeoutMs: 1000 })
    ).ok,
    false,
  );
  assert.equal(calls, 1);
  db.close();
});

test('public rule tables retain row evidence while unrelated prose stays excluded', async () => {
  const env = await setup(reading);
  await env.register(
    'rules',
    '## 인쇄 안내\n| 항목 | 기준 |\n|---|---|\n| 흑백 인쇄 | 1장 70원 |',
  );
  const result = await env.ask('흑백 인쇄 비용은?');
  assert.equal(result.answer.status, 'answered');
  assert.match(result.answer.answer, /70원/);
  assert.equal(result.answer.citations[0].documentId, 'rules');
  assert.ok(result.answer.citations[0].location);
});

test('an implicit student class cannot be widened to all public classes', async () => {
  const store = new InMemoryRagStore();
  let calls = 0;
  const generation: GenerationPort = {
    providerId: 'clova:HCX-007',
    isExternal: true,
    personalDataApproved: false,
    availability: () => 'available',
    generateGroundedAnswer: async () => {
      calls++;
      return { ok: false, error: 'server_error' };
    },
  };
  const learner = {
    ...access,
    role: 'student' as const,
    allowedStudentIds: ['S'],
    allowedClassIds: ['C'],
    studentRefs: [
      { studentId: 'S', displayLabel: '학생', aliases: [], classIds: ['C'] },
    ],
  };
  await runQuery(
    {
      store,
      catalog: {
        getAcademyCatalog: async () => ({
          ...catalog,
          classes: [{ classId: 'C', name: '초급반', aliases: [] }],
        }),
      },
      resolveScope: () => learner,
    },
    {
      question: '수업 무슨 요일 몇 시에 있어요?',
      asOf: '2026-11-17T12:00:00+09:00',
      userId: 'v',
      engine: 'planned',
      generation,
    },
  );
  assert.equal(calls, 0);
});

for (const [suiteId, ids] of [
  ['v1-90', ['GA-012']],
  ['v1-paraphrase-100', ['MS-051', 'MS-077', 'MS-081']],
  ['v2-dev', ['HK-D-025', 'HK-D-115']],
  ['v2-test', ['OS-T-107']],
] as const) {
  test('NAVER reading preserves scoped decisions: ' + suiteId, async () => {
    const suite = loadSuite(suiteId);
    const variant = VARIANTS['engine-planned'];
    const prepared = await prepareSuite(suite, variant);
    let calls = 0;
    const generation: GenerationPort = {
      providerId: 'clova:HCX-007',
      isExternal: true,
      personalDataApproved: false,
      availability: () => 'available',
      generateGroundedAnswer: async () => {
        calls++;
        return { ok: false, error: 'server_error' };
      },
    };
    for (const id of ids) {
      const fixture = suite.cases.find((c) => c.id === id);
      assert.ok(fixture);
      const result = await runCase(prepared, variant, fixture, { generation });
      if (id === 'OS-T-107') {
        // Existing OCR uncertainty is a known abstention, not a passing answer.
        assert.equal(result.status, 'abstained');
        assert.equal(result.generationCalls, 0);
      } else assert.equal(result.correct, true, id + ': ' + result.answer);
      assert.deepEqual(result.violations, []);
    }
    assert.equal(calls, 0);
  });
}
