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
    assert.equal(body.maxTokens, 4096);
    assert.equal(body.maxCompletionTokens, undefined);
    assert.doesNotMatch(
      body.messages[1].content[1].text,
      /numeric_target|accepted_texts|student_ref|teacher_test/,
    );
    assert.match(body.messages[0].content, /오류를 고치지/);
    return Response.json({
      result: {
        message: {
          content: JSON.stringify({
            items: [{ ...reading(a.items[0]), item_ref: 'i001' }],
          }),
        },
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

test('HCX-007 uses its actual token parameter and structured outputs for reports and semantic grading', async () => {
  const seen: string[] = [];
  const def = item('KOR', { answer_type: 'text_semantic' });
  const provider = createNaverGrader(env, undefined, (async (url, init) => {
    assert.ok(String(url).endsWith('/HCX-007'));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.maxTokens, undefined);
    assert.equal(body.maxCompletionTokens, 4096);
    assert.deepEqual(body.thinking, { effort: 'none' });
    assert.equal(body.responseFormat.type, 'json');
    const shape = body.responseFormat.schema.properties;
    seen.push(Object.keys(shape)[0]);
    const content = shape.scores ? { scores: [] } : { observations: [] };
    return Response.json({
      result: { message: { content: JSON.stringify(content) } },
    });
  }) as typeof fetch);
  await provider.semantic!(def, reading(def));
  await provider.report!({ facts: [] });
  assert.deepEqual(seen, ['scores', 'observations']);
});

test('invalid credentials stop later page/crop/report calls and non-JSON bodies fail without echo', async () => {
  let calls = 0;
  const provider = createNaverGrader(env, undefined, (async () => {
    calls++;
    return new Response('private provider response', { status: 401 });
  }) as typeof fetch);
  await assert.rejects(
    provider.read([{ ...photo(), page_no: 1 }], definition()),
    /PROVIDER_AUTHENTICATION_FAILED/,
  );
  await assert.rejects(
    provider.report!({ facts: [] }),
    /PROVIDER_AUTHENTICATION_FAILED/,
  );
  assert.equal(calls, 1);
  const invalid = createNaverGrader(
    env,
    undefined,
    (async () => new Response('private invalid JSON')) as typeof fetch,
  );
  await assert.rejects(
    invalid.report!({ facts: [] }),
    (error) =>
      error instanceof Error && error.message === 'PROVIDER_INVALID_OUTPUT',
  );
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

test('vision aliases are reversible and one bad page does not erase another page', async () => {
  const a = definition();
  a.items.push({ ...item('ENG'), item_no: '2', expected_page_no: 2 });
  let calls = 0;
  const provider = createNaverGrader(env, undefined, (async (_url, init) => {
    calls++;
    const data = JSON.parse(
      JSON.parse(String(init?.body)).messages[1].content[1].text,
    );
    assert.equal(data.manifest[0].item_ref, 'i001');
    assert.ok(!JSON.stringify(data).includes(a.items[1].item_ref));
    if (data.page_no === 1)
      return Response.json({
        result: { message: { content: 'invalid JSON' } },
      });
    return Response.json({
      result: {
        message: {
          content: JSON.stringify({
            items: [{ ...reading(a.items[1]), item_ref: 'i001' }],
          }),
        },
      },
    });
  }) as typeof fetch);
  const result = await provider.read(
    [
      { ...photo(), page_no: 1 },
      { ...photo(), page_no: 2 },
    ],
    a,
  );
  assert.equal(calls, 2);
  assert.equal(result[0].item_ref, a.items[0].item_ref);
  assert.equal(result[0].answer_status, 'unreadable');
  assert.equal(result[1].item_ref, a.items[1].item_ref);
  assert.equal(result[1].answer_observed, 'went');
});

test('single-image source binds the page number and literal verification uses a separate instruction', async () => {
  const a = definition();
  a.items[0].expected_page_no = 3;
  const instructions: string[] = [];
  const provider = createNaverGrader(env, undefined, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    instructions.push(body.messages[0].content);
    // A page index hallucination cannot move this request's image to a different page.
    return Response.json({
      result: {
        message: {
          content: JSON.stringify({
            items: [
              {
                ...reading(a.items[0]),
                item_ref: 'i001',
                regions: [{ page_no: 1, bbox: [0, 0, 1, 1] }],
              },
            ],
          }),
        },
      },
    });
  }) as typeof fetch);
  const page = { ...photo(), page_no: 3 };
  assert.equal((await provider.read([page], a))[0].regions[0].page_no, 3);
  await provider.verifyPage!(page, a);
  assert.notEqual(instructions[0], instructions[1]);
  assert.match(instructions[1], /문자 검증/);
});

test('serialization repair preserves LaTeX literals but never accepts a truncated provider response', async () => {
  const a = definition();
  const data = JSON.stringify({
    items: [{ ...reading(a.items[0], '\\frac{1}{2}'), item_ref: 'i001' }],
  }).slice(0, -1);
  const provider = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: { finishReason: 'stop', message: { content: data } },
    })) as typeof fetch);
  assert.equal(
    (await provider.read([{ ...photo(), page_no: 1 }], a))[0].answer_observed,
    '\\frac{1}{2}',
  );
  const cut = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: { finishReason: 'length', message: { content: data } },
    })) as typeof fetch);
  await assert.rejects(
    cut.read([{ ...photo(), page_no: 1 }], a),
    /PROVIDER_INVALID_OUTPUT/,
  );
});

