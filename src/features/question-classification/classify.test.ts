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

import {
  cleanDisplayNumber,
  passageNumbers,
  pagesFromReadings,
} from './read-page.mjs';

// 사진 평가 세트(examples/photo-set)에서 실제로 나온 판독 실패를 재현한다.
const bs = String.fromCharCode(92);
const tex = (s: string) => s.replaceAll('~', bs);

test('JSON 복구는 \neq·\to·\text·\frac 같은 LaTeX 명령을 줄바꿈·탭으로 바꾸지 않는다', () => {
  const raw = tex(
    '{"items":[{"displayNumber":"1","text":"$x ~neq 3$, $~lim_{h~to 0}$, $1~:~text{km}$, $~frac{1}{2}$, $~times$, $~right)$~n다음 줄"}]}',
  );
  const [item] = parsePageReading(raw);
  assert.equal(
    item.text,
    tex(
      '$x ~neq 3$, $~lim_{h~to 0}$, $1~:~text{km}$, $~frac{1}{2}$, $~times$, $~right)$',
    ) + '\n다음 줄',
  );
});

test('판독 번호의 마침표와 본문에 되풀이된 번호를 걷어 내고 최상위 쪽수를 문항에 넣는다', () => {
  assert.equal(cleanDisplayNumber('5.'), '5');
  assert.equal(cleanDisplayNumber('12번'), '12');
  assert.equal(cleanDisplayNumber('0009'), '0009');
  const items = parsePageReading(
    JSON.stringify({
      printedPage: '25',
      items: [
        { displayNumber: '7.', text: '7. f는 2에서 미분가능하다.' },
        { displayNumber: '8', text: '8.f(x) = x²', printedPage: 26 },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => [i.displayNumber, i.text, i.printedPage]),
    [
      ['7', 'f는 2에서 미분가능하다.', 25],
      ['8', 'f(x) = x²', 26],
    ],
  );
});

test('공유 지문은 범위 안의 문항 앞에 한 번씩 붙이고 이미 들어 있으면 다시 붙이지 않는다', () => {
  assert.deepEqual(passageNumbers('[7–10]'), ['7', '8', '9', '10']);
  assert.deepEqual(passageNumbers('11, 12'), ['11', '12']);
  const items = parsePageReading(
    JSON.stringify({
      passages: [{ numbers: '7~8', text: 'The last bus leaves early.' }],
      items: [
        { displayNumber: '7', text: '필자가 요구하는 조치는?' },
        {
          displayNumber: '8',
          text: 'The last bus leaves early. 언제 떠나는가?',
        },
        { displayNumber: '9', text: '괄호 안에서 고르시오.' },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => i.text),
    [
      'The last bus leaves early.\n필자가 요구하는 조치는?',
      'The last bus leaves early. 언제 떠나는가?',
      '괄호 안에서 고르시오.',
    ],
  );
});

test('수학 두 판독 비교는 LaTeX 표기·한글 앞 공백 차이를 접고 숫자 사이 공백과 괄호 차이는 보류한다', () => {
  assert.equal(
    compareMathReadings(
      tex('단, $x ~neq 3$ 일 때 33 개'),
      tex('단, $x ~ne 3$일 때 33개'),
    ),
    null,
  );
  assert.equal(
    compareMathReadings(
      tex('$f^{~prime}(2)$ $1~:~text{km}$'),
      "$f'(2)$ $1 km$",
    ),
    null,
  );
  assert.equal(
    compareMathReadings(
      tex('$~lim~limits _{h~to 0}~dfrac{a}{h}$'),
      tex('$~lim_{h~to0}~frac{a}{h}$'),
    ),
    null,
  );
  assert.ok(compareMathReadings('x = 12', 'x = 1 2'));
  assert.ok(compareMathReadings('[f(2+h)-f(2)]/h', '(f(2+h)-f(2))/h'));
});

test('쪽수는 모든 판독이 같은 값 하나를 읽었을 때만 채택한다', () => {
  assert.equal(
    pagesFromReadings([[{ printedPage: 24 }], [{ printedPage: 24 }, {}]]),
    24,
  );
  assert.equal(
    pagesFromReadings([[{ printedPage: 24 }], [{ printedPage: 2 }]]),
    undefined,
  );
  assert.equal(pagesFromReadings([[{}], []]), undefined);
});

test('교차 검수 응답의 번호 표기(5.)가 달라도 같은 문항으로 맞춘다', () => {
  const [item] = applyCrossCheck(
    [{ displayNumber: '5', text: 'f(2)는?' }],
    [{ displayNumber: '5.', verdict: '일치' }],
  );
  assert.equal(item.text, 'f(2)는?');
});

test('판독 JSON이 마지막 닫는 괄호만 빠뜨리면 닫아 주고, 문자열이 잘린 응답은 그대로 실패한다', () => {
  const items = parsePageReading(
    '{"printedPage":25,"passages":[],"items":[{"displayNumber":"5","text":"f(2)는?"}]',
  );
  assert.deepEqual(
    items.map((i) => [i.displayNumber, i.printedPage]),
    [['5', 25]],
  );
  assert.throws(
    () => parsePageReading('{"items":[{"displayNumber":"5","text":"f(2'),
    /판독 JSON 해석 실패/,
  );
});

import { classifyAssignment } from './pipeline.mjs';

test('분류 응답이 형식 검증에 실패하면 한 번만 다시 요청하고, 두 번 실패하면 오류를 낸다', async (t) => {
  t.mock.method(console, 'log', () => {});
  const saved = process.env.CLOVA_STUDIO_API_KEY;
  process.env.CLOVA_STUDIO_API_KEY = 'test-key';
  t.after(() => {
    if (saved === undefined) delete process.env.CLOVA_STUDIO_API_KEY;
    else process.env.CLOVA_STUDIO_API_KEY = saved;
  });
  const replies: ((id: string) => unknown)[] = [];
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init.body));
      const [{ itemId }] = JSON.parse(body.messages[1].content);
      const content = JSON.stringify(replies.shift()!(itemId));
      return new Response(
        JSON.stringify({ result: { message: { content }, usage: {} } }),
      );
    },
  );
  const assessed = (reasoning: string) => (itemId: string) => ({
    items: [
      {
        itemId,
        disposition: 'assessed',
        reasoning,
        tags: [
          {
            tagId: 'math-02',
            quote: 'f(4)를 구하시오',
            action: '대입',
            status: 'adopted',
            reason: '',
          },
        ],
      },
    ],
  });
  const assignment = {
    assignmentId: 'retry',
    subject: 'M',
    items: [
      {
        itemId: 'q1',
        page: 1,
        displayNumber: '1',
        text: 'f(x) = x² − 9일 때 f(4)를 구하시오.',
      },
    ],
  };
  replies.push(assessed(''), assessed('f(4) = 16 − 9 = 7'));
  const ok = await classifyAssignment(assignment);
  assert.equal(calls, 2);
  assert.equal(ok.retries, 1);
  assert.equal(ok.usage.length, 2);
  assert.equal(ok.record.items[0].itemStatus, 'classified');

  calls = 0;
  replies.push(assessed(''), assessed(''));
  await assert.rejects(classifyAssignment(assignment));
  assert.equal(calls, 2);
});

