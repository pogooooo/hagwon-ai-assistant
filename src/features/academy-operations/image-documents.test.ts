import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { createOperationsServer } from './application.ts';
import { getActor } from './directory.ts';
import { documentsModule } from './documents.ts';
import { consultationModule } from './consultation.ts';
import { OperationError, type PageContext } from './shared.ts';
import {
  createOperationsClovaFetch,
  createOperationsScanVision,
} from './runtime-generation.ts';
import {
  detectFormat,
  parseSourceFile,
} from '../rag-consultation/server/ingest/parsers/index.ts';
import { imageDimensions } from '../rag-consultation/server/ingest/parsers/image.ts';
import { reconcileScan } from '../rag-consultation/server/ingest/parsers/clova-vision.ts';

const image = (format: 'png' | 'jpeg' | 'webp') => {
  const canvas = createCanvas(120, 60);
  canvas.getContext('2d').fillText('Academy', 4, 30);
  return format === 'png'
    ? canvas.toBuffer('image/png')
    : format === 'jpeg'
      ? canvas.toBuffer('image/jpeg')
      : canvas.toBuffer('image/webp');
};
const bmp = () => {
  const bytes = Buffer.alloc(54 + 120 * 60 * 3);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(120, 18);
  bytes.writeInt32LE(60, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  return bytes;
};
const form = (fields: Record<string, string | File>) => {
  const result = new FormData();
  for (const [k, v] of Object.entries(fields)) result.set(k, v);
  return result;
};
const fields = {
  action: 'save',
  title: '원본 사진 수강료',
  documentType: 'fee',
  visibility: 'academy_public',
  clovaScan: '1',
  validFrom: '2026-01-01T00:00',
};
const reading =
  '| 반 | 수강료 |\n| --- | --- |\n| 중2 내신반 | 310000원 |\n| 중1 기본반 | 250000원 |';
const success = () =>
  Response.json({
    status: { code: '20000' },
    result: {
      finishReason: 'stop',
      message: { content: reading },
    },
  });

test('PNG/JPEG/WEBP/BMP signatures and exact MIME reach both CLOVA readings', async () => {
  for (const [format, bytes, mime] of [
    ['png', image('png'), 'image/png'],
    ['jpg', image('jpeg'), 'image/jpeg'],
    ['webp', image('webp'), 'image/webp'],
    ['bmp', bmp(), 'image/bmp'],
  ] as const) {
    let calls = 0;
    assert.equal(detectFormat(bytes, 'renamed.bin'), 'image');
    assert.deepEqual(imageDimensions(bytes), { width: 120, height: 60 });
    const vision = createOperationsScanVision(
      { RAG_CLOVA_API_KEY: 'fixture' },
      async (_url, init) => {
        const input = JSON.parse(String(init?.body));
        assert.ok(
          input.messages[1].content[0].dataUri.data.startsWith(
            'data:' + mime + ';base64,',
          ),
        );
        calls++;
        return success();
      },
    )!;
    const parsed = await parseSourceFile({
      bytes,
      fileName: 'photo.' + format,
      vision,
    });
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.pages[0].page, 1);
    assert.match(parsed.text, /310000원/);
    assert.equal(calls, 2);
  }
});

test('unknown image extensions, damaged signatures and oversized dimensions do not make paid requests', async () => {
  let calls = 0;
  const vision = createOperationsScanVision(
    { RAG_CLOVA_API_KEY: 'fixture' },
    async () => {
      calls++;
      return success();
    },
  )!;
  for (const name of [
    'picture.heic',
    'picture.tiff',
    'picture.svg',
    'picture.gif',
    'fake.png',
  ]) {
    const result = await parseSourceFile({
      bytes: Buffer.from('unrecognized content'),
      fileName: name,
      vision,
    });
    assert.equal(result.error, 'unsupported_format');
  }
  const tooBig = image('png');
  tooBig.writeUInt32BE(4000, 16);
  await assert.rejects(vision.readPage(tooBig, 1), /2240/);
  await assert.rejects(
    vision.readPage(Buffer.from([255, 216, 255]), 1),
    /형식/,
  );
  assert.equal(calls, 0);
});

test('native title and paragraph encodings normalize identically and both requests explicitly require transcription', async () => {
  let calls = 0;
  const vision = createOperationsScanVision(
    { RAG_CLOVA_API_KEY: 'fixture' },
    async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      assert.match(input.messages[1].content[1].text, /전사.*마크다운 표/);
      calls++;
      return Response.json({
        status: { code: '20000' },
        result: {
          finishReason: 'stop',
          message: {
            content: JSON.stringify([
              {
                kind: calls === 1 ? 'title' : 'paragraph',
                text: '반별 수강료',
              },
              {
                kind: 'table',
                rows: [
                  ['반', '수강료'],
                  ['중2 내신반', '310000원'],
                ],
              },
            ]),
          },
        },
      });
    },
  )!;
  const result = await vision.readPage(image('png'), 1);
  assert.deepEqual(result.issues, []);
  assert.equal(result.blocks[0].text, '반별 수강료');
  assert.deepEqual(result.blocks[1].rows?.[1], ['중2 내신반', '310000원']);
  assert.equal(calls, 2);
});

