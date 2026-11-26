import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
export const feeRows = [
  ['반', '수강료'],
  ['중2 내신반', '310000원'],
  ['중1 기본반', '250000원'],
];
export const feeMarkdown =
  '# 반별 수강료\n\n| 반 | 수강료 |\n| --- | --- |\n| 중2 내신반 | 310000원 |\n| 중1 기본반 | 250000원 |';
export const feeBytes = (name: string) =>
  new Uint8Array(
    readFileSync(new URL('./document-formats/' + name, import.meta.url)),
  );
const zip = (entries: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, strToU8(v)]),
    ),
  );
export function officeFee(
  format: 'docx' | 'hwpx' | 'xlsx' | 'pptx',
  extra = '',
) {
  if (format === 'docx' || format === 'hwpx') {
    const prefix = format === 'docx' ? 'w' : 'hp';
    const p = (text: string) =>
      `<${prefix}:p><${prefix}:r><${prefix}:t>${text}</${prefix}:t></${prefix}:r></${prefix}:p>`;
    const table = `<${prefix}:tbl>${feeRows.map((row) => `<${prefix}:tr>${row.map((value) => `<${prefix}:tc>${p(value)}</${prefix}:tc>`).join('')}</${prefix}:tr>`).join('')}</${prefix}:tbl>`;
    return format === 'docx'
      ? zip({
          '[Content_Types].xml':
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          '_rels/.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('반별 수강료')}${table}${extra}</w:body></w:document>`,
        })
      : zip({
          mimetype: 'application/hwp+zip',
          'Contents/section0.xml': `<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${p('반별 수강료')}${table}${extra}</hp:sec>`,
        });
  }
  if (format === 'xlsx')
    return zip({
      'xl/workbook.xml':
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="반별 수강료" r:id="fees"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="fees" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        feeRows
          .map(
            (row, r) =>
              `<row r="${r + 1}">${row.map((value, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`,
          )
          .join('') +
        '</sheetData></worksheet>',
    });
  return zip({
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="fees"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':
      '<Relationships><Relationship Id="fees" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml':
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData><a:tbl>' +
      feeRows
        .map(
          (row) =>
            '<a:tr>' +
            row
              .map(
                (v) =>
                  '<a:tc><a:txBody><a:p><a:r><a:t>' +
                  v +
                  '</a:t></a:r></a:p></a:txBody></a:tc>',
              )
              .join('') +
            '</a:tr>',
        )
        .join('') +
      '</a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
  });
}
export function allFeeFormats() {
  return [
    { name: '수강료.pdf', bytes: feeBytes('fees.pdf') },
    ...(['docx', 'hwpx', 'xlsx', 'pptx'] as const).map((ext) => ({
      name: '수강료.' + ext,
      bytes: officeFee(ext),
    })),
    {
      name: '수강료.csv',
      bytes: strToU8(feeRows.map((r) => r.join(',')).join('\n')),
    },
    {
      name: '수강료.tsv',
      bytes: strToU8(feeRows.map((r) => r.join('\t')).join('\n')),
    },
    ...['txt', 'md', 'markdown'].map((ext) => ({
      name: '수강료.' + ext,
      bytes: strToU8(feeMarkdown),
    })),
    ...['png', 'jpg', 'jpeg', 'webp', 'bmp'].map((ext) => ({
      name: '수강료.' + ext,
      bytes: feeBytes('fees.' + (ext === 'jpeg' ? 'jpg' : ext)),
      image: true,
    })),
  ];
}
