import assert from 'node:assert/strict';
import test from 'node:test';
import { compareMathReadings } from './read-image.mjs';

test('수학 전사의 표기 차이는 허용하고 지수·밑·부호 차이와 불명은 보류한다', () => {
  assert.equal(compareMathReadings('a³ − b³', '$a ^ { 3 } - b^3$'), null);
  for (const read of [
    'a⁶ − b³',
    'a³ − c³',
    'a³ + b³',
    'a3 − b3',
    'a³ − [불명]',
  ]) {
    assert.ok(compareMathReadings('a³ − b³', read));
  }
  assert.ok(compareMathReadings('[불명]', '[불명]'));
});
import {
  assignmentSchema,
  clovaOutputSchema,
  verifyResponse,
  makeHandoff,
} from './classify.mjs';

test('CLOVA에 보내는 스키마는 판정한 문항의 reasoning이 필수임을 설명으로 알린다', () => {
  for (const subject of ['M', 'E']) {
    const schema = clovaOutputSchema(subject) as unknown as {
      properties: {
        items: {
          items: {
            anyOf: {
              required: string[];
              properties: { reasoning: { description: string } };
            }[];
          };
        };
      };
    };
    for (const variant of schema.properties.items.items.anyOf) {
      assert.match(variant.properties.reasoning.description, /\S/);
      assert.ok(variant.required.includes('reasoning'));
    }
  }
});

const assignment = {
  assignmentId: 'test',
  subject: 'M',
  items: [
    {
      itemId: 'q1',
      page: 1,
      displayNumber: '1',
      text: '직선의 식을 구하시오.',
    },
  ],
};
const valid = {
  tagId: 'math-05',
  status: 'adopted',
  quote: '직선의 식',
  action: '표현 변환',
  reason: '',
};
const inferred = { ...valid, tagId: 'math-02', quote: '주어지지 않은 식' };
const response = (tags: (typeof valid)[]) => ({
  items: [
    {
      itemId: 'q1',
      disposition: 'assessed',
      reasoning: '문항 단서 대조',
      tags,
    },
  ],
});
test('원문에 없는 단서만 보류하고, 반복 일치 수와 공개 필드를 확인한다', () => {
  const first = verifyResponse(assignment, response([valid, inferred]));
  const other = verifyResponse(assignment, response([valid]));
  const item = makeHandoff(
    assignment,
    [first, other, other],
    '2026-11-12T00:00:00Z',
  ).items[0];
  assert.deepEqual(item.tags, [
    {
      tagId: 'math-05',
      status: 'adopted',
      evidenceKind: 'text',
      agreement: { same: 3, runs: 3 },
    },
    {
      tagId: 'math-02',
      status: 'held',
      evidenceKind: 'text',
      agreement: { same: 1, runs: 3 },
    },
  ]);
  const withheld = verifyResponse(assignment, response([inferred]));
  const heldItem = makeHandoff(assignment, [withheld], '2026-11-12T00:00:00Z')
    .items[0];
  assert.equal(heldItem.itemStatus, 'no_adopted');
  assert.deepEqual(heldItem.tags, []);
});
test('식별자 충돌 및 다른 과목 태그는 거절한다', () => {
  assert.throws(() =>
    assignmentSchema.parse({
      ...assignment,
      items: [...assignment.items, { ...assignment.items[0], itemId: 'q2' }],
    }),
  );
  assert.throws(() =>
    verifyResponse({ ...assignment, subject: 'E' }, response([valid])),
  );
});

test('행동을 판정하고 태그를 누락한 응답은 거절하고, 근거 부족은 기존 no_adopted로 전달한다', () => {
  assert.throws(() => verifyResponse(assignment, response([])));
  const unclear = {
    ...response([]).items[0],
    disposition: 'insufficient_evidence',
    reasoning: '문항이 참조하는 그래프가 없어 필요한 행동을 특정할 수 없다.',
  };
  const run = verifyResponse(assignment, { items: [unclear] });
  const item = makeHandoff(assignment, [run], '2026-11-12T00:00:00Z').items[0];
  assert.equal(item.itemStatus, 'no_adopted');
  assert.deepEqual(item.tags, []);
});
