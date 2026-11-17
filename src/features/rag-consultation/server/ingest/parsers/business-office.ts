import { readZip } from './office.ts';
import { toMarkdown, type LayoutBlock } from './layout.ts';
import type { ParseLimits } from './types.ts';

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== '#') return entities[e] ?? m;
    const n =
      e[1].toLowerCase() === 'x'
        ? parseInt(e.slice(2), 16)
        : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
const attr = (s: string, name: string) =>
  decode(
    new RegExp('(?:^|\\s)' + name + '=["\x27]([^"\x27]*)["\x27]').exec(
      s,
    )?.[1] ?? '',
  );
const text = (s: string) =>
  [...s.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)]
    .map((m) => decode(m[1]))
    .join('');
const maxRows = 5000,
  maxColumns = 128;
function displayNumber(
  raw: string,
  format: number,
  code: string,
  date1904: boolean,
) {
  if (!raw || !Number.isFinite(Number(raw)))
    return { value: raw, uncertain: false };
  const n = Number(raw),
    clean = code.replace(/"[^\"]*"|\\.|\[[^\]]*\]/g, '').toLowerCase();
  if ([9, 10].includes(format) || /^0(?:\.0+)?%$/.test(clean))
    return {
      value:
        String(
          Number(
            (n * 100).toFixed(
              format === 10 ? 2 : (/\.(0+)/.exec(clean)?.[1].length ?? 0),
            ),
          ),
        ) + '%',
      uncertain: false,
    };
  const date =
    [14, 15, 16, 17, 22].includes(format) ||
    (/[yd]/.test(clean) && !/[#0]/.test(clean));
  const clock = [18, 19, 20, 21, 22].includes(format) || /[hs]/.test(clean);
  if (date || clock) {
    if (n < 0 || n > 2958465) return { value: raw, uncertain: true };
    const epoch = Date.UTC(
      date1904 ? 1904 : 1899,
      date1904 ? 0 : 11,
      date1904 ? 1 : 30,
    );
    const value = new Date(epoch + Math.round(n * 86400000));
    return {
      value: [
        date ? value.toISOString().slice(0, 10) : '',
        clock ? value.toISOString().slice(11, 16) : '',
      ]
        .filter(Boolean)
        .join(' '),
      uncertain: false,
    };
  }
  if (
    format === 0 ||
    [1, 2, 3, 4, 37, 38, 39, 40].includes(format) ||
    /^[#,0. ]+$/.test(clean)
  )
    return { value: raw, uncertain: false };
  return { value: raw, uncertain: true };
}
function columnIndex(s: string) {
  let n = 0;
  for (const c of s) n = n * 26 + c.charCodeAt(0) - 64;
  if (n < 1 || n > maxColumns) throw new Error('지원 범위를 넘는 표 열');
  return n - 1;
}
const coordinate = (s: string) => {
  const m = /^([A-Z]+)([1-9]\d*)$/.exec(s);
  if (!m || Number(m[2]) > maxRows)
    throw new Error('잘못되거나 너무 큰 셀 범위');
  return { col: columnIndex(m[1]), row: Number(m[2]) };
};
function relationships(xml: string, root: string) {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)) {
    if (attr(m[1], 'TargetMode') === 'External') continue;
    const target = attr(m[1], 'Target');
    if (target.includes('..') || target.includes('\\') || target.includes(':'))
      continue;
    out.set(
      attr(m[1], 'Id'),
      target.startsWith('/') ? target.slice(1) : root + target,
    );
  }
  return out;
}

/** Quoted delimiters/newlines are cells, never executed formulas. */
export function parseDelimited(value: string, delimiter: ',' | '\t') {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const pushCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
    if (row.length > maxColumns) throw new Error('표 열 한도');
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new Error('표 행 한도');
  };
  const input = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
    } else if (c === delimiter) pushCell();
    else if (c === '\n') pushRow();
    else if (c === '"' && cell === '' && !closed) quoted = true;
    else if (closed) {
      if (!/\s/.test(c)) throw new Error('잘못된 따옴표');
    } else if (c === '"') throw new Error('잘못된 따옴표');
    else cell += c;
  }
  if (quoted) throw new Error('닫히지 않은 따옴표');
  if (cell || row.length || closed) pushRow();
  while (rows.length && rows.at(-1)!.every((c) => !c.trim())) rows.pop();
  if (!rows.length) return { text: '', tables: 0 };
  const width = Math.max(...rows.map((r) => r.length));
  if (rows.some((r) => r.length !== width))
    throw new Error('행마다 열 개수가 다른 표');
  const [header, ...body] = rows;
  return {
    text: toMarkdown([
      {
        kind: 'table',
        page: 1,
        rows: [header.map((c, i) => c || `열 ${i + 1}`), ...body],
      },
    ]),
    tables: 1,
  };
}

