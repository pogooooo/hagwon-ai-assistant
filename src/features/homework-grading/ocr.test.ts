import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { choiceGrid, layoutFromLines } from './ocr.ts';
import {
  detectMarkedChoice,
  pickMarkedChoice,
  type ImagePage,
} from './media.ts';
import { createNaverGrader, type GradeProvider } from './provider.ts';
import { fixture } from './test-fixtures.ts';
import { gradingModule } from './module.ts';
import { newId, readSubmission, submissionAssignment } from './service.ts';

const line = (text: string, x: number, y: number, width = 20) => ({
  text,
  x0: x,
  x1: x + width,
  y0: y,
  y1: y + 12,
  confidence: 0.99,
});
const glyph = (choice: number, x: number, y: number) => ({
  inferText: '①②③④⑤'[choice - 1],
  boundingPoly: {
    vertices: [
      { x, y },
      { x: x + 10, y },
      { x: x + 10, y: y + 10 },
      { x, y: y + 10 },
    ],
  },
});

test('OCR layout takes aligned, increasing printed numbers and ignores choice values and the footer', () => {
  const lines = [
    line('01', 37, 100),
    line('lim 의 값은?', 60, 100, 200),
    line('3', 51, 130, 6),
    line('6', 51, 152, 6),
    line('02', 37, 330),
    line('1', 52, 351, 6),
    line('3', 51, 381, 6),
    line('03', 37, 550),
    line('04', 320, 100),
    line('의 값은?', 345, 100, 200),
    line('05', 321, 330),
    line('06', 320, 550),
    line('= x+3', 181, 211, 40),
    line('1', 549, 808, 5),
  ];
  const layout = layoutFromLines(lines, { width: 596, height: 844 });
  assert.ok(layout);
  assert.deepEqual(layout.numbers, [1, 2, 3, 4, 5, 6]);
  assert.equal(layout.printedPage, 1);
  const [x0, y0, x1, y1] = layout.regions.get(1)!;
  assert.ok(x0 < 0.07 && x1 < 0.6 && y0 < 100 / 844 && y1 < 330 / 844);
  // 오른쪽 단 문항은 가운데부터 시작한다.
  assert.ok(layout.regions.get(4)![0] > 0.4);
});

test('a misread choice symbol in the number column does not break the item sequence', () => {
  const lines = [
    line('10', 323, 103),
    line('다음 중 연속인 함수는?', 343, 103, 200),
    line('3', 324, 154, 6),
    line('11', 323, 330),
    line('12', 323, 553),
    line('07', 37, 111),
    line('08', 38, 336),
    line('09', 38, 553),
    line('2', 550, 811, 5),
  ];
  const layout = layoutFromLines(lines, { width: 596, height: 845 });
  assert.deepEqual(layout?.numbers, [7, 8, 9, 10, 11, 12]);
  assert.equal(layout?.printedPage, 2);
});

test('choice layout is inferred only when one arrangement fits the symbols OCR read', () => {
  // ③이 펜 표시에 덮여 읽히지 않은 3열 배치.
  const grid = choiceGrid(
    [
      glyph(1, 38, 130),
      glyph(2, 115, 130),
      glyph(4, 38, 151),
      glyph(5, 115, 151),
    ].map((g) => ({
      choice: '①②③④⑤'.indexOf(g.inferText) + 1,
      x0: g.boundingPoly.vertices[0].x,
      y0: g.boundingPoly.vertices[0].y,
      x1: g.boundingPoly.vertices[2].x,
      y1: g.boundingPoly.vertices[2].y,
    })),
  );
  assert.ok(grid);
  assert.deepEqual(grid.unread, [3]);
  assert.deepEqual(grid.positions[2], { choice: 3, x: 192, y: 130 });
  assert.equal(choiceGrid([{ choice: 1, x0: 0, y0: 0, x1: 10, y1: 10 }]), null);
  // 같은 기호가 두 번 읽히면 배치를 정하지 않는다.
  assert.equal(
    choiceGrid([
      { choice: 1, x0: 0, y0: 0, x1: 10, y1: 10 },
      { choice: 1, x0: 50, y0: 0, x1: 60, y1: 10 },
    ]),
    null,
  );
  // 펜에 덮인 ④가 "②"로 잘못 읽히면 신뢰도가 높은 ②만 남기고 ④를 못 읽은 기호로 본다.
  const misread = choiceGrid([
    { choice: 1, x0: 809, y0: 393, x1: 830, y1: 416, confidence: 0.59 },
    { choice: 2, x0: 981, y0: 393, x1: 1004, y1: 416, confidence: 0.83 },
    { choice: 3, x0: 1156, y0: 395, x1: 1177, y1: 416, confidence: 0.95 },
    { choice: 2, x0: 809, y0: 434, x1: 838, y1: 463, confidence: 0.45 },
    { choice: 5, x0: 981, y0: 442, x1: 1005, y1: 466, confidence: 0.95 },
  ]);
  assert.deepEqual(misread?.unread, [4]);
});

