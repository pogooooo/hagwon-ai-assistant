import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { parseSourceFile } from '../ingest/parsers/index.ts';
import { splitIntoBlocks } from '../ingest/chunking.ts';
import { prepareFileDocument } from '../ingest/ingest-file.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { runQuery } from './helpers.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createOperationsServer } from '../../../academy-operations/application.ts';
import { getActor } from '../../../academy-operations/directory.ts';
import { documentsModule } from '../../../academy-operations/documents.ts';
import { consultationModule } from '../../../academy-operations/consultation.ts';
const zip = (data: Record<string, string>) =>
  zipSync(
    Object.fromEntries(Object.entries(data).map(([k, v]) => [k, strToU8(v)])),
  );
export const workbookBytes = (className = '중2 심화반') =>
  zip({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="반별 수강료" r:id="two"/><sheet name="비공개 메모" state="hidden" r:id="one"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="one" Target="worksheets/sheet1.xml"/><Relationship Id="two" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst><si><t>반</t></si><si><t>월 수강료</t></si><si><t>${className}</t></si><si><t>중1 기본반</t></si></sst>`,
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>숨긴 비밀번호</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>310000</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>250000</v></c></row><row r="4" hidden="1"><c r="A4" t="inlineStr"><is><t>숨긴 학생 메모</t></is></c></row></sheetData></worksheet>',
  });
test('xlsx shared strings, workbook order, row numbers and hidden content exclusion', async () => {
  const p = await parseSourceFile({
    bytes: workbookBytes(),
    fileName: '수강료.xlsx',
    ocr: null,
  });
  assert.equal(p.status, 'ok');
  assert.equal(p.format, 'xlsx');
  assert.doesNotMatch(p.text, /숨긴/);
  const rows = splitIntoBlocks(p.text).filter(
    (b) => b.location.kind === 'table_row',
  );
  assert.deepEqual(rows[0].location.header, ['원본 행', '반', '월 수강료']);
  assert.deepEqual(rows[0].location.cells, ['2', '중2 심화반', '310000']);
  assert.equal(rows[0].location.page, 1);
  assert.match(rows[0].location.label, /반별 수강료/);
});
test('quoted CSV/TSV preserve delimiters and newlines inside a cell; malformed rows fail', async () => {
  const p = await parseSourceFile({
    bytes: strToU8('반,메모,요금\r\n"중2, 심화","첫 줄\n둘째 줄",310000'),
    fileName: '원본.csv',
  });
  assert.equal(p.format, 'csv');
  assert.equal(p.status, 'ok');
  assert.match(p.text, /중2, 심화/);
  const tsv = await parseSourceFile({
    bytes: strToU8('반\t요일\n중2\t월·수'),
    fileName: '원본.tsv',
  });
  assert.equal(tsv.status, 'ok');
  assert.match(tsv.text, /월·수/);
  for (const text of [
    '반,요금\n중2',
    '반,요금\n"닫히지 않음,2',
    '반,요금\n"중2"오류,3',
  ])
    assert.equal(
      (await parseSourceFile({ bytes: strToU8(text), fileName: 'bad.csv' }))
        .status,
      'failed',
    );
});
test('xlsx dates and times use stored styles; formulas need review and are not evaluated', async () => {
  const p = await parseSourceFile({
    bytes: zip({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="시간표" r:id="one"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="one" Target="worksheets/a.xml"/></Relationships>',
      'xl/styles.xml':
        '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="20"/></cellXfs></styleSheet>',
      'xl/worksheets/a.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>시간</t></is></c><c r="B1" t="inlineStr"><is><t>반</t></is></c></row><row r="2"><c r="A2" s="1"><v>0.75</v></c><c r="B2" t="inlineStr"><is><t>중2 심화반</t></is></c></row><row r="3"><c r="A3"><f>WEBSERVICE("https://example.invalid")</f></c></row></sheetData></worksheet>',
    }),
    fileName: '시간.xlsx',
  });
  assert.match(p.text, /18:00/);
  assert.equal(p.status, 'needs_review');
  assert.match(p.text, /수식 결과 확인 필요/);
  assert.doesNotMatch(p.text, /WEBSERVICE/);
});
test('pptx uses relationship order and slide positions, preserving table cells and excluding notes', async () => {
  const data = {
    'ppt/presentation.xml':
      '<p:presentation><p:sldIdLst><p:sldId r:id="two"/><p:sldId r:id="one"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="one" Target="slides/slide1.xml"/><Relationship Id="two" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml':
      '<p:sld><p:sp><a:p><a:r><a:t>둘째 내용</a:t></a:r></a:p></p:sp></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld><p:sp><a:p><a:r><a:t>먼저 읽는 안내</a:t></a:r></a:p></p:sp><a:tbl><a:tr><a:tc><a:t>반</a:t></a:tc><a:tc><a:t>교실</a:t></a:tc></a:tr><a:tr><a:tc><a:t>중2</a:t></a:tc><a:tc><a:t>301호</a:t></a:tc></a:tr></a:tbl></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '비공개 발표자 메모',
  };
  const p = await parseSourceFile({ bytes: zip(data), fileName: '안내.pptx' });
  assert.equal(p.status, 'ok');
  assert.ok(p.text.indexOf('먼저') < p.text.indexOf('둘째'));
  assert.doesNotMatch(p.text, /비공개/);
  assert.equal(p.stats.pageCount, 2);
  const row = splitIntoBlocks(p.text).find(
    (b) => b.location.kind === 'table_row',
  )!;
  assert.equal(row.location.page, 1);
  assert.deepEqual(row.location.cells, ['중2', '301호']);
});
test('zip limits and excessive coordinates fail instead of allocating an unbounded table', async () => {
  const p = await parseSourceFile({
    bytes: workbookBytes(),
    fileName: 'big.xlsx',
    limits: { maxUnzippedBytes: 10 },
  });
  assert.equal(p.error, 'zip_limits_exceeded');
  const bad = workbookBytes();
  assert.equal(
    (await parseSourceFile({ bytes: bad.slice(0, 40), fileName: 'bad.xlsx' }))
      .status,
    'failed',
  );
});
test('xlsx original → registered approved evidence → search → final fee and exact source', async () => {
  const prepared = await prepareFileDocument(
    {
      academyId: 'A',
      documentId: 'fees',
      revision: 1,
      title: '수강료',
      documentType: 'fee',
      visibility: 'academy_public',
      validFrom: '2026-01-01T00:00:00Z',
      approvedAt: '2026-01-01T00:00:00Z',
    },
    { bytes: workbookBytes(), fileName: '수강료.xlsx' },
    { ocr: null },
  );
  assert.ok(prepared.document);
  const store = new InMemoryRagStore();
  await store.upsertIndexedRevision({
    document: prepared.document!,
    approve: true,
  });
  const access = {
    actorId: 'V',
    academyId: 'A',
    role: 'visitor' as const,
    allowedStudentIds: [],
    allowedClassIds: [],
    studentRefs: [],
    canViewPublicHistory: false,
  };
  const output = await runQuery(
    {
      store,
      resolveScope: () => access,
      catalog: {
        getAcademyCatalog: async () => ({
          academyId: 'A',
          displayName: '테스트 학원',
          aliases: [],
          classes: [
            {
              classId: 'C2',
              name: '중2 심화반',
              aliases: [],
              grade: '중2',
              subject: '수학',
            },
            {
              classId: 'C1',
              name: '중1 기본반',
              aliases: [],
              grade: '중1',
              subject: '수학',
            },
          ],
          units: [],
        }),
      },
    },
    {
      userId: 'V',
      question: '중2 심화반 수강료는?',
      asOf: '2026-11-18T12:00:00+09:00',
      engine: 'planned',
    },
  );
  assert.equal(output.answer.status, 'answered', output.answer.answer);
  assert.match(output.answer.answer, /310,?000/);
  assert.doesNotMatch(output.answer.answer, /250,?000/);
  assert.equal(output.answer.citations[0].documentId, 'fees');
  assert.match(output.answer.citations[0].location ?? '', /반별 수강료/);
});
test('operations upload and approval preserve the original workbook through final consultation citations', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  createOperationsServer({ db, demoPassword: 'synthetic-password' });
  db.exec('DELETE FROM op_document_versions');
  const context = (who = 'TA_DIRECTOR') => ({
    db,
    actor: getActor(db, who)!,
    url: new URL('http://localhost/'),
  });
  const form = (obj: Record<string, string | File>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(obj)) f.set(k, v);
    return f;
  };
  await documentsModule.submit(
    context(),
    form({
      action: 'save',
      title: '원본 Excel 수강료',
      documentType: 'fee',
      visibility: 'academy_public',
      validFrom: '2026-01-01T00:00',
      file: new File([Buffer.from(workbookBytes('중2 내신반'))], '수강료.xlsx'),
    }),
  );
  const doc = db
    .prepare(
      "SELECT document_id,revision,original_name FROM op_document_versions WHERE original_name='수강료.xlsx'",
    )
    .get()!;
  assert.ok(doc);
  assert.equal(doc.original_name, '수강료.xlsx');
  await documentsModule.submit(
    context(),
    form({
      action: 'approve',
      documentId: String(doc.document_id),
      revision: String(doc.revision),
    }),
  );
  const thread = randomUUID();
  await consultationModule.submit(
    context('TA_GUARDIAN_M2'),
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
  assert.equal(answer.citations[0].documentId, doc.document_id);
  assert.match(answer.citations[0].location, /반별 수강료/);
});