test('Korean OCR spacing differences preserve confirmed cells while class and numeric changes still require review', () => {
  const blocks = (name: string, price: string) => [
    {
      kind: 'table',
      rows: [
        ['반', '수강료'],
        [name, price],
      ],
    },
  ];
  const stable = reconcileScan(
    blocks('중2내신반', '310000원'),
    blocks('중2 내신반', '310000 원'),
    1,
  );
  assert.deepEqual(stable.issues, []);
  assert.deepEqual(stable.blocks[0].rows?.[1], ['중2내신반', '310000원']);
  for (const other of [
    blocks('중1 내신반', '310000원'),
    blocks('중2 내신반', '31000원'),
    blocks('중2 내신반', '310 000원'),
  ])
    assert.equal(
      reconcileScan(blocks('중2내신반', '310000원'), other, 1).issues.length,
      1,
    );
});

test('scan readings share the persisted consultation call budget and explicit off stays off', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let calls = 0;
  const env = {
    RAG_CLOVA_API_KEY: 'fixture',
    RAG_GENERATION_DAILY_CALL_LIMIT: '2',
  };
  const network: typeof fetch = async () => {
    calls++;
    return success();
  };
  const vision = createOperationsScanVision(env, network, db)!;
  await vision.readPage(image('png'), 1);
  assert.equal(
    (
      await createOperationsClovaFetch(
        env,
        network,
        db,
      )('https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-007')
    ).status,
    402,
  );
  await assert.rejects(vision.readPage(image('png'), 1), /402/);
  assert.equal(calls, 2);
  assert.equal(
    createOperationsScanVision({ ...env, AXR_CLOVA_SCAN_ENABLED: 'false' }),
    undefined,
  );
  assert.equal(createOperationsScanVision({}), undefined);
});

test('image upload → draft → approval → consultation keeps selected class, number and original citation', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createOperationsServer({ db, demoPassword: 'synthetic-password' });
  db.exec('DELETE FROM op_document_versions');
  let calls = 0;
  const vision = createOperationsScanVision(
    { RAG_CLOVA_API_KEY: 'fixture' },
    async () => {
      calls++;
      return success();
    },
  )!;
  const ctx = (id = 'TA_DIRECTOR'): PageContext => ({
    db,
    actor: getActor(db, id)!,
    url: new URL('http://localhost/documents'),
    scanVision: vision,
  });
  await documentsModule.submit(
    ctx(),
    form({
      ...fields,
      file: new File([new Uint8Array(image('webp'))], '원본.webp'),
    }),
  );
  const row = db.prepare('SELECT * FROM op_document_versions').get()!;
  assert.equal(row.state, 'draft');
  assert.equal(row.original_name, '원본.webp');
  assert.deepEqual(Buffer.from(row.original_file as Uint8Array), image('webp'));
  const before = await documentsModule.render(ctx('TA_VISITOR'));
  assert.doesNotMatch(before, /원본 사진 수강료/);
  await documentsModule.submit(
    ctx(),
    form({
      action: 'approve',
      documentId: String(row.document_id),
      revision: '1',
    }),
  );
  const thread = randomUUID();
  await consultationModule.submit(
    ctx('TA_VISITOR'),
    form({
      action: 'ask',
      conversationId: thread,
      question: '중2 내신반 수강료는?',
    }),
  );
  const answer = JSON.parse(
    String(
      db
        .prepare(
          "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
        )
        .get(thread)!.response,
    ),
  );
  assert.equal(answer.status, 'answered', answer.answer);
  assert.match(answer.answer, /310,?000/);
  assert.doesNotMatch(answer.answer, /250,?000/);
  assert.equal(answer.citations[0].documentId, row.document_id);
  assert.equal(answer.citations[0].revision, 1);
  assert.match(answer.citations[0].location, /1쪽|p\.1|페이지 1/);
  assert.equal(calls, 2);
});

test('missing image connection, absent consent and private scope fail before any vision request', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createOperationsServer({ db, demoPassword: 'synthetic-password' });
  const ctx: PageContext = {
    db,
    actor: getActor(db, 'TA_DIRECTOR')!,
    url: new URL('http://localhost/documents'),
  };
  const upload = (overrides: Record<string, string> = {}) =>
    form({
      ...fields,
      ...overrides,
      file: new File([new Uint8Array(image('png'))], '사진.png'),
    });
  await assert.rejects(
    async () => documentsModule.submit(ctx, upload()),
    /연결/,
  );
  let calls = 0;
  ctx.scanVision = {
    id: 'fixture',
    async readPage() {
      calls++;
      return { blocks: [], issues: [] };
    },
  };
  for (const overrides of [
    { clovaScan: '' },
    { visibility: 'staff_only' },
    {
      documentType: 'student_analysis',
      visibility: 'student_private',
      studentId: 'TA_STU_001',
    },
  ] as Record<string, string>[])
    await assert.rejects(
      async () => documentsModule.submit(ctx, upload(overrides)),
      (e: unknown) => e instanceof OperationError && e.status === 422,
    );
  assert.equal(calls, 0);
});

test('hosted scan-PDF limitation is shown and mixed PDF is not silently indexed without scan pages', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createOperationsServer({ db, demoPassword: 'synthetic-password' });
  const ctx: PageContext = {
    db,
    actor: getActor(db, 'TA_DIRECTOR')!,
    url: new URL('http://localhost/documents?view=create'),
    scanPdfAvailable: false,
  };
  assert.match(
    await documentsModule.render(ctx),
    /스캔 PDF의 이미지 변환을 지원하지/,
  );
  const pdf = readFileSync(
    new URL(
      '../rag-consultation/server/__fixtures__/documents-v1/documents/PX_MIXED__r1.pdf',
      import.meta.url,
    ),
  );
  await assert.rejects(
    async () =>
      documentsModule.submit(
        ctx,
        form({ ...fields, clovaScan: '', file: new File([pdf], 'mixed.pdf') }),
      ),
    /일부 내용만 등록하지/,
  );
});