test('a mark counts only when one choice clearly exceeds the printed ink of the others', () => {
  // 중앙값(10)을 넘는 잉크가 ③에만 있다.
  assert.equal(pickMarkedChoice([9, 8, 31, 10, 10], [3]), 3);
  // 인쇄 값이 큰 사진: 기준 잉크가 높아도 초과량으로 본다.
  assert.equal(pickMarkedChoice([105, 125, 82, 199, 108], [4]), 4);
  // OCR이 기호를 읽었다면 더 큰 차이(4배)를 요구한다.
  assert.equal(pickMarkedChoice([10, 10, 34, 18, 10], [3]), 3);
  assert.equal(pickMarkedChoice([10, 10, 34, 18, 10], [5]), null);
  // 둘째 초과량의 3배에 못 미치면 확정하지 않는다.
  assert.equal(pickMarkedChoice([9, 20, 31, 10, 10], [3]), null);
  // 초과량이 너무 작으면 확정하지 않는다.
  assert.equal(pickMarkedChoice([1, 1, 8, 1, 1], [3]), null);
});

function markedPage(choiceX: number): ImagePage {
  const canvas = createCanvas(300, 200),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 300, 200);
  ctx.fillStyle = '#111';
  // 보기 기호 다섯 개(작은 사각형)와 한 보기를 덮는 펜 표시.
  for (const x of [20, 70, 120, 170, 220]) ctx.fillRect(x + 3, 103, 4, 4);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(choiceX - 2, 95);
  ctx.lineTo(choiceX + 4, 108);
  ctx.lineTo(choiceX + 14, 90);
  ctx.stroke();
  return {
    bytes: new Uint8Array(canvas.toBuffer('image/png')),
    mime: 'image/png',
    page_no: 1,
  };
}
const fiveInRow = (unread: number[]) => ({
  width: 10,
  height: 10,
  positions: [20, 70, 120, 170, 220].map((x, i) => ({
    choice: i + 1,
    x,
    y: 100,
  })),
  unread,
});

test('the pen mark over a choice is read from pixels', async () => {
  const page = markedPage(120);
  const reading = await detectMarkedChoice(page, fiveInRow([3]));
  assert.equal(reading?.answer_observed, '③');
  assert.equal(reading?.answer_status, 'readable');
  assert.equal(reading?.regions[0].page_no, 1);
  // OCR이 ③을 읽었더라도 펜 자국이 압도적이면(4배 이상) 표시로 본다.
  assert.equal(
    (await detectMarkedChoice(page, fiveInRow([1])))?.answer_observed,
    '③',
  );
  assert.equal(
    await detectMarkedChoice(markedPage(-100), fiveInRow([3])),
    null,
  );
});

const ocrUrl = 'https://fixture.apigw.ntruss.com/custom/v1/1/fixture/general';
const approved = {
  CLOVA_STUDIO_API_KEY: 'fixture',
  AXR_GRADING_EXTERNAL_DATA_APPROVED: 'true',
  AXR_GRADING_INPUT_POLICY_REF: 'fixture',
  CLOVA_OCR_INVOKE_URL: ocrUrl,
  CLOVA_OCR_SECRET: 'fixture',
};
const ocrResponse = () =>
  Response.json({
    images: [
      {
        inferResult: 'SUCCESS',
        fields: [
          ['1.', 20, 20],
          ['문제', 40, 20],
          ['2.', 20, 120],
          ['문제', 40, 120],
        ].map(([text, x, y]) => ({
          inferText: text,
          lineBreak: text === '문제',
          inferConfidence: 0.99,
          boundingPoly: {
            vertices: [
              { x, y },
              { x: Number(x) + 15, y },
              { x: Number(x) + 15, y: Number(y) + 12 },
              { x, y: Number(y) + 12 },
            ],
          },
        })),
      },
    ],
  });

test('CLOVA OCR is used only with the external data approval and a NAVER gateway host', async () => {
  const page = markedPage(120);
  for (const [env, expected, calls] of [
    [approved, [1, 2], 1],
    [{ ...approved, AXR_GRADING_EXTERNAL_DATA_APPROVED: 'false' }, null, 0],
    [
      { ...approved, CLOVA_OCR_INVOKE_URL: 'https://example.com/general' },
      null,
      0,
    ],
    [{ ...approved, CLOVA_OCR_SECRET: '' }, null, 0],
  ] as const) {
    let sent = 0;
    const provider = createNaverGrader(env, undefined, (async (url) => {
      sent++;
      assert.ok(new URL(String(url)).hostname.endsWith('.apigw.ntruss.com'));
      return ocrResponse();
    }) as typeof fetch);
    const layout = await provider.locateItems!(page);
    assert.deepEqual(layout?.numbers ?? null, expected);
    assert.equal(sent, calls);
  }
  const failing = createNaverGrader(
    approved,
    undefined,
    (async () => new Response(null, { status: 500 })) as typeof fetch,
  );
  assert.equal(await failing.locateItems!(page), null);
});

