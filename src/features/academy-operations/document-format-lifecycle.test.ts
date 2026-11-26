import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createOperationsServer } from './application.ts';
import { getActor } from './directory.ts';
import {
  documentsModule,
  currentDocumentRevisions,
  documentDownload,
} from './documents.ts';
import { consultationModule } from './consultation.ts';
import type { PageContext } from './shared.ts';
import {
  allFeeFormats,
  feeBytes,
  feeRows,
  officeFee,
} from './__fixtures__/document-formats.ts';
import { parseSourceFile } from '../rag-consultation/server/ingest/parsers/index.ts';
import { splitIntoBlocks } from '../rag-consultation/server/ingest/chunking.ts';
const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
for (const source of allFeeFormats())
  test(
    source.name +
      ' → draft → approved search → precise class/fee/citation → revision → withdrawal',
    async (t) => {
      const db = new DatabaseSync(':memory:');
      t.after(() => db.close());
      createOperationsServer({ db, demoPassword: 'synthetic-password' });
      db.exec('DELETE FROM op_document_versions');
      const ctx = (who = 'TA_DIRECTOR'): PageContext => ({
        db,
        actor: getActor(db, who)!,
        url: new URL('http://localhost/documents'),
        scanVision: {
          id: 'fixture',
          async readPage(_bytes, page) {
            return {
              blocks: [{ kind: 'table', page, rows: feeRows }],
              issues: [],
            };
          },
        },
      });
      await documentsModule.submit(
        ctx(),
        form({
          action: 'save',
          title: source.name,
          documentType: 'fee',
          visibility: 'academy_public',
          validFrom: '2020-01-01T00:00',
          ...('image' in source ? { clovaScan: '1' } : {}),
          file: new File([new Uint8Array(source.bytes)], source.name),
        }),
      );
      const row = db
        .prepare(
          'SELECT document_id,revision,original_name FROM op_document_versions',
        )
        .get()!;
      const id = String(row.document_id);
      assert.equal(row.original_name, source.name);
      assert.equal(currentDocumentRevisions(ctx('TA_VISITOR')).has(id), false);
      await documentsModule.submit(
        ctx(),
        form({ action: 'approve', documentId: id, revision: '1' }),
      );
      const query = async () => {
        const conversationId = randomUUID();
        await consultationModule.submit(
          ctx('TA_GUARDIAN_M2'),
          form({
            action: 'ask',
            conversationId,
            question: '중2 내신반 수강료는?',
          }),
        );
        return JSON.parse(
          String(
            db
              .prepare(
                "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer'",
              )
              .get(conversationId)!.response,
          ),
        );
      };
      const answer = await query();
      assert.equal(answer.status, 'answered', answer.answer);
      assert.match(answer.answer, /310,?000/);
      assert.doesNotMatch(answer.answer, /250,?000/);
      assert.equal(answer.citations[0].documentId, id);
      assert.equal(answer.citations[0].revision, 1);
      const stored = JSON.parse(
        String(
          db
            .prepare(
              'SELECT input FROM op_document_versions WHERE document_id=? AND revision=1',
            )
            .get(id)!.input,
        ),
      );
      const selected = splitIntoBlocks(stored.text).find((block) => {
        const content = block.text.replace(/\s|,/g, '');
        return (
          content.includes('중2내신반') &&
          content.includes('310000원') &&
          !content.includes('250000원')
        );
      });
      assert.ok(
        selected,
        'A distinct source block must contain the requested class and amount',
      );
      assert.ok(
        answer.citations.some((citation: { location?: string }) =>
          citation.location?.includes(selected.location.label),
        ),
      );
      if (selected.location.kind === 'table_row') {
        assert.equal(selected.location.rowIndex, 1);
        assert.match(answer.citations[0].location, /수강료/);
      } else assert.match(answer.citations[0].location, /문단/);
      const original = await documentDownload({
        ...ctx(),
        url: new URL(
          'http://localhost/documents?id=' + id + '&revision=1&original=1',
        ),
      });
      assert.ok(original);
      assert.deepEqual(
        Buffer.from(original.content),
        Buffer.from(source.bytes),
      );
      await documentsModule.submit(
        ctx(),
        form({
          action: 'save',
          documentId: id,
          baseRevision: '1',
          title: source.name,
          documentType: 'fee',
          visibility: 'academy_public',
          validFrom: '2020-01-01T00:00',
          text: '# 반별 수강료\n| 반 | 수강료 |\n| --- | --- |\n| 중2 내신반 | 330000원 |\n| 중1 기본반 | 250000원 |',
        }),
      );
      await documentsModule.submit(
        ctx(),
        form({ action: 'approve', documentId: id, revision: '2' }),
      );
      const after = await query();
      assert.match(after.answer, /330,?000/);
      assert.doesNotMatch(after.answer, /310,?000/);
      assert.equal(after.citations[0].revision, 2);
      assert.match(after.citations[0].location, /표 1 · 1행/);
      await documentsModule.submit(
        ctx(),
        form({ action: 'withdraw', documentId: id, revision: '2' }),
      );
      const withdrawn = await query();
      assert.notEqual(withdrawn.status, 'answered');
      assert.equal(withdrawn.citations.length, 0);
    },
  );

test('scanned PDF uses image evidence locally and is rejected by the hosted renderer limitation', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createOperationsServer({ db, demoPassword: 'synthetic-password' });
  const ctx: PageContext = {
    db,
    actor: getActor(db, 'TA_DIRECTOR')!,
    url: new URL('http://localhost/documents'),
    scanVision: {
      id: 'fixture',
      async readPage(_bytes, page) {
        return { blocks: [{ kind: 'table', page, rows: feeRows }], issues: [] };
      },
    },
  };
  const upload = () =>
    form({
      action: 'save',
      title: '스캔 원본',
      documentType: 'fee',
      visibility: 'academy_public',
      clovaScan: '1',
      validFrom: '2020-01-01T00:00',
      file: new File([feeBytes('fees-scan.pdf')], 'scan.pdf'),
    });
  await documentsModule.submit(ctx, upload());
  await assert.rejects(
    async () =>
      documentsModule.submit({ ...ctx, scanPdfAvailable: false }, upload()),
    /스캔 PDF/,
  );
});

test('unsupported legacy and image files fail explicitly; embedded Office pictures require review', async () => {
  for (const name of ['old.hwp', 'old.doc', 'old.xls', 'old.ppt']) {
    const result = await parseSourceFile({
      bytes: Uint8Array.of(208, 207, 17, 224, 0, 0),
      fileName: name,
      ocr: null,
    });
    assert.equal(result.status, 'failed');
  }
  for (const ext of ['heic', 'tiff', 'gif', 'svg']) {
    const result = await parseSourceFile({
      bytes: Buffer.from('unsupported'),
      fileName: 'image.' + ext,
      ocr: null,
    });
    assert.equal(result.status, 'failed');
  }
  for (const [ext, extra] of [
    ['docx', '<w:p><w:r><w:drawing><a:graphic/></w:drawing></w:r></w:p>'],
    ['hwpx', '<hp:p><hp:run><hp:pic/></hp:run></hp:p>'],
  ] as const) {
    const result = await parseSourceFile({
      bytes: officeFee(ext, extra),
      fileName: 'mixed.' + ext,
      ocr: null,
    });
    assert.equal(result.status, 'needs_review');
    assert.ok(result.warnings.some((w) => w.code === 'office_review'));
  }
});