test('판독 JSON 문자열 안의 이스케이프 안 된 큰따옴표와 빠진 닫는 따옴표를 복구한다', () => {
  const [boxed] = parsePageReading(
    '{"items":[{"displayNumber":"12","text":"조건을 만족한다.\n<box label="">(가) a=1</box>"}]}',
  );
  assert.equal(boxed.text, '조건을 만족한다.\n<box label="">(가) a=1</box>');
  const items = parsePageReading(
    '{"items":[\n {"displayNumber":"23","text":"값은? ⑤ $1$\n },\n {"displayNumber":"24","text":"He said "stop", then left."}\n]}',
  );
  assert.deepEqual(
    items.map((i) => [i.displayNumber, i.text]),
    [
      ['23', '값은? ⑤ $1$'],
      ['24', 'He said "stop", then left.'],
    ],
  );
});

import { findQuote } from './classify.mjs';

test('인용 대조는 원문의 줄바꿈·공백 차이를 같게 보고 원문 구간을 그대로 돌려준다', () => {
  const text =
    'musicians owe it to themselves to become\n“researchers” just like everyone else.';
  assert.equal(
    findQuote(text, 'to become "researchers" just like'),
    'to become\n“researchers” just like',
  );
  assert.equal(findQuote(text, 'to become scientists'), null);
  assert.equal(findQuote(text, '   '), null);
});

test('인용 대조는 모델이 뺀 밑줄 위치 번호(①)를 같게 보되 다른 낱말은 거절한다', () => {
  const text = 'then we can ① confidently deduce\nthe outcome.';
  assert.equal(
    findQuote(text, 'we can confidently deduce the outcome'),
    'we can ① confidently deduce\nthe outcome',
  );
  assert.equal(findQuote(text, 'we can safely deduce the outcome'), null);
});

import { mathStem } from './read-image.mjs';

