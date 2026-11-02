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
  const label = (base: string) => (section ? `${section} · ${base}` : base);

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
        },
        text: joined,
      });
    }
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      section = heading[2].replace(/[*_`]/g, '').trim();
      i += 1;
      continue;
    }
    if (TABLE_LINE.test(line)) {
      flushParagraph();
      const tableLines: string[] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i])) {
        if (!TABLE_SEPARATOR.test(lines[i])) {
          tableLines.push(lines[i]);
        }
        i += 1;
      }
      tableIndex += 1;
      const [headerLine, ...rows] = tableLines;
      const header = headerLine ? splitCells(headerLine) : [];
      rows.forEach((row, rowOffset) => {
        const cells = splitCells(row);
        const pairs = header.map(
          (name, column) => `${name}: ${cells[column] ?? ''}`,
        );
        blocks.push({
          location: {
            kind: 'table_row',
            label: label(`표 ${tableIndex} · ${rowOffset + 1}행`),
            tableIndex,
            rowIndex: rowOffset + 1,
            header,
            section,
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

export function buildChunks(
  revision: StoredDocumentRevision,
  text: string,
  isSuspicious: (text: string) => boolean,
): RagChunk[] {
  return splitIntoBlocks(text).map((block, index) => {
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
    };
  });
}
