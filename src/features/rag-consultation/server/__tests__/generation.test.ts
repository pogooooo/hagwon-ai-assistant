/**
 * 생성 경로·외부 API 장애·출력 검증 테스트(E21, E35).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InMemoryHandoffStore } from '../adapters/memory/index.ts';
import { analysisReportToIndexInput } from '../events.ts';
import {
  createOpenAICompatibleProvider,
  DisabledGenerationProvider,
  GuardedGenerationProvider,
  MockGenerationProvider,
  type MockGenerationBehavior,
} from '../generation/providers.ts';
import type { GenerationInput, GenerationPort } from '../ports.ts';
import { parseInstant } from '../text/time.ts';
import { freshEnv, runQuery, sharedEnv } from './helpers.ts';

const env = await sharedEnv();
const asOf = '2026-11-01T18:00:00+09:00';
const now = parseInstant(asOf);
const adviceQuestion = 'A01 학습 방향을 조언해줘';

describe('학습 방향 상담(최대 1회 생성)', () => {
  test('정상: 1회 호출, 대상 학생 사실만 가명으로 전달, 인용은 전달한 출처만', async () => {
    const mock = new MockGenerationProvider('ok');
    const result = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: mock,
    });
    assert.equal(result.answer.status, 'answered');
    assert.equal(mock.calls.length, 1);
    const input = mock.calls[0];
    assert.deepEqual(input.facts.map((fact) => fact.factId).sort(), [
      'F_S1_FUNC',
      'F_S1_OCT',
    ]);
    assert.ok(input.facts.every((fact) => fact.subjectLabel === '학생'));
    assert.ok(
      !JSON.stringify(input).includes('A01'),
      '모델 입력에 학생 식별자가 그대로 포함됨',
    );
    assert.ok(!JSON.stringify(input).includes('A02'));
    assert.ok(
      result.answer.citations.every((c) =>
        ['D_S1_OCT:r1:body', 'D_S1_MATH:r1:body'].includes(c.sourceId),
      ),
    );
    assert.match(result.answer.answer, /20문항 중 13문항 정답/);
  });

  test('없는 월 또는 연도의 학습 기록을 최신 리포트로 대체하지 않는다', async () => {
    const mock = new MockGenerationProvider('ok');
    for (const question of [
      'A01 8월 리포트 기준으로 학습 방향을 조언해줘',
      'A01 2025년 10월 리포트 기준으로 학습 방향을 조언해줘',
      'A01 이번 달 리포트 기준으로 학습 방향을 조언해줘',
    ]) {
      const result = await runQuery(env, {
        userId: 'GUARDIAN_A',
        question,
        asOf,
        generation: mock,
      });
      assert.equal(result.answer.status, 'abstained', question);
      assert.deepEqual(result.answer.citations, []);
    }
    const previous = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: 'A01 지난달 리포트 기준으로 학습 방향을 조언해줘',
      asOf,
      generation: mock,
    });
    assert.equal(previous.answer.status, 'answered');
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].facts.every(({ period }) => period === '2026-10'));
  });

  test('기록에 표시한 사실은 각각 인용하고 생성 문장의 숫자는 모델이 인용한 출처로 검증한다', async () => {
    const provider: GenerationPort = {
      providerId: 'selective-citation-test',
      isExternal: false,
      personalDataApproved: false,
      availability: () => 'available',
      async generateGroundedAnswer() {
        return {
          ok: true,
          rawText: JSON.stringify({
            status: 'answered',
            answer: '일차방정식의 풀이 과정을 다시 확인해 보세요.',
            cited_source_ids: ['D_S1_OCT:r1:body'],
          }),
        };
      },
    };
    const valid = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: provider,
    });
    assert.equal(valid.answer.status, 'answered');
    assert.deepEqual(
      valid.answer.citations.map(({ sourceId }) => sourceId).sort(),
      ['D_S1_MATH:r1:body', 'D_S1_OCT:r1:body'],
    );
    assert.match(valid.answer.answer, /9문항/);

    provider.generateGroundedAnswer = async () => ({
      ok: true,
      rawText: JSON.stringify({
        status: 'answered',
        answer: '일차방정식에서 9문항을 맞힌 풀이를 확인해 보세요.',
        cited_source_ids: ['D_S1_OCT:r1:body'],
      }),
    });
    const wrong = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: provider,
    });
    assert.equal(wrong.answer.status, 'handoff');
    assert.equal(wrong.answer.handoff?.reasonCode, 'GENERATION_REJECTED');
    assert.equal(wrong.generationCalls, 1);
    assert.deepEqual(wrong.answer.citations, []);
  });

  for (const behavior of [
    'rate_limited',
    'server_error',
    'timeout',
    'quota_exhausted',
  ] as MockGenerationBehavior[]) {
    test(`호출 실패(${behavior}): 재시도 없이 담당자 연결, 개인정보 없는 handoff 초안`, async () => {
      const mock = new MockGenerationProvider(behavior);
      const handoff = new InMemoryHandoffStore();
      const result = await runQuery(env, {
        userId: 'GUARDIAN_A',
        question: adviceQuestion,
        asOf,
        generation: new GuardedGenerationProvider(mock),
        handoff,
      });
      assert.equal(result.answer.status, 'handoff');
      assert.equal(result.answer.handoff?.reasonCode, 'GENERATION_UNAVAILABLE');
      assert.equal(mock.calls.length, 1, '재시도 루프 금지');
      assert.deepEqual(result.answer.citations, []);
      assert.equal(handoff.drafts.length, 1);
      assert.deepEqual(handoff.drafts[0].studentIds, ['ST_A01']);
    });
  }

  for (const behavior of [
    'invalid_json',
    'fake_citation',
    'unsupported_number',
    'mentions_other_student',
    'forbidden_claim',
    'unknown',
  ] as MockGenerationBehavior[]) {
    test(`출력 검증 실패(${behavior}): 답변을 내보내지 않고 담당자 연결`, async () => {
      const mock = new MockGenerationProvider(behavior);
      const result = await runQuery(env, {
        userId: 'GUARDIAN_A',
        question: adviceQuestion,
        asOf,
        generation: mock,
      });
      assert.equal(result.answer.status, 'handoff');
      assert.equal(result.answer.handoff?.reasonCode, 'GENERATION_REJECTED');
      assert.equal(mock.calls.length, 1);
      assert.ok(!result.answer.answer.includes('95%'));
      assert.ok(!result.answer.answer.includes('B01'));
      assert.ok(!result.answer.answer.includes('집중력'));
    });
  }

  test('429 이후에는 Retry-After 동안 호출 전에 차단(0회 호출)', async () => {
    const mock = new MockGenerationProvider('rate_limited');
    const guarded = new GuardedGenerationProvider(mock);
    await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: guarded,
    });
    assert.equal(guarded.availability(now + 1_000), 'rate_limited');
    mock.behavior = 'ok';
    const second = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: guarded,
    });
    assert.equal(second.answer.status, 'handoff');
    assert.equal(mock.calls.length, 1);
    assert.equal(guarded.availability(now + 31_000), 'available');
  });

  test('일일 호출 한도에 도달하면 쿼터 소진으로 보고 호출하지 않는다', async () => {
    const mock = new MockGenerationProvider('ok');
    const guarded = new GuardedGenerationProvider(mock, { dailyCallLimit: 1 });
    await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: guarded,
    });
    const second = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: guarded,
    });
    assert.equal(second.answer.status, 'handoff');
    assert.equal(mock.calls.length, 1);
  });

  test('개인정보 전송이 승인되지 않은 외부 공급자에는 호출하지 않는다', async () => {
    const calls: GenerationInput[] = [];
    const external: GenerationPort = {
      providerId: 'external-test',
      isExternal: true,
      personalDataApproved: false,
      availability: () => 'available',
      async generateGroundedAnswer(input) {
        calls.push(input);
        return { ok: true, rawText: '{}' };
      },
    };
    const result = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: external,
    });
    assert.equal(result.answer.status, 'handoff');
    assert.equal(
      result.answer.handoff?.reasonCode,
      'PERSONAL_DATA_TRANSFER_NOT_APPROVED',
    );
    assert.equal(calls.length, 0);
  });

  test('공급자 미선정(disabled) 상태에서도 정형 답변은 동작하고 상담은 담당자 연결', async () => {
    const disabled = new DisabledGenerationProvider();
    const fee = await runQuery(env, {
      userId: 'VISITOR_A',
      question: '중2 기본반 수강료?',
      asOf,
      generation: disabled,
    });
    assert.equal(fee.answer.status, 'answered');
    const score = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: 'A01 10월 정답률?',
      asOf,
      generation: disabled,
    });
    assert.equal(score.answer.status, 'answered');
    const advice = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: adviceQuestion,
      asOf,
      generation: disabled,
    });
    assert.equal(advice.answer.status, 'handoff');
  });

  test('보호자 복수 자녀: 대상 없이 상담 요청하면 생성하지 않고 확인 질문', async () => {
    const mock = new MockGenerationProvider('ok');
    const result = await runQuery(env, {
      userId: 'GUARDIAN_A',
      question: '학습 방향 조언해줘',
      asOf,
      generation: mock,
    });
    assert.equal(result.answer.status, 'clarify');
    assert.equal(mock.calls.length, 0);
  });
});

describe('충돌하는 승인 기록', () => {
  test('같은 학생·단원·기간에 다른 승인 값이 있으면 보류한다', async () => {
    const conflictEnv = await freshEnv();
    const base = {
      academyId: 'AC_A',
      studentId: 'ST_A01',
      period: '2026-10',
      title: '중복 리포트',
      publishedAt: '2026-10-31T09:00:00+09:00',
    };
    const other = analysisReportToIndexInput({
      ...base,
      reportId: 'RPT_DUP',
      revision: 1,
      units: [{ unitName: '일차방정식', correctCount: 11, questionCount: 20 }],
    });
    await conflictEnv.store.upsertIndexedRevision({ ...other, approve: true });
    const result = await runQuery(conflictEnv, {
      userId: 'GUARDIAN_A',
      question: 'A01의 10월 일차방정식 정답률은?',
      asOf,
    });
    assert.equal(result.answer.status, 'abstained');
    assert.equal(result.answer.handoff?.reasonCode, 'CONFLICTING_EVIDENCE');
  });
});

describe('OpenAI 호환 HTTP 어댑터(가짜 fetch)', () => {
  const input: GenerationInput = {
    requestId: 'r',
    question: 'q',
    facts: [],
    sources: [],
    containsPersonalData: false,
  };
  const make = (impl: typeof fetch) =>
    createOpenAICompatibleProvider({
      providerId: 't',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'k',
      model: 'm',
      fetchImpl: impl,
    });

  test('429 + Retry-After → rate_limited', async () => {
    const provider = make(
      async () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    );
    assert.deepEqual(
      await provider.generateGroundedAnswer(input, { timeoutMs: 1000, now }),
      {
        ok: false,
        error: 'rate_limited',
        retryAfterMs: 30_000,
      },
    );
  });

  test('5xx → server_error, 비정상 본문 → invalid_response', async () => {
    assert.deepEqual(
      await make(
        async () => new Response('', { status: 503 }),
      ).generateGroundedAnswer(input, { timeoutMs: 1000, now }),
      { ok: false, error: 'server_error' },
    );
    assert.deepEqual(
      await make(
        async () => new Response('{"choices":[]}', { status: 200 }),
      ).generateGroundedAnswer(input, { timeoutMs: 1000, now }),
      { ok: false, error: 'invalid_response' },
    );
  });

  test('타임아웃 → timeout', async () => {
    const provider = make(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    assert.deepEqual(
      await provider.generateGroundedAnswer(input, { timeoutMs: 10, now }),
      { ok: false, error: 'timeout' },
    );
  });

  test('정상 응답 → 본문 텍스트, 기본값은 외부·개인정보 미승인', async () => {
    const provider = make(
      async () =>
        new Response(
          '{"choices":[{"message":{"content":"{\\"status\\":\\"answered\\"}"}}]}',
          { status: 200 },
        ),
    );
    assert.equal(provider.isExternal, true);
    assert.equal(provider.personalDataApproved, false);
    assert.deepEqual(
      await provider.generateGroundedAnswer(input, { timeoutMs: 1000, now }),
      {
        ok: true,
        rawText: '{"status":"answered"}',
      },
    );
  });
});

test('기록된 지도 질문은 보고서 월과 지도 시행 월을 구분하고 생성하지 않는다', async () => {
  const academy = await freshEnv();
  const generation = new MockGenerationProvider('ok');
  const report = analysisReportToIndexInput({
    academyId: 'AC_A',
    studentId: 'ST_A01',
    reportId: 'RPT_GUIDANCE_SCOPE',
    revision: 1,
    period: '2026-10',
    title: '강사 확인 리포트',
    publishedAt: '2026-10-31T09:00:00+09:00',
    units: [{ unitName: '어휘', correctCount: 7, questionCount: 10 }],
  });
  const guidance = '11월에는 어려운 단어에 밑줄을 긋는 연습을 진행하겠습니다.';
  await academy.store.upsertIndexedRevision({
    approve: true,
    document: {
      ...report.document,
      text: report.document.text + '\n\n' + guidance,
    },
    facts: [
      ...report.facts,
      {
        ...report.facts[0],
        factId: 'F_GUIDANCE_SCOPE',
        factType: 'learning_guidance',
        value: { kind: 'text', text: guidance },
      },
    ],
  });
  const input = {
    engine: 'planned' as const,
    userId: 'GUARDIAN_A',
    asOf,
    generation,
  };
  const answer = await runQuery(academy, {
    ...input,
    question: 'A01 11월엔 수업 때 뭘 중점적으로 해주신대요?',
  });
  assert.equal(answer.answer.status, 'answered', answer.answer.answer);
  assert.match(answer.answer.answer, /밑줄/);
  assert.deepEqual(
    answer.answer.citations.map((citation) => citation.sourceId),
    ['RPT_GUIDANCE_SCOPE:r1:body'],
  );

  const missing = await runQuery(academy, {
    ...input,
    question: 'A01 11월 리포트에서는 뭘 하라고 했어요?',
  });
  assert.equal(missing.answer.status, 'abstained');
  assert.deepEqual(missing.answer.citations, []);
  assert.equal(generation.calls.length, 0);
});