test('수학 두 판독이 선택지·배점만 다르면 합의한 발문으로 통과하고, 발문이 다르면 보류한다', () => {
  assert.equal(
    mathStem('쌍곡선의 점근선이 y=2x일 때, a의 값은? [$3$점]\r\n① $2$\n② $3$'),
    '쌍곡선의 점근선이 y=2x일 때, a의 값은?',
  );
  const [choicesDiffer, stemDiffers, same] = mergeMathPage(
    [
      { displayNumber: '24', text: 'a의 값은?\n① $2$\n② $3$' },
      { displayNumber: '25', text: '$\log_{b}a^{2}=2$일 때 값은?' },
      { displayNumber: '26', text: 'f(2)의 값은? ① 1 ② 2' },
    ],
    [
      { displayNumber: '24', text: 'a의 값은? [$3$점]\n① $1$\n② [불명]' },
      { displayNumber: '25', text: '$\log_{b}a=2$일 때 값은? [$3$점]' },
      { displayNumber: '26', text: 'f(2)의 값은? ① 1 ② 2' },
    ],
  );
  assert.deepEqual(choicesDiffer, { displayNumber: '24', text: 'a의 값은?' });
  assert.equal(stemDiffers.text, '');
  assert.equal(stemDiffers.holdReason, '수학 문항의 두 판독이 일치하지 않음');
  assert.equal(same.text, 'f(2)의 값은? ① 1 ② 2');
});

test('수식으로 감싼 되풀이 번호($18.$, $19$.)도 걷어 낸다', () => {
  const items = parsePageReading(
    JSON.stringify({
      items: [
        { displayNumber: '18', text: '$18.$ 함수 f의 최솟값은?' },
        { displayNumber: '19', text: '$19$. 삼차함수 f(x)' },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => i.text),
    ['함수 f의 최솟값은?', '삼차함수 f(x)'],
  );
});

test('JSON 판독에서 16진수가 따르지 않는 역슬래시 u(underline)는 글자로 남긴다', () => {
  const [item] = parsePageReading(
    tex('{"items":[{"displayNumber":"1","text":"~underline{AB}와 ~u0041"}]}'),
  );
  assert.equal(item.text, tex('~underline{AB}와 A'));
});

test('같은 유형이 두 번 나오면 쪽 전체를 실패시키지 않고, 판정이 같으면 하나로, 갈리면 보류로 남긴다', () => {
  const [same] = verifyResponse(assignment, response([valid, valid]));
  assert.deepEqual(
    same.tags.map((t: { tagId: string; status: string }) => [
      t.tagId,
      t.status,
    ]),
    [['math-05', 'adopted']],
  );
  const [split] = verifyResponse(
    assignment,
    response([valid, { ...valid, status: 'held' }]),
  );
  assert.deepEqual(
    split.tags.map((t: { tagId: string; status: string; reason: string }) => [
      t.tagId,
      t.status,
      t.reason,
    ]),
    [['math-05', 'held', '같은 유형에 서로 다른 판정이 나옴']],
  );
});

test('재시도 응답에서도 문항이 빠지거나 겹치면 그 문항만 판정 없음으로 두고 나머지는 살린다', () => {
  const two = {
    ...assignment,
    items: [
      ...assignment.items,
      { itemId: 'q2', page: 1, displayNumber: '2', text: '값을 구하시오.' },
    ],
  };
  const reply = response([valid]);
  assert.throws(() => verifyResponse(two, reply), /문항 수/);
  const [kept, missing] = verifyResponse(two, reply, { lenient: true });
  assert.equal(kept.tags[0].status, 'adopted');
  assert.equal(missing.disposition, 'unreadable');
  const doubled = { items: [...reply.items, ...reply.items] };
  const [dup] = verifyResponse(assignment, doubled, { lenient: true });
  assert.equal(dup.reasoning, '분류 응답에 같은 문항이 여러 번 나옴');
});

test('인용 대조는 판독이 잃은 띄어쓰기와 $·중괄호·\\left·\\right 표기 차이를 같게 보되 다른 글자는 거절한다', () => {
  const text = String.raw`두상수$a\left(a>1\right)$ 에 대하여 곡선$y=a^{x}$`;
  assert.equal(
    findQuote(text, String.raw`두 상수 $a (a > 1)$ 에 대하여 곡선 $y = a^x$`),
    // 원문 구간은 마지막으로 대조된 글자(x)에서 끝난다.
    String.raw`두상수$a\left(a>1\right)$ 에 대하여 곡선$y=a^{x`,
  );
  assert.equal(findQuote(text, '두 상수 a (a > 2)'), null);
  assert.equal(findQuote(text, '세 상수'), null);
});
