import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  fieldsToLines,
  findPrintedPage,
  itemRegions,
  readSheetService,
  tidyItemReading,
  readSheetFromText,
  readSheetOcr,
  readingOrder,
  segmentItems,
} from './ocr-page.mjs';

// CLOVA OCR 응답의 fields 한 줄을 흉내 낸다: 글자 조각마다 위치와 줄 끝 표시.
function line(
  text: string,
  x: number,
  y: number,
  width = 400,
  confidence = 0.99,
) {
  const words = text.split(' ');
  const step = width / words.length;
  return words.map((word, n) => ({
    inferText: word,
    inferConfidence: confidence,
    lineBreak: n === words.length - 1,
    boundingPoly: {
      vertices: [
        { x: x + n * step, y },
        { x: x + (n + 1) * step, y },
        { x: x + (n + 1) * step, y: y + 30 },
        { x: x + n * step, y: y + 30 },
      ],
    },
  }));
}

// 두 단 시험지 한 쪽: 머리글, 왼쪽 단(5·6번), 오른쪽 단(7번과 [8~9] 지문), 쪽 번호.
const page = [
  ...line('2 수학 영역 고 3', 100, 40, 1000),
  ...line('7. 곡선 y=x2과 y축으로 둘러싸인', 650, 200),
  ...line('5. 함수 f(x)에 대하여 f(2)의 값은? [3점]', 100, 200),
  ...line('① 4 ② 5 ③ 6', 100, 260),
  ...line('부분의 넓이는? [3점]', 650, 260),
  ...line('6. 두 양수 a, b가 log3 a2 = 4를', 100, 900),
  ...line('만족시킬 때, b/a의 값은?', 100, 960),
  ...line('[8~9] 다음 글을 읽고 물음에 답하시오.', 650, 900),
  ...line('Trees shade sidewalks.', 650, 960),
  ...line('8. 윗글의 제목으로 가장 적절한 것은?', 650, 1020),
  ...line('9. 밑줄 친 They가 가리키는 것은?', 650, 1080),
  ...line('2 20', 560, 1600, 80),
];

test('OCR 줄을 왼쪽 단 다음 오른쪽 단 순서로 놓고 쪽 번호를 찾는다', () => {
  const lines = readingOrder(fieldsToLines(page));
  assert.deepEqual(
    lines.map((l) => l.text.split(' ').slice(0, 2).join(' ')),
    [
      '2 수학',
      '5. 함수',
      '① 4',
      '6. 두',
      '만족시킬 때,',
      '7. 곡선',
      '부분의 넓이는?',
      '[8~9] 다음',
      'Trees shade',
      '8. 윗글의',
      '9. 밑줄',
      '2 20',
    ],
  );
  assert.equal(findPrintedPage(lines), 2);
});

test('인쇄 번호로 문항을 나누고 공유 지문을 범위 안 문항에 붙인다', () => {
  const items = segmentItems(readingOrder(fieldsToLines(page)));
  assert.deepEqual(
    items.map((i) => [i.displayNumber, i.text]),
    [
      ['5', '함수 f(x)에 대하여 f(2)의 값은? [3점]\n① 4 ② 5 ③ 6'],
      ['6', '두 양수 a, b가 log3 a2 = 4를\n만족시킬 때, b/a의 값은?'],
      ['7', '곡선 y=x2과 y축으로 둘러싸인\n부분의 넓이는? [3점]'],
      [
        '8',
        '[8~9] 다음 글을 읽고 물음에 답하시오.\nTrees shade sidewalks.\n윗글의 제목으로 가장 적절한 것은?',
      ],
      [
        '9',
        '[8~9] 다음 글을 읽고 물음에 답하시오.\nTrees shade sidewalks.\n밑줄 친 They가 가리키는 것은?\n2 20',
      ],
    ],
  );
});

test('본문 속 숫자나 거꾸로 가는 번호는 문항 번호로 받지 않고, 0012식 번호는 받는다', () => {
  const lines = [
    ...line('0012 다항식 (x+1)(x-3)을 전개하시오.', 100, 100),
    ...line('3. 이 줄은 앞 번호보다 작다', 100, 160),
    ...line('0013 그림의 직선의 방정식을 구하시오.', 100, 220),
    ...line('100 명 중 30 명이 참여했다.', 100, 280),
  ];
  const items = segmentItems(readingOrder(fieldsToLines(lines)));
  assert.deepEqual(
    items.map((i) => i.displayNumber),
    ['0012', '0013'],
  );
});

