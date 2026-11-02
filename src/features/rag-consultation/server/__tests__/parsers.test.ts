/**
 * 문서 파서 정확도·안전성 테스트(실제 PDF·DOCX·HWPX 파일 입력).
 * 원본: __fixtures__/documents-v1 (render_pdfs.mjs·build_office_fixtures.mjs 로 생성, 텍스트를 미리 뽑아 넣지 않음)
 * OCR 테스트는 tesseract.js 학습 데이터를 쓸 수 없으면 건너뛴다(RAG_SKIP_OCR=1 로도 끔).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { strToU8, zipSync } from 'fflate';

import { buildChunks, splitIntoBlocks } from '../ingest/chunking.ts';
import { prepareFileDocument } from '../ingest/ingest-file.ts';
import {
  createTesseractOcr,
  parseSourceFile,
  PII_MASK,
  type OcrEngine,
} from '../ingest/parsers/index.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';
import type { RagAccessScope, StoredDocumentRevision } from '../types.ts';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'documents-v1',
  'documents',
);
const file = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const parse = (
  name: string,
  extra: Partial<Parameters<typeof parseSourceFile>[0]> = {},
) =>
  parseSourceFile({ bytes: file(name), fileName: name, ocr: null, ...extra });
const tableRows = (text: string) =>
  splitIntoBlocks(text).filter((b) => b.location.kind === 'table_row');

describe('텍스트 PDF', () => {
  test('표: 행·열·헤더를 그대로 복원하고 쪽 번호를 남긴다', async () => {
    const parsed = await parse('PX_FEE_TABLE__r1.pdf');
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.format, 'pdf');
    const rows = tableRows(parsed.text);
    assert.deepEqual(rows[0].location.header, [
      '반',
      '수업 요일',
      '월 수강료',
      '교재비',
    ]);
    assert.deepEqual(
      rows.map((r) => r.location.cells),
      [
        ['초5 기초반', '월·수', '210,000원', '12,000원'],
        ['초6 기초반', '화·목', '220,000원', '12,000원'],
        ['중1 내신반', '월·수·금', '290,000원', '18,000원'],
        ['중2 내신반', '월·수·금', '310,000원', '18,000원'],
        ['중3 심화반', '화·목·토', '350,000원', '22,000원'],
      ],
    );
    assert.ok(rows.every((r) => r.location.page === 1));
    assert.match(
      rows[3].location.label,
      /^1쪽 · 1\. 반별 수강료 · 표 1 · 4행$/,
    );
  });

  test('2단 편집: 왼쪽 단 → 오른쪽 단 순서로 읽고 단 사이 글이 섞이지 않는다', async () => {
    const parsed = await parse('PX_NEWS_2COL__r1.pdf');
    assert.ok(parsed.warnings.some((w) => w.code === 'two_column_layout'));
    const headings = [...parsed.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, [
      '1. 원장 인사',
      '2. 기말고사 대비 일정',
      '3. 겨울학기 등록',
      '4. 안전한 귀가',
      '5. 도서관 소식',
    ]);
    const compact = parsed.text.replace(/\s+/g, '');
    for (const sentence of [
      '겨울학기재원생우선등록기간은12월1일부터12월7일까지입니다.',
      '중학생기말고사대비특별수업은11월23일월요일부터12월12일토요일까지진행합니다.',
      '학원앞횡단보도에는11월부터안전지킴이가배치됩니다.',
    ])
      assert.ok(compact.includes(sentence), sentence);
    assert.equal(tableRows(parsed.text).length, 0, '본문을 표로 오인하지 않음');
  });

  test('여러 페이지 표: 하나로 합치고 반복 헤더를 지우며 행마다 쪽 번호를 단다', async () => {
    const parsed = await parse('PX_LONG_TABLE__r1.pdf');
    assert.equal(parsed.stats.pageCount, 2);
    assert.ok(
      parsed.warnings.some((w) => w.code === 'table_merged_across_pages'),
    );
    const rows = tableRows(parsed.text);
    assert.equal(rows.length, 60);
    assert.deepEqual(
      rows.map((r) => r.location.cells?.[0]),
      Array.from({ length: 60 }, (_, i) => `${i + 1}차시`),
    );
    assert.ok(
      !rows.some((r) => r.location.cells?.[0] === '차시'),
      '반복 헤더 없음',
    );
    assert.equal(rows[0].location.page, 1);
    assert.equal(rows[59].location.page, 2);
    assert.deepEqual(rows[44].location.cells, [
      '45차시',
      '지구계 6',
      '실험',
      '12월 7일',
    ]);
  });

  test('혼합 PDF: 텍스트 페이지는 텍스트로, 이미지 페이지는 OCR(끄면 검수 필요)로 표시', async () => {
    const parsed = await parse('PX_MIXED__r1.pdf');
    assert.equal(parsed.pages[0].method, 'text');
    assert.equal(parsed.pages[1].method, 'empty');
    assert.equal(parsed.pages[1].needsReview, true);
    assert.equal(parsed.status, 'needs_review');
    assert.ok(
      parsed.warnings.some((w) => w.code === 'ocr_unavailable' && w.page === 2),
    );
    assert.ok(parsed.text.includes('310,000원'));
  });
});

describe('DOCX · HWPX · TXT', () => {
  test('DOCX: 제목 스타일과 표', async () => {
    const parsed = await parse('PX_DOCX_SHUTTLE__r1.docx');
    assert.equal(parsed.format, 'docx');
    assert.match(parsed.text, /^# 파싱테스트학원 셔틀버스 운행표$/m);
    assert.match(parsed.text, /^## 1\. 노선별 시각$/m);
    assert.deepEqual(tableRows(parsed.text)[1].location.cells, [
      '한빛초 후문',
      '15:28',
      '17:58',
    ]);
  });

  test('HWPX: 문단과 표(번호 문단은 절 제목)', async () => {
    const parsed = await parse('PX_HWPX_REFUND__r1.hwpx');
    assert.equal(parsed.format, 'hwpx');
    assert.match(parsed.text, /^## 1\. 환불 기준$/m);
    assert.deepEqual(tableRows(parsed.text)[1].location.cells, [
      '1/3 경과 전',
      '수강료의 2/3',
    ]);
  });

  test('TXT: EUC-KR 자동 판별, 개인 휴대폰 번호는 가리고 대표번호는 둔다', async () => {
    const parsed = await parse('PX_TXT_EUCKR__r1.txt');
    assert.ok(parsed.warnings.some((w) => w.code === 'decoded_as_euc_kr'));
    assert.ok(parsed.warnings.some((w) => w.code === 'pii_masked'));
    assert.ok(parsed.text.includes('031-555-0100'));
    assert.ok(parsed.text.includes(PII_MASK));
    assert.ok(!parsed.text.includes('010-1234-5678'));
  });
});

describe('파일 안전성·실패 처리', () => {
  test('구형 HWP(바이너리)는 지원하지 않음으로 실패', async () => {
    const bytes = new Uint8Array([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0,
    ]);
    const parsed = await parseSourceFile({
      bytes,
      fileName: '안내문.hwp',
      ocr: null,
    });
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error, 'unsupported_hwp_binary');
  });

  test('크기·페이지 수 제한', async () => {
    const big = await parseSourceFile({
      bytes: file('PX_FEE_TABLE__r1.pdf'),
      fileName: 'a.pdf',
      ocr: null,
      limits: { maxBytes: 1000 },
    });
    assert.equal(big.error, 'too_large');
    const pages = await parse('PX_LONG_TABLE__r1.pdf', {
      limits: { maxPages: 1 },
    });
    assert.equal(pages.error, 'too_many_pages');
  });

  test('손상된 PDF 는 실패로 처리(예외로 죽지 않음)', async () => {
    const bytes = new TextEncoder().encode(
      '%PDF-1.7\n1 0 obj << /Type /Catalog >> broken',
    );
    const parsed = await parseSourceFile({
      bytes,
      fileName: 'broken.pdf',
      ocr: null,
    });
    assert.equal(parsed.status, 'failed');
  });

  test('압축 폭탄형 DOCX(해제 크기 초과)는 거부', async () => {
    const bomb = zipSync({ 'word/document.xml': new Uint8Array(5_000_000) });
    const parsed = await parseSourceFile({
      bytes: bomb,
      fileName: 'bomb.docx',
      ocr: null,
      limits: { maxUnzippedBytes: 1_000_000 },
    });
    assert.equal(parsed.error, 'zip_limits_exceeded');
  });

  test('XML 외부 엔터티(XXE)를 해석하지 않는다', async () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>안내 &e; 끝</w:t></w:r></w:p></w:body></w:document>';
    const docx = zipSync({ 'word/document.xml': strToU8(xml) });
    const parsed = await parseSourceFile({
      bytes: docx,
      fileName: 'x.docx',
      ocr: null,
    });
    assert.ok(!parsed.text.includes('root:'));
  });
});

describe('청크 출처·중복', () => {
  const revision = (documentId: string): StoredDocumentRevision => ({
    academyId: 'AC_P',
    documentId,
    revision: 1,
    documentType: 'fee',
    title: '수강료표',
    visibility: 'academy_public',
    studentId: null,
    classId: null,
    validFrom: 0,
    validTo: null,
    approvedAt: 0,
    activatedAt: null,
    sourceId: `${documentId}:r1:body`,
    status: 'indexing',
    contentHash: 'x',
    flags: [],
    chunkIds: [],
    indexGeneration: 0,
  });

  test('표 행 청크는 쪽·절·표·행 위치를 갖는다', async () => {
    const parsed = await parse('PX_LONG_TABLE__r1.pdf');
    const chunks = buildChunks(revision('PX_LONG'), parsed.text, () => false);
    const last = chunks.filter((c) => c.location.kind === 'table_row').at(-1);
    assert.equal(last?.location.page, 2);
    assert.match(
      last?.location.label ?? '',
      /^2쪽 · 파싱테스트학원 2학기 차시별 커리큘럼 · 표 1 · 60행$/,
    );
  });

  test('같은 본문을 다른 문서 ID 로 다시 올리면 중복으로 표시하고 검색에서 뺀다', async () => {
    const store = new InMemoryRagStore();
    const meta = {
      academyId: 'AC_P',
      revision: 1,
      documentType: 'fee' as const,
      title: '수강료표',
      visibility: 'academy_public' as const,
      validFrom: '2026-11-01T00:00:00+09:00',
      approvedAt: '2026-10-30T00:00:00+09:00',
    };
    for (const documentId of ['PX_FEE_A', 'PX_FEE_B']) {
      const prepared = await prepareFileDocument(
        { ...meta, documentId },
        { bytes: file('PX_FEE_TABLE__r1.pdf'), fileName: 'fee.pdf' },
        { ocr: null },
      );
      assert.ok(prepared.document);
      const result = await store.upsertIndexedRevision({
        document: prepared.document,
        approve: true,
      });
      assert.equal(result.status, 'activated');
    }
    const access: RagAccessScope = {
      actorId: 'v',
      academyId: 'AC_P',
      role: 'visitor',
      allowedStudentIds: [],
      allowedClassIds: [],
      studentRefs: [],
      canViewPublicHistory: false,
    };
    const results = await store.searchApprovedChunks({
      access,
      studentIds: [],
      asOf: parseInstant('2026-11-10T12:00:00+09:00'),
      query: '중2 내신반 수강료',
      limit: 20,
    });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.chunk.documentId === 'PX_FEE_A'));
  });
});

describe('스캔 PDF OCR', () => {
  let engine: OcrEngine | null = null;
  before(async () => {
    if (!process.env.RAG_SKIP_OCR) engine = await createTesseractOcr();
  });
  after(async () => {
    await engine?.terminate();
  });

  test(
    '양호한 스캔: 표 금액을 읽고 신뢰도를 기록한다',
    { timeout: 120_000 },
    async (t) => {
      if (!engine) return t.skip('OCR 엔진 없음');
      const parsed = await parse('PX_SCAN_GOOD__r1.pdf', { ocr: engine });
      assert.equal(parsed.pages[0].method, 'ocr');
      assert.ok((parsed.pages[0].confidence ?? 0) >= 70);
      assert.ok(
        parsed.text.includes('15,000원') && parsed.text.includes('18,000원'),
      );
      assert.ok(parsed.text.includes('031-555-0199'));
    },
  );

  test(
    '뒤집힌(180도) 스캔: 방향을 찾아 읽는다',
    { timeout: 120_000 },
    async (t) => {
      if (!engine) return t.skip('OCR 엔진 없음');
      const parsed = await parse('PX_SCAN_ROT180__r1.pdf', { ocr: engine });
      assert.equal(parsed.pages[0].rotation, 180);
      assert.ok(parsed.text.includes('실험 재료비'));
    },
  );

  test(
    '화질이 나쁜 스캔: 내용을 지어내지 않고 검수 필요로 표시',
    { timeout: 180_000 },
    async (t) => {
      if (!engine) return t.skip('OCR 엔진 없음');
      const parsed = await parse('PX_SCAN_POOR__r1.pdf', { ocr: engine });
      assert.equal(parsed.status, 'needs_review');
      assert.equal(parsed.pages[0].needsReview, true);
      assert.ok(parsed.warnings.some((w) => w.code === 'ocr_low_confidence'));
    },
  );
});
