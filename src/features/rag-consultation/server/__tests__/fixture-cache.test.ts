import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  buildAcademiesStore,
  type AcademiesDataset,
} from '../adapters/fixture/load-academies.ts';
import type { OcrEngine } from '../ingest/parsers/types.ts';

function isolateCache(t: TestContext) {
  const previous = process.env.RAG_MODEL_CACHE_DIR;
  const directory = mkdtempSync(join(tmpdir(), 'axr-rag-cache-'));
  process.env.RAG_MODEL_CACHE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.RAG_MODEL_CACHE_DIR;
    else process.env.RAG_MODEL_CACHE_DIR = previous;
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(directory, { recursive: true, force: true });
  });
}

const dataset: AcademiesDataset = {
  academies: [],
  users: [],
  students: [],
  facts: [],
  cases: [],
  documents: [
    {
      meta: {
        document_id: 'CACHE_SCAN',
        revision: 1,
        document_type: 'academy_info',
        title: '캐시 검증 안내',
        status: 'approved_active',
        visibility: 'academy_public',
        class_id: null,
        student_id: null,
        valid_from: '2026-11-01T00:00:00+09:00',
        valid_to: null,
        approved_at: '2026-11-01T00:00:00+09:00',
      },
      body: '',
      file: 'AC_CACHE/documents/scan.pdf',
      source: {
        path: join(
          import.meta.dirname,
          '..',
          '__fixtures__',
          'documents-v1',
          'documents',
          'PX_SCAN_GOOD__r1.pdf',
        ),
        fileName: 'scan.pdf',
        format: 'pdf_scan',
      },
    },
  ],
};

function engine(id: string, text: string): OcrEngine {
  return {
    id,
    async recognize() {
      return {
        confidence: 99,
        words: text
          ? [{ text, confidence: 99, x0: 50, x1: 300, y0: 50, y1: 75 }]
          : [],
      };
    },
    async terminate() {},
  };
}

test('OCR 결과 캐시를 OCR 비활성 실행에서 재사용하지 않는다', async (t) => {
  isolateCache(t);
  await buildAcademiesStore(dataset, undefined, {
    ocr: engine('test-ocr', '공개안내문'),
  });
  await assert.rejects(
    buildAcademiesStore(dataset, undefined, { ocr: null }),
    /원본 파싱 실패/,
  );
});

test('같은 파일도 다른 OCR 엔진의 결과는 별도로 파싱한다', async (t) => {
  isolateCache(t);
  await buildAcademiesStore(dataset, undefined, {
    ocr: engine('first-engine', '첫번째안내문'),
  });
  let text = '';
  let cached = false;
  await buildAcademiesStore(dataset, undefined, {
    ocr: engine('second-engine', '두번째안내문'),
    onParsed: (_document, parsed, hit) => {
      text = parsed.text;
      cached = hit;
    },
  });
  assert.match(text, /두번째안내문/);
  assert.equal(cached, false);
  await buildAcademiesStore(dataset, undefined, {
    ocr: engine('second-engine', '사용되면안되는문구'),
    onParsed: (_document, parsed, hit) => {
      text = parsed.text;
      cached = hit;
    },
  });
  assert.match(text, /두번째안내문/);
  assert.equal(cached, true);
});

test('파싱 실패는 같은 엔진으로 재시도할 수 있다', async (t) => {
  isolateCache(t);
  await assert.rejects(
    buildAcademiesStore(dataset, undefined, {
      ocr: engine('retry-engine', ''),
    }),
    /원본 파싱 실패/,
  );
  let cached = true;
  await buildAcademiesStore(dataset, undefined, {
    ocr: engine('retry-engine', '복구된안내문'),
    onParsed: (_document, _parsed, hit) => {
      cached = hit;
    },
  });
  assert.equal(cached, false);
});
