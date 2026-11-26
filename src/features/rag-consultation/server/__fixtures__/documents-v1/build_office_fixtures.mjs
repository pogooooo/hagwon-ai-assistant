/**
 * 파서 시험용 DOCX·HWPX·혼합 PDF·EUC-KR TXT 를 만든다(개발 전용 자료 생성 도구).
 *   node src/features/rag-consultation/server/__fixtures__/documents-v1/build_office_fixtures.mjs
 * 먼저 ../academies-v2/render_pdfs.mjs 로 PX_FEE_TABLE·PX_SCAN_GOOD PDF 를 만들어 두어야 한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { strToU8, zipSync } from 'fflate';

const { PDFDocument } = await import('pdf-lib');
const dir = join(dirname(fileURLToPath(import.meta.url)), 'documents');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- DOCX ----------
const wp = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const wtable = (rows) =>
  `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${wp(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const docxBody = [
  wp('파싱테스트학원 셔틀버스 운행표', 'Title'),
  wp('1. 노선별 시각', 'Heading1'),
  wp('셔틀버스는 평일에만 운행하며 토요일에는 운행하지 않습니다.'),
  wtable([
    ['정류장', '1회차 등원', '2회차 등원'],
    ['푸른마을 정문', '15:20', '17:50'],
    ['한빛초 후문', '15:28', '17:58'],
    ['학원 도착', '15:40', '18:10'],
  ]),
  wp('2. 이용료', 'Heading1'),
  wp('왕복 이용료는 월 40,000원, 편도는 월 25,000원입니다.'),
].join('');
const docx = zipSync({
  '[Content_Types].xml': strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ),
  '_rels/.rels': strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  ),
  'word/document.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docxBody}</w:body></w:document>`,
  ),
});
writeFileSync(join(dir, 'PX_DOCX_SHUTTLE__r1.docx'), docx);

// ---------- HWPX ----------
const hp = (text) => `<hp:p><hp:run><hp:t>${esc(text)}</hp:t></hp:run></hp:p>`;
const htable = (rows) =>
  `<hp:p><hp:run><hp:tbl>${rows.map((r) => `<hp:tr>${r.map((c) => `<hp:tc><hp:subList>${hp(c)}</hp:subList></hp:tc>`).join('')}</hp:tr>`).join('')}</hp:tbl></hp:run></hp:p>`;
const section = [
  hp('파싱테스트학원 환불 규정'),
  hp('1. 환불 기준'),
  hp('학원법 시행령에 따라 수업 시작 전에는 전액, 총 수업 시간의 1/3 경과 전에는 2/3를 환불합니다.'),
  htable([
    ['구분', '환불 금액'],
    ['수업 시작 전', '이미 낸 수강료 전액'],
    ['1/3 경과 전', '수강료의 2/3'],
    ['1/2 경과 후', '환불 없음'],
  ]),
  hp('2. 신청 방법'),
  hp('환불은 데스크에 신청서를 내면 7일 이내에 처리합니다.'),
].join('');
const hwpx = zipSync({
  mimetype: [strToU8('application/hwp+zip'), { level: 0 }],
  'Contents/content.hpf': strToU8('<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"/>'),
  'Contents/section0.xml': strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${section}</hs:sec>`,
  ),
});
writeFileSync(join(dir, 'PX_HWPX_REFUND__r1.hwpx'), hwpx);

// ---------- 혼합 PDF(텍스트 페이지 + 스캔 페이지) ----------
const mixed = await PDFDocument.create();
for (const name of ['PX_FEE_TABLE__r1.pdf', 'PX_SCAN_GOOD__r1.pdf']) {
  const source = await PDFDocument.load(readFileSync(join(dir, name)));
  const [page] = await mixed.copyPages(source, [0]);
  mixed.addPage(page);
}
writeFileSync(join(dir, 'PX_MIXED__r1.pdf'), await mixed.save());
console.log('built docx, hwpx, mixed pdf');
