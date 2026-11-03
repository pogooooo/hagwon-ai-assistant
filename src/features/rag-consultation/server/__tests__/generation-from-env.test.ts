import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenerationProviderFromEnv } from '../generation/from-env.ts';
import type { GenerationInput } from '../ports.ts';

const input: GenerationInput = {
  requestId: 'provider-test',
  question: '가상 학원의 안내 데스크는 몇 시에 열리나요?',
  facts: [],
  sources: [],
  containsPersonalData: false,
};
const callOptions = { timeoutMs: 1000, now: 0 };
const clovaUrl =
  'https://clovastudio.stream.ntruss.com/v1/openai/chat/completions';
const geminiUrl =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

test('자동 설정은 CLOVA가 준비되면 CLOVA, CLOVA 키가 없으면 Gemini를 선택한다', async () => {
  for (const { env, endpoint, key, model } of [
    {
      env: {
        RAG_GENERATION_PROVIDER: 'auto',
        RAG_CLOVA_API_KEY: 'test-clova',
        RAG_GEMINI_API_KEY: 'test-gemini',
      },
      endpoint: clovaUrl,
      key: 'test-clova',
      model: 'HCX-DASH-002',
    },
    {
      env: {
        RAG_CLOVA_API_KEY: 'test-clova',
        RAG_GEMINI_API_KEY: 'test-gemini',
      },
      endpoint: geminiUrl,
      key: 'test-gemini',
      model: 'gemini-3.5-flash-lite',
    },
    {
      env: {
        RAG_GENERATION_PROVIDER: 'gemini',
        RAG_CLOVA_API_KEY: 'test-clova',
        RAG_GEMINI_API_KEY: 'test-gemini',
        RAG_GEMINI_MODEL: 'gemini-3.8-flash',
      },
      endpoint: geminiUrl,
      key: 'test-gemini',
      model: 'gemini-3.8-flash',
    },
  ]) {
    const fetchStub: typeof fetch = async (url, init) => {
      assert.equal(url, endpoint);
      assert.equal(init?.method, 'POST');
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer ' + key,
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model);
      assert.equal(body.max_tokens, 400);
      assert.equal(body.messages[0].role, 'system');
      assert.equal(
        JSON.parse(body.messages[1].content).question,
        input.question,
      );
      return Response.json({ choices: [{ message: { content: 'example' } }] });
    };
    const provider = createGenerationProviderFromEnv(env, fetchStub);
    assert.equal(provider.isExternal, true);
    assert.deepEqual(
      await provider.generateGroundedAnswer(input, callOptions),
      {
        ok: true,
        rawText: 'example',
      },
    );
  }
});

test('키 없는 명시 설정, 공급자 미설정, 명시적 비활성은 외부 호출을 준비하지 않는다', () => {
  for (const env of [
    {},
    { RAG_GENERATION_PROVIDER: 'clova', RAG_GEMINI_API_KEY: 'test-gemini' },
    { RAG_GENERATION_PROVIDER: 'disabled', RAG_CLOVA_API_KEY: 'test-clova' },
  ]) {
    assert.equal(
      createGenerationProviderFromEnv(env).availability(0),
      'disabled',
    );
  }
});

test('CLOVA 호출 실패는 Gemini 재전송 없이 기존 장애 처리 경로로 반환한다', async () => {
  const calls: unknown[] = [];
  const provider = createGenerationProviderFromEnv(
    {
      RAG_GENERATION_PROVIDER: 'auto',
      RAG_CLOVA_API_KEY: 'test-clova',
      RAG_GEMINI_API_KEY: 'test-gemini',
    },
    async (url) => {
      calls.push(url);
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '3' },
      });
    },
  );
  assert.deepEqual(await provider.generateGroundedAnswer(input, callOptions), {
    ok: false,
    error: 'rate_limited',
    retryAfterMs: 3000,
  });
  assert.deepEqual(calls, [clovaUrl]);
  assert.equal(provider.availability(1), 'rate_limited');
});

test('CLOVA와 Gemini는 범용 승인 플래그가 있어도 개인 데이터의 전송을 거부한다', async () => {
  for (const providerName of ['clova', 'gemini']) {
    let calls = 0;
    const provider = createGenerationProviderFromEnv(
      {
        RAG_GENERATION_PROVIDER: providerName,
        RAG_CLOVA_API_KEY: 'test-clova',
        RAG_GEMINI_API_KEY: 'test-gemini',
        RAG_GENERATION_ALLOW_PERSONAL_DATA: 'true',
      },
      async () => {
        calls += 1;
        return new Response(null, { status: 500 });
      },
    );
    assert.equal(provider.personalDataApproved, false);
    assert.equal(
      (
        await provider.generateGroundedAnswer(
          { ...input, containsPersonalData: true },
          callOptions,
        )
      ).ok,
      false,
    );
    assert.equal(calls, 0);
  }
});
