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
  aliasItemIds,
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
test('반복 결과가 한 번이라도 갈린 태그는 보류로 전달한다', () => {
  const adopted = verifyResponse(assignment, response([valid]));
  const reference = verifyResponse(
    assignment,
    response([{ ...valid, status: 'reference' }]),
  );
  const item = makeHandoff(
    assignment,
    [adopted, reference, adopted],
    '2026-11-12T00:00:00Z',
  ).items[0];
  assert.equal(item.itemStatus, 'no_adopted');
  assert.deepEqual(item.tags, []);
  const kept = makeHandoff(
    assignment,
    [
      verifyResponse(
        assignment,
        response([valid, { ...valid, tagId: 'math-10' }]),
      ),
      verifyResponse(assignment, response([valid])),
      verifyResponse(assignment, response([valid])),
    ],
    '2026-11-12T00:00:00Z',
  ).items[0];
  assert.deepEqual(
    kept.tags.map((t: { tagId: string; status: string }) => [
      t.tagId,
      t.status,
    ]),
    [
      ['math-05', 'adopted'],
      ['math-10', 'held'],
    ],
  );
});
test('인용의 따옴표 종류 차이만 허용하고 원문 구절로 되돌려 저장한다', () => {
  const quoted = {
    ...assignment,
    items: [
      { ...assignment.items[0], text: '‘x² ≥ x이다’의 참·거짓을 판단하시오.' },
    ],
  };
  const check = (quote: string) =>
    verifyResponse(quoted, response([{ ...valid, quote }]))[0].tags[0];
  const straight = check("'x² ≥ x이다'의 참·거짓");
  assert.equal(straight.quoteVerified, true);
  assert.equal(straight.status, 'adopted');
  assert.equal(straight.quote, '‘x² ≥ x이다’의 참·거짓');
  const altered = check("'x² > x이다'의 참·거짓");
  assert.equal(altered.quoteVerified, false);
  assert.equal(altered.status, 'held');
});
test('모델에 보내는 임시 문항 ID는 숫자가 없고 고유하며 원래 ID로 되돌아간다', () => {
  const many = {
    ...assignment,
    items: Array.from({ length: 60 }, (_, i) => ({
      ...assignment.items[0],
      itemId: 'q' + (i + 1),
      displayNumber: String(i + 1),
    })),
  };
  const { aliased, restore } = aliasItemIds(many);
  const ids: string[] = aliased.items.map(
    (item: { itemId: string }) => item.itemId,
  );
  assert.equal(new Set(ids).size, 60);
  assert.ok(ids.every((id) => !/\d/.test(id)));
  assert.equal(aliased.items[7].text, many.items[7].text);
  const run = verifyResponse(aliased, {
    items: ids.map((itemId) => ({ ...response([valid]).items[0], itemId })),
  });
  assert.deepEqual(
    restore(run).map((result: { itemId: string }) => result.itemId),
    many.items.map((item) => item.itemId),
  );
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

import {
  applyCrossCheck,
  itemsFromPhoto,
  mergeMathPage,
  parseCrossCheck,
  parsePageReading,
  repairJsonText,
} from './read-page.mjs';

test('판독 JSON의 문자열 안 개행과 잘못된 이스케이프를 복구하고 원문 응답을 오류에 남긴다', () => {
  assert.deepEqual(
    JSON.parse(repairJsonText('{"a":"1행\n2행\t끝","b":"\\(x\\)","c":"\\n"}')),
    { a: '1행\n2행\t끝', b: '\\(x\\)', c: '\n' },
  );
  const reading = parsePageReading(
    '{"items":[{"displayNumber":"1","text":"첫 줄\n둘째 줄 \\sqrt"}]}',
  );
  assert.equal(reading[0].text, '첫 줄\n둘째 줄 \\sqrt');
  try {
    parsePageReading('문항이 없습니다.');
    assert.fail('해석 실패여야 한다');
  } catch (error) {
    assert.match((error as Error).message, /판독 JSON 해석 실패/);
    assert.equal((error as { raw?: string }).raw, '문항이 없습니다.');
  }
});
import {
  annotateEvidence,
  assignmentInputSchema,
  buildInstructions,
  buildItemText,
} from './classify.mjs';

test('사진 판독 JSON은 울타리·최상위 배열을 받아들이고 어긋난 그림 값은 보수적으로 강등한다', () => {
  const reading = parsePageReading(
    '```json\n' +
      JSON.stringify([
        { displayNumber: '1', text: 'x를 구하시오.' },
        {
          displayNumber: '2',
          text: '그래프를 보시오.',
          figureDependence: '그림이 꼭 필수입니다',
          figureReads: [
            '점 (1, 2) | 적힌 값 | 선명',
            '값 a | b | 3 | 모르는 방식 | 흐림',
          ],
        },
      ]) +
      '\n```',
  );
  assert.equal(reading.length, 2);
  assert.equal(reading[0].figure, undefined);
  assert.deepEqual(reading[1].figure, {
    dependence: '필수',
    reads: [
      { content: '점 (1, 2)', method: '적힌 값', state: '선명' },
      { content: '값 a | b | 3', method: '모양에서 추정', state: '불명' },
    ],
  });
  assert.throws(() => parsePageReading('{"items":[]}'));
});

test('두 판독을 합칠 때 번호·본문이 갈리면 보류하고 그림 항목이 갈리면 불명으로 남긴다', () => {
  const first = [
    { displayNumber: '1', text: 'a³ − b³' },
    { displayNumber: '2', text: 'f(2)를 구하시오.' },
    {
      displayNumber: '3',
      text: '그림을 보시오.',
      figure: {
        dependence: '보조',
        reads: [
          { content: '점 (1, 2)', method: '적힌 값', state: '선명' },
          { content: '기울기 2', method: '눈금에서 읽음', state: '선명' },
        ],
      },
    },
  ];
  const second = [
    { displayNumber: '1', text: '$a ^ { 3 } - b^3$' },
    { displayNumber: '5', text: 'f(2)를 구하시오.' },
    {
      displayNumber: '3',
      text: '그림을 보시오.',
      figure: {
        dependence: '필수',
        reads: [
          { content: '점 (1, 2)', method: '모양에서 추정', state: '선명' },
          { content: '기울기 3', method: '눈금에서 읽음', state: '선명' },
          { content: '절편 1', method: '적힌 값', state: '선명' },
        ],
      },
    },
  ];
  const merged = mergeMathPage(first, second);
  assert.deepEqual(
    merged.map((m: { displayNumber: string }) => m.displayNumber),
    ['1', '2', '3', '5'],
  );
  assert.equal(merged[0].holdReason, undefined);
  assert.equal(merged[0].text, 'a³ − b³');
  assert.ok(merged[1].holdReason);
  assert.ok(merged[3].holdReason);
  assert.equal(merged[2].figure?.dependence, '필수');
  assert.deepEqual(
    merged[2].figure?.reads.map((r: { method: string; state: string }) => [
      r.method,
      r.state,
    ]),
    [
      ['모양에서 추정', '선명'],
      ['눈금에서 읽음', '불명'],
      ['적힌 값', '불명'],
    ],
  );
});

test('교차 검수에서 차이나 누락이 나온 문항은 보류하고 기존 보류는 유지한다', () => {
  const verdicts = parseCrossCheck(
    '```json\n{"items":[{"displayNumber":"1","verdict":"일치"},{"displayNumber":"2","verdict":"차이","note":"사진: 2의 5승 / 전사: 2의 3승"}]}\n```',
  );
  const items = applyCrossCheck(
    [
      { displayNumber: '1', text: 'x' },
      { displayNumber: '2', text: 'y' },
      { displayNumber: '3', text: 'z' },
      { displayNumber: '4', text: '', holdReason: '판독 불명' },
    ],
    verdicts,
  );
  assert.equal(items[0].holdReason, undefined);
  assert.match(items[1].holdReason, /차이.*5승/);
  assert.equal(items[1].text, '');
  assert.match(items[2].holdReason, /누락/);
  assert.equal(items[3].holdReason, '판독 불명');
});

test('사진에서 나눈 문항은 고유 ID를 받고 겹친 번호는 하나로 합쳐 보류한다', () => {
  const items = itemsFromPhoto('hw-1', 7, [
    { displayNumber: '12', text: 'x를 구하시오.' },
    { displayNumber: '13 (가)', text: 'y를 구하시오.' },
    { displayNumber: '12', text: '다른 전사' },
  ]);
  assert.deepEqual(
    items.map((i: { itemId: string }) => i.itemId),
    ['hw-1-p7-12', 'hw-1-p7-13'],
  );
  assert.equal(items[0].text, '');
  assert.match(items[0].holdReason, /여러 번 감지/);
  assert.equal(items[1].text, 'y를 구하시오.');
  assert.equal(items[1].page, 7);
});

test('그림 의존도 필수에서 추정·불명 그림 정보만 근거인 태그는 보류하고 근거 종류를 남긴다', () => {
  const figure = {
    dependence: '필수',
    reads: [
      { content: '꼭짓점 (2, 3)', method: '적힌 값', state: '선명' },
      { content: '기울기 양수', method: '모양에서 추정', state: '선명' },
    ],
  };
  const built = buildItemText('그래프의 식을 구하시오.', figure);
  assert.equal(
    built.text,
    '그래프의 식을 구하시오.\n[그림 의존도: 필수]\n[그림1] 꼭짓점 (2, 3) (적힌 값, 선명)\n[그림2] 기울기 양수 (모양에서 추정, 선명)',
  );
  for (const [i, span] of built.figureSpans.entries())
    assert.equal(
      built.text.slice(span.start, span.end),
      '[그림' +
        (i + 1) +
        '] ' +
        span.read.content +
        ' (' +
        span.read.method +
        ', ' +
        span.read.state +
        ')',
    );
  const figures = new Map([['q1', built]]);
  const textById = new Map([['q1', built.text]]);
  const figureTag = (quote: string) => ({
    tagId: 'math-05',
    status: 'adopted',
    quote,
    action: '행동',
    reason: '',
    quoteVerified: true,
  });
  const annotated = (quote: string) =>
    annotateEvidence(
      [
        {
          itemId: 'q1',
          disposition: 'assessed',
          reasoning: 'r',
          tags: [figureTag(quote)],
        },
      ],
      figures,
      textById,
    )[0].tags[0];
  const written = annotated('꼭짓점 (2, 3)');
  assert.equal(written.evidenceKind, 'figure');
  assert.equal(written.status, 'adopted');
  const guessed = annotated('기울기 양수 (모양에서 추정');
  assert.equal(guessed.evidenceKind, 'figure');
  assert.equal(guessed.status, 'held');
  assert.match(guessed.reason, /추정·불명/);
  const mixed = annotated(
    '식을 구하시오.\n[그림 의존도: 필수]\n[그림1] 꼭짓점',
  );
  assert.equal(mixed.evidenceKind, 'text_and_figure');
  assert.equal(mixed.status, 'adopted');
  assert.equal(annotated('그래프의 식').evidenceKind, 'text');
  const noFigure = annotateEvidence(
    [
      {
        itemId: 'q9',
        disposition: 'assessed',
        reasoning: 'r',
        tags: [figureTag('x')],
      },
    ],
    figures,
    textById,
  )[0].tags[0];
  assert.equal(noFigure.evidenceKind, undefined);
  const handoff = makeHandoff(
    {
      assignmentId: 'hw',
      subject: 'M',
      items: [{ itemId: 'q1', page: 1, displayNumber: '1', text: built.text }],
    },
    [
      [
        {
          itemId: 'q1',
          disposition: 'assessed',
          reasoning: 'r',
          tags: [written],
        },
      ],
    ],
    '2026-11-13T00:00:00Z',
  ).items[0];
  assert.deepEqual(handoff.tags, [
    {
      tagId: 'math-05',
      status: 'adopted',
      evidenceKind: 'figure',
      agreement: { same: 1, runs: 1 },
    },
  ]);
});

test('photos 입력을 허용하되 문항과 사진이 모두 비면 거절하고, 그림 정보가 있는 문항도 받는다', () => {
  const base = { assignmentId: 'hw-photo', subject: 'M' };
  const parsed = assignmentInputSchema.parse({
    ...base,
    items: [],
    photos: [{ page: 7, image: 'page7.png' }],
  });
  assert.equal(parsed.photos?.length, 1);
  assert.throws(() => assignmentInputSchema.parse({ ...base, items: [] }));
  const withFigure = assignmentInputSchema.parse({
    ...base,
    items: [
      {
        itemId: 'q1',
        page: 1,
        displayNumber: '1',
        text: '그래프를 보시오.',
        figure: {
          dependence: '보조',
          reads: [{ content: '점 (1, 2)', method: '적힌 값', state: '선명' }],
        },
      },
    ],
  });
  const figureItem = withFigure.items[0];
  assert.equal(
    'figure' in figureItem ? figureItem.figure?.dependence : undefined,
    '보조',
  );
});

test('그림 안내문은 그림 정보가 있을 때만 들어가고 글자 전용 지시는 그대로다', async () => {
  const plain = await buildInstructions('M');
  const withFigures = await buildInstructions('M', { withFigures: true });
  assert.ok(!plain.includes('[그림'));
  assert.ok(withFigures.includes('[그림'));
  assert.equal(await buildInstructions('M', { withFigures: false }), plain);
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
