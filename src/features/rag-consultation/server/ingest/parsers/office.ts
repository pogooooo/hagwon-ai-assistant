/**
 * DOCX(OOXML)·HWPX(OWPML) 파서: ZIP 해제(fflate, 크기·항목 수 제한) → 본문 XML 의 문단·표를 정규화 블록으로.
 * - DOCX: word/document.xml 의 w:p(스타일 Heading/제목 → 절), w:tbl/w:tr/w:tc
 * - HWPX: Contents/section*.xml 의 hp:p, hp:tbl/hp:tr/hp:tc (페이지 정보는 없으므로 1쪽으로 둔다)
 * - 구형 HWP(바이너리, OLE 복합 문서)는 지원하지 않는다 → index.ts 에서 unsupported_hwp_binary.
 */
import { strFromU8, unzipSync } from 'fflate';

import { toMarkdown, type LayoutBlock } from './layout.ts';
import type { ParseLimits } from './types.ts';

export class ZipLimitError extends Error {}

export function readZip(
  bytes: Uint8Array,
  limits: ParseLimits,
  wanted: (name: string) => boolean,
): Record<string, string> {
  let total = 0;
  let entries = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      entries += 1;
      if (entries > limits.maxZipEntries) throw new ZipLimitError('entries');
      if (!wanted(file.name)) return false;
      total += file.originalSize;
      if (total > limits.maxUnzippedBytes) throw new ZipLimitError('size');
      return true;
    },
  });
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    if (data.length > limits.maxUnzippedBytes) throw new ZipLimitError('size');
    out[name] = strFromU8(data);
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1].toLowerCase() === 'x'
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10),
        )
      : (ENTITIES[e] ?? m),
  );

interface Names {
  paragraph: string;
  text: string;
  table: string;
  row: string;
  cell: string;
  tab?: string;
  lineBreak?: string;
  style?: string;
}

/** 아주 작은 XML 토큰 순회기(외부 엔터티·DTD 처리 없음 → XXE 위험 없음). */
function extractBlocks(
  xml: string,
  names: Names,
  headingOf: (style: string | undefined) => 1 | 2 | null,
): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  const tableStack: Array<{
    rows: string[][];
    row: string[] | null;
    cell: string[] | null;
  }> = [];
  let paragraph: string[] | null = null;
  let style: string | undefined;
  let inText = false;
  const tag =
    /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(xml)) !== null) {
    const [, closing, name, attrs, selfClosing, text] = match;
    if (text !== undefined) {
      if (inText && paragraph) paragraph.push(decode(text));
      continue;
    }
    const table = tableStack.at(-1);
    if (name === names.text) {
      inText = !closing && !selfClosing;
      continue;
    }
    if ((name === names.tab || name === names.lineBreak) && paragraph) {
      paragraph.push(name === names.tab ? ' ' : ' ');
      continue;
    }
    if (names.style && name === names.style && paragraph) {
      style = attrs.match(/val\s*=\s*"([^"]*)"/)?.[1];
      continue;
    }
    if (name === names.paragraph) {
      if (!closing && !selfClosing) {
        paragraph = [];
        style = undefined;
      } else if (closing && paragraph) {
        const content = paragraph.join('').replace(/\s+/g, ' ').trim();
        paragraph = null;
        if (!content) continue;
        if (table?.cell) table.cell.push(content);
        else {
          const level = headingOf(style);
          blocks.push(
            level
              ? { kind: 'heading', page: 1, level, text: content }
              : { kind: 'paragraph', page: 1, text: content },
          );
        }
      }
      continue;
    }
    if (name === names.table) {
      if (!closing && !selfClosing)
        tableStack.push({ rows: [], row: null, cell: null });
      else if (closing) {
        const done = tableStack.pop();
        if (done && done.rows.length > 0) {
          const width = Math.max(...done.rows.map((r) => r.length));
          const rows = done.rows.map((r) => [
            ...r,
            ...new Array(width - r.length).fill(''),
          ]);
          const parent = tableStack.at(-1);
          if (parent?.cell)
            parent.cell.push(rows.map((r) => r.join(' / ')).join(' ; '));
          else if (width >= 2)
            blocks.push({
              kind: 'table',
              page: 1,
              rows,
              rowPages: rows.map(() => 1),
            });
          else
            rows.forEach((r) =>
              blocks.push({ kind: 'paragraph', page: 1, text: r[0] }),
            );
        }
      }
      continue;
    }
    if (!table) continue;
    if (name === names.row) {
      if (!closing && !selfClosing) table.row = [];
      else if (closing && table.row) {
        if (table.row.some((c) => c.trim())) table.rows.push(table.row);
        table.row = null;
      }
    } else if (name === names.cell) {
      if (!closing && !selfClosing) table.cell = [];
      else if (closing && table.cell) {
        table.row?.push(table.cell.join(' '));
        table.cell = null;
      }
    }
  }
  return blocks;
}

export function parseDocx(
  bytes: Uint8Array,
  limits: ParseLimits,
): { text: string; tables: number } {
  const files = readZip(bytes, limits, (name) => name === 'word/document.xml');
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('word/document.xml 없음');
  const blocks = extractBlocks(
    xml,
    {
      paragraph: 'w:p',
      text: 'w:t',
      table: 'w:tbl',
      row: 'w:tr',
      cell: 'w:tc',
      tab: 'w:tab',
      lineBreak: 'w:br',
      style: 'w:pStyle',
    },
    (s) =>
      !s
        ? null
        : /^(title|제목)$/i.test(s)
          ? 1
          : /^(heading|제목)\s*\d|^heading/i.test(s)
            ? 2
            : null,
  );
  return {
    text: blocks.length ? toMarkdown(blocks) : '',
    tables: blocks.filter((b) => b.kind === 'table').length,
  };
}

export function parseHwpx(
  bytes: Uint8Array,
  limits: ParseLimits,
): { text: string; tables: number } {
  const files = readZip(bytes, limits, (name) =>
    /^Contents\/section\d+\.xml$/i.test(name),
  );
  const sections = Object.keys(files).sort(
    (a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]),
  );
  if (sections.length === 0) throw new Error('Contents/section*.xml 없음');
  const blocks = sections.flatMap((name) =>
    extractBlocks(
      files[name],
      {
        paragraph: 'hp:p',
        text: 'hp:t',
        table: 'hp:tbl',
        row: 'hp:tr',
        cell: 'hp:tc',
        tab: 'hp:tab',
        lineBreak: 'hp:lineBreak',
      },
      () => null,
    ),
  );
  // HWPX 는 스타일 이름을 알 수 없으므로 "1. 제목"·"Ⅰ. 제목" 같은 짧은 번호 문단을 절 제목으로 본다.
  for (const block of blocks) {
    if (
      block.kind === 'paragraph' &&
      block.text &&
      block.text.length <= 40 &&
      /^([0-9]{1,2}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])[.)]\s*\S/.test(block.text)
    ) {
      block.kind = 'heading';
      block.level = 2;
    }
  }
  return {
    text: blocks.length ? toMarkdown(blocks) : '',
    tables: blocks.filter((b) => b.kind === 'table').length,
  };
}