test('HCX requests wait and retry after a rate limit', async () => {
  let calls = 0;
  const provider = createNaverGrader(
    { ...approved, AXR_GRADING_RATE_LIMIT_WAIT_MS: '1' },
    undefined,
    (async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429 });
      return Response.json({
        result: {
          message: {
            content: '{"printedPage":3,"numbers":[1],"complete":true}',
          },
        },
      });
    }) as typeof fetch,
  );
  const page = markedPage(120);
  assert.deepEqual((await provider.discoverPage!(page)).numbers, [1]);
  assert.equal(calls, 2);
});

test('OCR-located worksheet items use the detected mark and leave the rest to page reading', async (t) => {
  const seen: string[] = [];
  const provider: GradeProvider = {
    modelId: 'fixture',
    inputAllowed: true,
    async locateItems() {
      return {
        printedPage: null,
        numbers: [1, 2],
        regions: new Map([
          [1, [0, 0, 1, 0.5]],
          [2, [0, 0.5, 1, 1]],
        ]),
        choices: new Map([[1, fiveInRow([3])]]),
      };
    },
    async discoverPage() {
      throw new Error('OCR layout should replace page discovery');
    },
    async read(_pages, a) {
      seen.push(...a.items.map((i) => i.item_no));
      return a.items.map((i) => ({
        item_ref: i.item_ref,
        answer_observed: '4',
        unit_observed: '',
        answer_status: 'readable' as const,
        association_status: 'matched' as const,
        regions: [{ page_no: 1, bbox: [0.1, 0.6, 0.3, 0.7] }],
        ambiguity_codes: [],
      }));
    },
    async solvePage(_page, items) {
      return new Map(
        items.map((i) => [
          i.item_ref,
          i.item_no === '1'
            ? {
                problem: '보기 중 5와 같은 값',
                answer: '③',
                explanation: '③이 5',
                comparison: 'choice' as const,
              }
            : {
                problem: '2+2',
                answer: '4',
                explanation: '합은 4',
                comparison: 'number' as const,
              },
        ]),
      );
    },
  };
  const f = fixture(t, { provider });
  const teacher = f.ctx('TA_TEACHER');
  const form = new FormData();
  for (const [k, v] of Object.entries({
    action: 'register',
    request_key: newId('request'),
    material: 'worksheet',
    material_name: '가상 객관식',
    subject: 'MATH',
    class_id: 'TA_E_MATH',
    rights_basis: '직접 만든 자료',
    approved: 'yes',
  }))
    form.set(k, v);
  const next = String(await gradingModule.submit!(teacher, form));
  const id = new URL(next, teacher.url).searchParams.get('assignment')!;
  const input = f.service.create(
    teacher,
    {
      assignment_id: id,
      assignment_version: 1,
      student_ref: 'TA_STU_001',
      expected_page_count: 1,
    },
    newId('request'),
  );
  await f.service.upload(teacher, input.submission_id, [markedPage(120)]);
  await f.service.process(teacher, input.submission_id);
  const defs = submissionAssignment(
    f.db,
    readSubmission(teacher, input.submission_id),
  ).items;
  assert.deepEqual(
    defs.map((i) => i.item_no),
    ['1', '2'],
  );
  // 표시를 찾은 1번은 쪽 전체 판독으로 다시 보내지 않는다.
  assert.deepEqual(seen, ['2']);
  const draft = await f.service.draft(teacher, input.submission_id);
  const first = draft.items.find(
    (d) => d.extraction.item_ref === defs[0].item_ref,
  )!;
  assert.equal(first.extraction.answer_observed, '③');
  assert.equal(first.extraction.answer_status, 'readable');
  assert.equal(first.proposed.outcome, 'correct');
});

test('without a pixel reader (Cloudflare Workers) the mark detector leaves answers to the student', async (t) => {
  const { registerHooks } = await import('node:module');
  const hooks = registerHooks({
    load(url, ctx, next) {
      if (!url.endsWith('.wasm')) return next(url, ctx);
      return {
        shortCircuit: true,
        format: 'module',
        source:
          "import {readFileSync} from 'node:fs'; export default new WebAssembly.Module(readFileSync(new URL(import.meta.url)));",
      };
    },
  });
  t.after(() => hooks.deregister());
  const { workerGradingMedia } =
    await import('../../../deploy/cloudflare/grading-media.mjs');
  const { configureGradingMedia } = await import('./media.ts');
  assert.equal('darkPixels' in workerGradingMedia, false);
  configureGradingMedia(workerGradingMedia);
  // 펜 표시가 분명해도 픽셀을 읽을 수 없으면 확정하지 않는다(학생이 직접 고른다).
  assert.equal(await detectMarkedChoice(markedPage(120), fiveInRow([3])), null);
});