test('malformed items are isolated and unknown aliases are never attached to a registered item', async () => {
  const a = definition();
  a.items.push({ ...item(), item_no: '2' });
  const provider = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: {
        message: {
          content: JSON.stringify({
            items: [
              { ...reading(a.items[0]), item_ref: 'i001' },
              { item_ref: 'i002', answer_status: 'guessed' },
            ],
          }),
        },
      },
    })) as typeof fetch);
  const result = await provider.read([{ ...photo(), page_no: 1 }], a);
  assert.equal(result.length, 1);
  assert.equal(result[0].item_ref, a.items[0].item_ref);
  const unknown = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: {
        message: {
          content: JSON.stringify({
            items: [{ ...reading(a.items[0]), item_ref: 'unknown_item' }],
          }),
        },
      },
    })) as typeof fetch);
  await assert.rejects(
    unknown.read([{ ...photo(), page_no: 1 }], a),
    /PROVIDER_INVALID_OUTPUT/,
  );
});

test('report fact aliases and semantic criterion aliases restore only the supplied sources', async () => {
  const def = item('KOR', { answer_type: 'text_semantic' });
  const provider = createNaverGrader(env, undefined, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)),
      data = JSON.parse(body.messages[1].content);
    const content = data.criteria
      ? {
          scores: [
            {
              criterion_id: data.criteria[0].criterion_id,
              score: '2',
              quote: '안 한다',
            },
          ],
        }
      : {
          observations: [
            {
              claim_type: 'observed_rate',
              fact_ids: [data.facts[0].fact_id],
              template_key: 'rate',
            },
          ],
        };
    assert.doesNotMatch(body.messages[1].content, /original_fact_id|actual_id/);
    return Response.json({
      result: { message: { content: JSON.stringify(content) } },
    });
  }) as typeof fetch);
  const scores = await provider.semantic!(def, reading(def));
  assert.equal(scores[0].criterion_id, def.criteria[0].criterion_id);
  assert.deepEqual(
    await provider.report!({
      facts: [{ fact_id: 'original_fact_id', n_evaluable: 1 }],
    }),
    {
      observations: [
        {
          claim_type: 'observed_rate',
          fact_ids: ['original_fact_id'],
          template_key: 'rate',
        },
      ],
    },
  );
  const bad = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: {
        message: {
          content: JSON.stringify({
            observations: [
              {
                claim_type: 'observed_rate',
                fact_ids: ['f999'],
                template_key: 'rate',
              },
            ],
          }),
        },
      },
    })) as typeof fetch);
  await assert.rejects(
    bad.report!({ facts: [{ fact_id: 'original_fact_id' }] }),
    /REPORT_EVIDENCE_MISMATCH/,
  );
});

test('a malformed duplicate cannot disappear and make a valid-looking item safe to grade', async () => {
  const a = definition();
  const provider = createNaverGrader(env, undefined, (async () =>
    Response.json({
      result: {
        message: {
          content: JSON.stringify({
            items: [
              { ...reading(a.items[0]), item_ref: 'i001' },
              { item_ref: 'i001', answer_status: 'invalid' },
            ],
          }),
        },
      },
    })) as typeof fetch);
  const result = await provider.read([{ ...photo(), page_no: 1 }], a);
  assert.equal(result.length, 1);
  assert.ok(result[0].ambiguity_codes.includes('ASSOCIATION_AMBIGUOUS'));
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
