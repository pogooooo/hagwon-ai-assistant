import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSuite, prepareSuite, runCase } from '../eval/harness.ts';
import { createEvalGemini } from '../eval/live-generation.ts';
import { VARIANTS } from '../eval/variants.ts';
import { MockGenerationProvider } from '../generation/providers.ts';

const env = {
  RAG_GEMINI_API_KEY: 'fixture-transport-token',
  RAG_GEMINI_MODEL: 'fixture-model',
};
const variant = VARIANTS['engine-planned'];

test('평가용 Gemini 공급자는 실제 요청 경로와 예산을 계측하고 장애 문항은 모의 실행한다', async () => {
  const suite = loadSuite('v1-90');
  const prepared = await prepareSuite(suite, variant, { ocr: null });
  const advice = suite.cases.find(({ id }) => id === 'DO-019');
  assert.ok(advice);

  const session = createEvalGemini(
    'gemini-synthetic',
    1,
    env,
    async (url, options) => {
      assert.equal(
        String(url),
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
      const request = JSON.parse(String(options?.body));
      assert.equal(request.model, 'fixture-model');
      const data = JSON.parse(request.messages[1].content);
      assert.match(data.question, /학생/);
      assert.doesNotMatch(data.question, /문건우|건우/);
      assert.ok(data.facts.length);
      assert.ok(
        data.facts.every(
          (fact: { subject: string }) => fact.subject === '학생',
        ),
      );
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: 'answered',
                answer: '고전소설 단원부터 복습해 보세요.',
                cited_source_ids: [data.facts[0].source_id],
              }),
            },
          },
        ],
      });
    },
  );

  const result = await runCase(prepared, variant, advice, {
    generation: session.provider,
  });
  assert.equal(result.correct, true, result.answer);
  assert.equal(result.generationCalls, 1);
  assert.deepEqual(result.violations, []);
  assert.equal(session.report().liveRequests, 1);
  assert.equal(session.report().transportFailures, 0);

  const simulated = await runCase(
    prepared,
    variant,
    { ...advice, apiState: 'timeout' },
    { generation: session.provider },
  );
  assert.equal(simulated.status, 'handoff');
  assert.equal(simulated.generationCalls, 1);
  assert.equal(session.report().liveRequests, 1);

  const later = await runCase(
    prepared,
    variant,
    { ...advice, asOf: '2026-11-06T21:00:00+09:00' },
    { generation: session.provider },
  );
  assert.equal(later.status, 'handoff');
  assert.equal(later.generationCalls, 0);
  assert.equal(session.report().liveRequests, 1);
  assert.equal(session.report().budgetBlocks, 1);

  const replay = await runCase(
    prepared,
    variant,
    { ...advice, history: [advice.query] },
    { generation: new MockGenerationProvider() },
  );
  assert.equal(replay.generationCalls, 2);
  assert.equal(replay.checks.generation, false);
});

test('운영 정책에서는 학습기록을 Gemini로 전송하지 않고 승인 취약 영역을 인용한다', async () => {
  const suite = loadSuite('v1-90');
  const prepared = await prepareSuite(suite, variant, { ocr: null });
  const advice = suite.cases.find(({ id }) => id === 'DO-019');
  assert.ok(advice);
  const session = createEvalGemini('gemini', 1, env, async () => {
    assert.fail('personal learning records must not reach the transport');
  });
  const result = await runCase(prepared, variant, advice, {
    generation: session.provider,
  });
  assert.equal(result.status, 'answered', result.answer);
  assert.equal(result.correct, true);
  assert.match(result.answer, /고전소설.*장면 전환/);
  assert.match(result.answer, /복습 제안/);
  assert.deepEqual(result.cited, ['DO_RPT_STU006_KOR_202610:r1:body']);
  assert.match(
    result.sourceCoverage.citedLocations[0].location ?? '',
    /취약 영역/,
  );
  assert.equal(result.generationCalls, 0);
  assert.equal(session.report().liveRequests, 0);
});

test('Gemini 인증이 거부되면 같은 실행에서 추가 요청을 보내지 않는다', async () => {
  const session = createEvalGemini(
    'gemini',
    5,
    env,
    async () => new Response(null, { status: 401 }),
  );
  const request = {
    requestId: 'fixture',
    question: '테스트',
    facts: [],
    sources: [],
    containsPersonalData: false,
  };
  const options = { now: 0, timeoutMs: 1000 };
  const failure = await session.provider.generateGroundedAnswer(
    request,
    options,
  );
  assert.equal(failure.ok, false);
  assert.equal(session.provider.availability(0), 'unavailable');
  await session.provider.generateGroundedAnswer(request, options);
  assert.equal(session.report().liveRequests, 1);
  assert.equal(session.report().httpFailures, 1);
  assert.equal(session.report().authorizationFailed, true);
});