/** Workbook relationships define order; hidden sheets and rows are excluded. */
export function parseXlsx(bytes: Uint8Array, limits: ParseLimits) {
  const files = readZip(bytes, limits, (n) =>
    /^xl\/(workbook\.xml|_rels\/workbook\.xml.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(
      n,
    ),
  );
  if (!files['xl/workbook.xml'] || !files['xl/_rels/workbook.xml.rels'])
    throw new Error('통합 문서 정보 없음');
  const links = relationships(files['xl/_rels/workbook.xml.rels'], 'xl/');
  const shared = [
    ...(files['xl/sharedStrings.xml'] ?? '').matchAll(
      /<si\b[^>]*>([\s\S]*?)<\/si>/g,
    ),
  ].map((m) => text(m[1]));
  const formats = new Map<number, string>();
  for (const m of (files['xl/styles.xml'] ?? '').matchAll(
    /<numFmt\b([^>]*)\/?\s*>/g,
  ))
    formats.set(Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode'));
  const styles = [
    ...(
      /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(
        files['xl/styles.xml'] ?? '',
      )?.[1] ?? ''
    ).matchAll(/<xf\b([^>]*)\/?\s*>/g),
  ].map((m) => Number(attr(m[1], 'numFmtId')));
  const sheets = [
    ...files['xl/workbook.xml'].matchAll(/<sheet\b([^>]*)\/?\s*>/g),
  ];
  if (sheets.length > limits.maxPages) throw new Error('시트 한도');
  const blocks: LayoutBlock[] = [];
  let tables = 0,
    needsReview = false;
  const date1904 = /<workbookPr\b[^>]*date1904=["'](?:1|true)["']/.test(
    files['xl/workbook.xml'],
  );
  for (const [i, sheet] of sheets.entries()) {
    if (attr(sheet[1], 'state') && attr(sheet[1], 'state') !== 'visible')
      continue;
    const xml = files[links.get(attr(sheet[1], 'r:id')) ?? ''];
    if (!xml) throw new Error('시트 연결 없음');
    const cells = new Map<number, Map<number, string>>();
    let width = 0;
    const hiddenColumns = new Set<number>();
    for (const m of xml.matchAll(/<col\b([^>]*)\/?\s*>/g))
      if (attr(m[1], 'hidden') === '1') {
        const start = Number(attr(m[1], 'min')),
          end = Number(attr(m[1], 'max'));
        if (start < 1 || end > maxColumns || end < start)
          throw new Error('열 범위');
        for (let c = start; c <= end; c++) hiddenColumns.add(c - 1);
      }
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      if (attr(r[1], 'hidden') === '1') continue;
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const pos = coordinate(attr(c[1], 'r'));
        if (hiddenColumns.has(pos.col)) continue;
        const body = c[2] ?? '',
          type = attr(c[1], 't'),
          raw = decode(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        let value =
          type === 's'
            ? shared[Number(raw)]
            : type === 'inlineStr'
              ? text(body)
              : type === 'b'
                ? raw === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : raw;
        if (value === undefined || type === 'e')
          throw new Error('잘못된 셀 값');
        // Do not guess formatted dates/times, percentages or stale formula caches.
        const style = styles[Number(attr(c[1], 's') || '0')] ?? 0;
        if (!['s', 'inlineStr', 'b', 'str', 'd'].includes(type)) {
          const displayed = displayNumber(
            raw,
            style,
            formats.get(style) ?? '',
            date1904,
          );
          value = displayed.value;
          needsReview ||= displayed.uncertain;
        }
        if (/<f\b/.test(body)) needsReview = true;
        if (/<f\b/.test(body) && !raw) value = '[수식 결과 확인 필요]';
        const row = cells.get(pos.row) ?? new Map<number, string>();
        row.set(pos.col, value);
        cells.set(pos.row, row);
        width = Math.max(width, pos.col + 1);
      }
    }
    // Merged context is repeated only from an existing top-left cell.
    for (const m of xml.matchAll(/<mergeCell\b([^>]*)\/?\s*>/g)) {
      const range = attr(m[1], 'ref').split(':');
      if (range.length !== 2) throw new Error('병합 범위');
      const a = coordinate(range[0]),
        b = coordinate(range[1]);
      if (
        b.row < a.row ||
        b.col < a.col ||
        (b.row - a.row + 1) * (b.col - a.col + 1) > 20000
      )
        throw new Error('병합 한도');
      const value = cells.get(a.row)?.get(a.col);
      if (value === undefined) continue;
      for (let row = a.row; row <= b.row; row++)
        for (let col = a.col; col <= b.col; col++)
          if (cells.has(row) && !hiddenColumns.has(col)) {
            const old = cells.get(row)!.get(col);
            if (old && old !== value) throw new Error('겹친 병합 셀');
            cells.get(row)!.set(col, value);
          }
      width = Math.max(width, b.col + 1);
      needsReview = true;
    }
    const columns = Array.from({ length: width }, (_, c) => c).filter(
      (c) => !hiddenColumns.has(c),
    );
    const values = [...cells]
      .sort((a, b) => a[0] - b[0])
      .filter(([, row]) => [...row.values()].some(Boolean));
    if (!values.length) continue;
    blocks.push({
      kind: 'heading',
      page: i + 1,
      level: 2,
      text: `시트 ${attr(sheet[1], 'name')}`,
    });
    const groups: (typeof values)[] = [];
    for (const value of values) {
      const group = groups.at(-1);
      if (!group || value[0] > group.at(-1)![0] + 1) groups.push([value]);
      else group.push(value);
    }
    for (const group of groups) {
      const unique = [...new Set([...group[0][1].values()].filter(Boolean))];
      if (
        unique.length === 1 &&
        (group.length === 1 ||
          [...group[1][1].values()].filter(Boolean).length > 1)
      ) {
        blocks.push({ kind: 'paragraph', page: i + 1, text: unique[0] });
        group.shift();
      }
      if (!group.length) continue;
      const [head, ...body] = group;
      if (!body.length) {
        blocks.push({
          kind: 'paragraph',
          page: i + 1,
          text: [...head[1].values()].join(' · '),
        });
        continue;
      }
      blocks.push({
        kind: 'heading',
        page: i + 1,
        level: 2,
        text: `시트 ${attr(sheet[1], 'name')} · 원본 행 ${head[0]}~${group.at(-1)![0]}`,
      });
      blocks.push({
        kind: 'table',
        page: i + 1,
        rows: [
          ['원본 행', ...columns.map((c) => head[1].get(c) || `열 ${c + 1}`)],
          ...body.map(([r, row]) => [
            String(r),
            ...columns.map((c) => row.get(c) ?? ''),
          ]),
        ],
      });
      tables++;
    }
  }
  return {
    text: toMarkdown(blocks),
    tables,
    pageCount: sheets.length,
    needsReview,
  };
}

/** Slides follow presentation relationships; speaker notes are not public text. */
export function parsePptx(bytes: Uint8Array, limits: ParseLimits) {
  const files = readZip(bytes, limits, (n) =>
    /^ppt\/(presentation\.xml|_rels\/presentation\.xml.rels|slides\/[^/]+\.xml)$/.test(
      n,
    ),
  );
  if (
    !files['ppt/presentation.xml'] ||
    !files['ppt/_rels/presentation.xml.rels']
  )
    throw new Error('프레젠테이션 정보 없음');
  const links = relationships(files['ppt/_rels/presentation.xml.rels'], 'ppt/');
  const slides = [
    ...files['ppt/presentation.xml'].matchAll(/<p:sldId\b([^>]*)\/?\s*>/g),
  ];
  if (slides.length > limits.maxPages) throw new Error('슬라이드 한도');
  const blocks: LayoutBlock[] = [];
  let tables = 0,
    needsReview = false;
  for (const [i, slide] of slides.entries()) {
    const xml = files[links.get(attr(slide[1], 'r:id')) ?? ''];
    if (!xml) throw new Error('슬라이드 연결 없음');
    if (/<p:sld\b[^>]*\bshow=["']0["']/.test(xml)) continue;
    blocks.push({
      kind: 'heading',
      page: i + 1,
      level: 2,
      text: `슬라이드 ${i + 1}`,
    });
    if (/<(?:p:pic|c:chart)\b/.test(xml)) needsReview = true;
    for (const part of xml.matchAll(
      /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>|<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g,
    )) {
      if (part[1] !== undefined) {
        if (/\b(?:gridSpan|rowSpan|hMerge|vMerge)=/.test(part[1]))
          throw new Error('병합된 슬라이드 표는 PDF 또는 DOCX로 변환해 주세요');
        const rows = [
          ...part[1].matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g),
        ].map((r) =>
          [...r[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((c) =>
            text(c[1]),
          ),
        );
        if (
          rows.length > maxRows ||
          rows.some((r) => r.length > maxColumns || r.length !== rows[0].length)
        )
          throw new Error('표 한도/열 불일치');
        if (rows.length) {
          blocks.push({ kind: 'table', page: i + 1, rows });
          tables++;
        }
      } else
        for (const p of part[2].matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
          const value = text(p[1]);
          if (value.trim())
            blocks.push({ kind: 'paragraph', page: i + 1, text: value });
        }
    }
  }
  return {
    text: toMarkdown(blocks),
    tables,
    pageCount: slides.length,
    needsReview,
  };
}