test('네 자리 번호가 발문과 다른 줄에 있어도 문항으로 나누고, 숫자만 있는 쪽 번호는 받지 않는다', () => {
  const lines = [
    ...line('II. 함수와 미분 | 01 유형 연습', 100, 40),
    ...line('0001', 100, 100, 60),
    ...line('f(x) = x2 - 9일 때 f(4)를 구하시오.', 100, 140),
    ...line('0002', 100, 200, 60),
    ...line('극한값을 구하시오.', 100, 240),
    ...line('24', 100, 900, 30),
  ];
  const items = segmentItems(readingOrder(fieldsToLines(lines)));
  assert.deepEqual(
    items.map((i) => [i.displayNumber, i.text]),
    [
      ['0001', 'f(x) = x2 - 9일 때 f(4)를 구하시오.'],
      ['0002', '극한값을 구하시오.\n24'],
    ],
  );
});

test('OCR 판독은 readSheet과 같은 모양으로 문항과 쪽수를 돌려준다', async (t) => {
  process.env.CLOVA_OCR_INVOKE_URL = 'https://ocr.example.test/general';
  process.env.CLOVA_OCR_SECRET = 'test-secret';
  t.after(() => {
    delete process.env.CLOVA_OCR_INVOKE_URL;
    delete process.env.CLOVA_OCR_SECRET;
  });
  let sent: { headers: Record<string, string>; body: string } | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init: RequestInit) => {
      sent = {
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return new Response(
        JSON.stringify({ images: [{ inferResult: 'SUCCESS', fields: page }] }),
      );
    },
  );
  const result = await readSheetOcr({
    bytes: Buffer.from('jpg'),
    mime: 'image/jpeg',
  });
  assert.equal(sent!.headers['X-OCR-SECRET'], 'test-secret');
  assert.equal(JSON.parse(sent!.body).images[0].format, 'jpg');
  assert.deepEqual(
    result.detected.map((i: { displayNumber: string }) => i.displayNumber),
    ['5', '6', '7', '8', '9'],
  );
  assert.equal(result.readingPasses[0][0].printedPage, 2);
});

test('외부 판독기의 마크다운(수식은 LaTeX)도 번호로 문항을 나눈다', () => {
  const md = [
    "5.함수$f(x)=(x+1)(x^2+3x+1)$ 에 대하여 f '(2)의 값은? [3점]① 26② 28",
    '',
    '<div style="text-align: center;"><img src="imgs/a.jpg" /></div>',
    String.raw`## 6.$\frac{\pi}{2}<\theta<\pi$ 일 때, cosθ의 값은? [3점]`,
    String.raw`$$y=\frac{1}{2}x^{2}+2$$`,
  ].join('\n');
  const { detected } = readSheetFromText(md);
  assert.deepEqual(
    detected.map((i: { displayNumber: string }) => i.displayNumber),
    ['5', '6'],
  );
  assert.ok(
    detected[1].text.startsWith(String.raw`$\frac{\pi}{2}<\theta<\pi$`),
  );
  assert.ok(detected[1].text.endsWith(String.raw`$$y=\frac{1}{2}x^{2}+2$$`));
});

test('문항 영역은 번호 줄의 단 폭 전체이고 같은 단의 다음 번호 줄 위에서 끝난다', () => {
  const lines = readingOrder(fieldsToLines(page));
  const items = segmentItems(lines);
  const regions = itemRegions(items, lines);
  const of = (n: string) =>
    regions.get(
      items.find((i: { displayNumber: string }) => i.displayNumber === n),
    );
  // 5번은 왼쪽 단, 같은 단 다음 문항(6번, y=900) 바로 위까지.
  assert.equal(of('5').x0, 100);
  assert.ok(of('5').x1 <= 600);
  assert.equal(of('5').y0, 200);
  assert.ok(of('5').y1 <= 900);
  // 7번은 오른쪽 단, 오른쪽 단의 다음 번호(8번) 위까지. 단 순서가 섞여도 왼쪽 단 줄은 들어가지 않는다.
  assert.ok(of('7').x0 >= 500);
  assert.ok(of('7').y1 <= 1020);
  // 9번은 그 단의 마지막 문항이라 마지막 줄까지(쪽 번호 줄은 빼고).
  assert.ok(of('9').y1 < 1600);
});

test('잘라 읽은 문항에서 되풀이된 번호·box 태그를 걷어 낸다', () => {
  const b = String.fromCharCode(92);
  assert.equal(
    tidyItemReading('$1.' + b + ':' + b + 'sqrt[3]{2}$의 값은?', '1'),
    '$' + b + 'sqrt[3]{2}$의 값은?',
  );
  assert.equal(tidyItemReading('$6.$ $x$의 값은?', '6'), '$x$의 값은?');
  assert.equal(tidyItemReading('$19$. 삼차함수', '19'), '삼차함수');
  assert.equal(
    tidyItemReading('0012 다항식을 전개하시오.', '0012'),
    '다항식을 전개하시오.',
  );
  assert.equal(
    tidyItemReading('<box label="">(가) a=1</box>', '3'),
    '(가) a=1',
  );
  assert.equal(tidyItemReading('12 개의 공', '3'), '12 개의 공');
});

