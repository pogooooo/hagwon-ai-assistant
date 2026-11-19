import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createNaverGrader } from './provider.ts';
import { item, photo, reading } from './test-fixtures.ts';
import type { Assignment } from './contracts.ts';

function definition(): Assignment {
  const i = item();
  return {
    title: 'synthetic',
    class_id: 'class_test',
    rights_ref: 'rights_synthetic',
    items: [i],
    assignment_id: 'assignment_test',
    assignment_version: 1,
    tenant_id: 'tenant_test',
    approved_by: 'teacher_test',
    approved_at: '2026-11-19T00:00:00Z',
  };
}
const env = {
  CLOVA_STUDIO_API_KEY: 'test-only-key',
  AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
  AXR_GRADING_INPUT_POLICY_REF: 'synthetic-policy-only',
  RAG_GENERATION_DAILY_CALL_LIMIT: '2',
};
test('NAVER adapter sends only the item manifest to vision and enforces the shared daily cap', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let calls = 0;
  const a = definition();
  const provider = createNaverGrader(env, db, (async (url, init) => {
    calls++;
    assert.equal(
      new URL(String(url)).hostname,
      'clovastudio.stream.ntruss.com',
    );
    assert.ok(String(url).endsWith('/HCX-005'));
    const body = JSON.parse(String(init?.body));
    assert.doesNotMatch(
      body.messages[1].content[1].text,
      /numeric_target|accepted_texts|student_ref|teacher_test/,
    );
    assert.match(body.messages[0].content, /오류를 고치지/);
    return Response.json({
      result: {
        message: { content: JSON.stringify({ items: [reading(a.items[0])] }) },
        finishReason: 'stop',
      },
    });
  }) as typeof fetch);
  const page = { ...photo(), page_no: 1 };
  assert.equal((await provider.read([page], a)).length, 1);
  await provider.check!(page, a.items[0]);
  await assert.rejects(provider.read([page], a), /PROVIDER_RATE_LIMIT/);
  assert.equal(calls, 2);
});
test('missing deployment input approval performs no outbound calls', async () => {
  let calls = 0;
  const provider = createNaverGrader(
    { CLOVA_STUDIO_API_KEY: 'test-only-key' },
    undefined,
    (async () => {
      calls++;
      throw new Error('must not call');
    }) as typeof fetch,
  );
  assert.equal(provider.inputAllowed, false);
  await assert.rejects(
    provider.read([{ ...photo(), page_no: 1 }], definition()),
    /PROVIDER_INPUT_NOT_APPROVED/,
  );
  assert.equal(calls, 0);
});
test('provider failures, truncated JSON and fabricated semantic quotes are rejected without raw error echo', async () => {
  const def = item('KOR', { answer_type: 'text_semantic' });
  const provider = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: {
        message: {
          content: JSON.stringify({
            scores: [
              {
                criterion_id: def.criteria[0].criterion_id,
                score: '2',
                quote: 'not in actual answer',
              },
            ],
          }),
        },
      },
    })) as typeof fetch);
  await assert.rejects(
    provider.semantic!(def, reading(def)),
    /UNSUPPORTED_EVIDENCE/,
  );
  const truncated = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: { finishReason: 'length', message: { content: '{"items":[]}' } },
    })) as typeof fetch);
  await assert.rejects(
    truncated.read([{ ...photo(), page_no: 1 }], definition()),
    /PROVIDER_INVALID_OUTPUT/,
  );
  const failed = createNaverGrader(
    env,
    undefined,
    (async () =>
      new Response('private response must not appear', {
        status: 500,
      })) as typeof fetch,
  );
  await assert.rejects(
    failed.read([{ ...photo(), page_no: 1 }], definition()),
    (error) =>
      error instanceof Error && error.message === 'PROVIDER_TEMPORARY_FAILURE',
  );
});
