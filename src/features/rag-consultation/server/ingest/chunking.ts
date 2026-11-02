/**
 * 구조 보존 청크 생성.
 * - Markdown 표: 헤더 + 한 행을 한 청크로 묶어 다른 반/강좌의 값이 섞이지 않게 한다(토큰 단위 자르기 금지).
 * - 일반 텍스트: 빈 줄 기준 문단 단위.
 * - 각 청크에 제목·대상·기간 메타데이터를 붙인 검색용 텍스트를 만든다(생성 API 호출 없음).
 */
import { tokenize } from '../text/normalize.ts';
import { formatValidity } from '../text/time.ts';
import type {
  ChunkLocation,
  DocumentExtraction,
  RagChunk,
  StoredDocumentRevision,
} from '../types.ts';

interface RawBlock {
  location: ChunkLocation;
  text: string;
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

const HEADING = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;
/** 정규화 Markdown 의 쪽 표시(ingest/parsers) */
const PAGE_MARK = /^\s*<!--\s*page\s+(\d+)\s*-->\s*$/;
const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;
const RULE = /^\s*([-*_]\s*){3,}$/;

/**
 * 원문을 절(## 제목) · 문단 · 표 행 단위 블록으로 나눈다.
 * 목록 항목은 줄을 유지해 항목 경계(예: 환불 구간)가 섞이지 않게 한다.
 */
export function splitIntoBlocks(text: string): RawBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: RawBlock[] = [];
  let paragraph: string[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;
  let section: string | undefined;
  let page: number | undefined;
  const label = (base: string) =>
    [page ? `${page}쪽` : null, section, base].filter(Boolean).join(' · ');

  const flushParagraph = () => {
    const joined = paragraph
      .reduce((acc, line) => {
        if (acc === '') return line;
        return LIST_ITEM.test(line) ? `${acc}\n${line}` : `${acc} ${line}`;
      }, '')
      .trim();
    if (joined) {
      paragraphIndex += 1;
      blocks.push({
        location: {
          kind: 'paragraph',
          label: label(`문단 ${paragraphIndex}`),
          paragraphIndex,
          section,
          ...(page ? { page } : {}),
        },
        text: joined,
      });
    }
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const pageMark = line.match(PAGE_MARK);
    if (pageMark) {
      flushParagraph();
      page = Number(pageMark[1]);
      i += 1;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      section = heading[2].replace(/[*_`]/g, '').trim();
      i += 1;
      continue;
    }
    if (TABLE_LINE.test(line)) {
      flushParagraph();
      // 여러 페이지에 걸친 표: 표 줄 사이의 쪽 표시는 행마다 쪽 번호로 남긴다.
      const tableLines: Array<{ line: string; page: number | undefined }> = [];
      while (
        i < lines.length &&
        (TABLE_LINE.test(lines[i]) || PAGE_MARK.test(lines[i]))
      ) {
        const mark = lines[i].match(PAGE_MARK);
        if (mark) page = Number(mark[1]);
        else if (!TABLE_SEPARATOR.test(lines[i])) {
          tableLines.push({ line: lines[i], page });
        }
        i += 1;
      }
      tableIndex += 1;
      const [headerLine, ...rows] = tableLines;
      const header = headerLine ? splitCells(headerLine.line) : [];
      rows.forEach(({ line: row, page: rowPage }, rowOffset) => {
        const cells = splitCells(row);
        const rowLabel = [
          rowPage ? `${rowPage}쪽` : null,
          section,
          `표 ${tableIndex} · ${rowOffset + 1}행`,
        ]
          .filter(Boolean)
          .join(' · ');
        const pairs = header.map(
          (name, column) => `${name}: ${cells[column] ?? ''}`,
        );
        blocks.push({
          location: {
            kind: 'table_row',
            label: rowLabel,
            tableIndex,
            rowIndex: rowOffset + 1,
            header,
            cells,
            section,
            ...(rowPage ? { page: rowPage } : {}),
          },
          text: pairs.join(' / '),
        });
      });
      continue;
    }
    if (line.trim() === '' || RULE.test(line)) {
      flushParagraph();
    } else {
      paragraph.push(line.trim().replace(/^>\s?/, ''));
    }
    i += 1;
  }
  flushParagraph();
  return blocks;
}

/** 청크가 속한 쪽의 OCR 품질 → 청크 판독 정보(청크 본문에 실제로 든 불확실 토큰만). */
function chunkExtraction(
  extraction: DocumentExtraction | undefined,
  page: number | undefined,
  text: string,
): RagChunk['extraction'] {
  const info = extraction?.pages.find((p) => p.page === (page ?? 1));
  if (!info || info.method === 'text') return undefined;
  return {
    method: info.method,
    confidence: info.confidence,
    uncertainTokens: (info.uncertainTokens ?? []).filter((token) =>
      text.includes(token),
    ),
    needsReview: Boolean(info.needsReview),
  };
}

export function buildChunks(
  revision: StoredDocumentRevision,
  text: string,
  isSuspicious: (text: string) => boolean,
): RagChunk[] {
  return splitIntoBlocks(text).map((block, index) => {
    const extraction = chunkExtraction(
      revision.extraction,
      block.location.page,
      block.text,
    );
    const context = [
      `문서: ${revision.title}`,
      block.location.section ? `절: ${block.location.section}` : null,
      revision.classId ? `반: ${revision.classId}` : null,
      `기간: ${formatValidity(revision.validFrom, revision.validTo)}`,
    ]
      .filter(Boolean)
      .join(' · ');
    const contextualText = `${context}\n${block.text}`;
    return {
      chunkId: `${revision.sourceId}#${index + 1}`,
      sourceId: revision.sourceId,
      documentId: revision.documentId,
      revision: revision.revision,
      academyId: revision.academyId,
      studentId: revision.studentId,
      classId: revision.classId,
      documentType: revision.documentType,
      visibility: revision.visibility,
      validFrom: revision.validFrom,
      validTo: revision.validTo,
      title: revision.title,
      location: block.location,
      text: block.text,
      contextualText,
      tokens: tokenize(contextualText),
      suspicious: isSuspicious(block.text),
      ...(extraction ? { extraction } : {}),
    };
  });
}