// 숙제 등록 판독: 영어는 OCR 글을 그대로 쓰고, 수학은 문항 영역을 잘라 HCX-005로 다시 읽는다.
test('숙제 등록 판독은 영어에 OCR 글을, 수학에 잘라 읽은 글을 쓰고 실패한 수학 문항은 보류한다', async (t) => {
  process.env.CLOVA_OCR_INVOKE_URL = 'https://ocr.example.test/general';
  process.env.CLOVA_OCR_SECRET = 'test-secret';
  const savedKey = process.env.CLOVA_STUDIO_API_KEY;
  process.env.CLOVA_STUDIO_API_KEY = 'test';
  t.after(() => {
    delete process.env.CLOVA_OCR_INVOKE_URL;
    delete process.env.CLOVA_OCR_SECRET;
    if (savedKey === undefined) delete process.env.CLOVA_STUDIO_API_KEY;
    else process.env.CLOVA_STUDIO_API_KEY = savedKey;
  });
  // 900×760 그림 안에 들어오는 한 단 쪽: 5번, 6번, 쪽 번호.
  const small = [
    ...line('5. 함수 f(x)에 대하여 f(2)의 값은?', 40, 40, 500),
    ...line('① 1 ② 2', 40, 90, 200),
    ...line('6. 두 양수 a, b가 log3 a2 = 4를', 40, 300, 500),
    ...line('만족시킬 때 b/a의 값은?', 40, 350, 400),
    ...line('7', 440, 720, 20),
  ];
  let ocrFields = page;
  const vision: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (String(url).includes('ocr.example.test'))
      return Response.json({
        images: [{ inferResult: 'SUCCESS', fields: ocrFields }],
      });
    const body = JSON.parse(String(init.body));
    assert.equal(body.messages[0].content[0].type, 'image_url');
    vision.push(body.messages[0].content[0].dataUri.data.slice(0, 22));
    if (vision.length === 2) return new Response('', { status: 500 });
    return Response.json({
      result: {
        message: { content: '$5.$ 함수 $f(x)$에 대하여 $f(2)$의 값은?' },
      },
    });
  });
  const image = {
    bytes: readFileSync(
      new URL('./examples/math-page-demo.png', import.meta.url),
    ),
    mime: 'image/png',
  };
  const english = await readSheetService(image, 'E');
  assert.deepEqual(
    english.detected.map((d: { displayNumber: string }) => d.displayNumber),
    ['5', '6', '7', '8', '9'],
  );
  assert.equal(english.detected[0].printedPage, 2);
  assert.equal(vision.length, 0);

  ocrFields = small;
  const math = await readSheetService(image, 'M');
  assert.equal(vision.length, 2);
  assert.ok(vision.every((v) => v.startsWith('data:image/png;base64')));
  assert.equal(math.detected[0].text, '함수 $f(x)$에 대하여 $f(2)$의 값은?');
  assert.equal(math.detected[0].printedPage, 7);
  assert.equal(math.detected[1].text, '');
  assert.match(
    (math.detected[1] as { holdReason?: string }).holdReason ?? '',
    /문항 수식 판독 실패/,
  );
  // 보류한 문항의 교사 확인 후보에는 OCR 글이 남는다.
  assert.match(math.readingPasses[0][1].text, /두 양수 a, b가/);
});

test('Cloudflare 배포의 canvas 대체 모듈이 판독 코드가 가져오는 이름을 모두 내보낸다', async () => {
  // 배포 설정은 @napi-rs/canvas를 native-unavailable.mjs로 바꿔 끼운다. 이름이 하나라도 없으면
  // 모듈을 불러오는 단계에서 운영 앱 전체가 실패한다.
  const source = readFileSync(
    new URL('./ocr-page.mjs', import.meta.url),
    'utf8',
  );
  const imported = source
    .match(/import\s*\{([^}]*)\}\s*from\s*'@napi-rs\/canvas'/)![1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const stub = await import(
    new URL(
      '../../../deploy/cloudflare/native-unavailable.mjs',
      import.meta.url,
    ).href
  );
  assert.ok(imported.length > 0);
  for (const name of imported)
    assert.equal(typeof stub[name], 'function', name + ' 없음');
});
