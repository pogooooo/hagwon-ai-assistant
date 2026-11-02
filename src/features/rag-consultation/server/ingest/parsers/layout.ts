/**
 * 위치가 있는 텍스트(PDF 텍스트 레이어 항목·OCR 단어) → 읽기 순서의 제목·문단·표 블록.
 * 같은 알고리즘을 텍스트 PDF 와 스캔 PDF(OCR)에 함께 쓴다.
 *
 * 1) 줄 묶기: 세로 중심이 가까운 조각을 한 줄로
 * 2) 칸(segment) 나누기: 글자 크기보다 넓은 가로 간격이면 다른 칸
 * 3) 2단 편집 감지: 페이지 가운데 세로 여백(거터)을 가로지르는 줄이 거의 없고, 양쪽 줄이 단 폭을 채우면 2단.
 *    전체 폭 줄(제목 등)을 경계로 띠를 나누고, 띠마다 왼쪽 단 → 오른쪽 단 순서로 읽는다.
 * 4) 표 감지: 칸이 2개 이상인 줄이 연속되고 칸 시작 x 좌표가 같은 열 기준선에 맞으면 표.
 *    첫 열이 빈 줄은 앞 행의 이어지는 글(셀 안 줄바꿈)로 붙인다. 첫 행을 헤더로 본다.
 * 5) 제목: 본문보다 큰 글자 한 줄.
 * 여러 페이지에 걸친 표 합치기는 mergeAcrossPages 에서 한다.
 */
import type { PositionedText } from './types.ts';

export interface LayoutBlock {
  kind: 'heading' | 'paragraph' | 'table';
  page: number;
  level?: 1 | 2;
  text?: string;
  rows?: string[][];
  /** 행마다 페이지(여러 페이지 표) */
  rowPages?: number[];
}

interface Segment {
  x0: number;
  x1: number;
  text: string;
  size: number;
}

interface Line {
  top: number;
  bottom: number;
  size: number;
  segments: Segment[];
  /** 줄 끝이 공백으로 끝났는지(단어 경계에서 줄바꿈) */
  endsWithSpace: boolean;
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function groupLines(items: PositionedText[], ocr: boolean): Line[] {
  const sorted = items
    .filter((item) => item.text.trim() !== '')
    .sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines: Array<{
    center: number;
    size: number;
    items: PositionedText[];
  }> = [];
  for (const item of sorted) {
    const center = item.top + item.size / 2;
    const target = lines
      .slice(-4)
      .find(
        (line) =>
          Math.abs(line.center - center) <=
          0.5 * Math.max(line.size, item.size),
      );
    if (target) {
      target.items.push(item);
      target.size = Math.max(target.size, item.size);
    } else lines.push({ center, size: item.size, items: [item] });
  }
  return lines
    .map((line) => {
      const lineItems = line.items.sort((a, b) => a.x0 - b.x0);
      const size = median(lineItems.map((item) => item.size)) || line.size;
      const segmentGap = (ocr ? 1.25 : 0.9) * size;
      const segments: Segment[] = [];
      let previous: PositionedText | undefined;
      for (const item of lineItems) {
        const text = item.text.replace(/\s+/g, ' ').trim();
        const gap = previous ? item.x0 - previous.x1 : 0;
        const current = segments.at(-1);
        if (!current || gap > segmentGap) {
          segments.push({ x0: item.x0, x1: item.x1, text, size: item.size });
        } else {
          const space =
            item.spaceBefore || (ocr ? gap > 0.32 * size : gap > 0.2 * size);
          current.text += (space ? ' ' : '') + text;
          current.x1 = Math.max(current.x1, item.x1);
          current.size = Math.max(current.size, item.size);
        }
        previous = item;
      }
      const last = lineItems.at(-1);
      return {
        top: Math.min(...lineItems.map((item) => item.top)),
        bottom: Math.max(...lineItems.map((item) => item.top + item.size)),
        size,
        segments: segments.filter((segment) => segment.text !== ''),
        endsWithSpace: Boolean(last && /\s$/.test(last.text)),
      };
    })
    .filter((line) => line.segments.length > 0);
}

/** 2단 편집이면 거터 x 좌표, 아니면 null. */
function detectGutter(lines: Line[], pageWidth: number): number | null {
  if (lines.length < 8) return null;
  const minX = Math.min(...lines.map((l) => l.segments[0].x0));
  const maxX = Math.max(...lines.map((l) => l.segments.at(-1)!.x1));
  const width = maxX - minX;
  if (width < pageWidth * 0.4) return null;
  // 표가 많은 페이지(칸 3개 이상 줄이 많음)는 2단으로 보지 않는다.
  const multi = lines.filter((l) => l.segments.length >= 3).length;
  if (multi > lines.length * 0.3) return null;
  // 가운데 영역에서 가로지르는 줄 수가 최소에 가까운 x 들의 가장 넓은 연속 구간 → 그 중심을 거터로.
  const samples: Array<{ x: number; crossing: number }> = [];
  for (let x = minX + width * 0.3; x <= minX + width * 0.7; x += 2) {
    samples.push({
      x,
      crossing: lines.filter((l) =>
        l.segments.some((s) => s.x0 < x - 3 && s.x1 > x + 3),
      ).length,
    });
  }
  const minimum = Math.min(...samples.map((sample) => sample.crossing));
  if (minimum > lines.length * 0.2) return null;
  const allowed = minimum + Math.max(1, Math.round(lines.length * 0.05));
  let run: { start: number; end: number } | null = null;
  let widest: { start: number; end: number } | null = null;
  for (const sample of samples) {
    if (sample.crossing <= allowed) {
      run = run
        ? { start: run.start, end: sample.x }
        : { start: sample.x, end: sample.x };
      if (!widest || run.end - run.start > widest.end - widest.start)
        widest = { ...run };
    } else run = null;
  }
  if (!widest) return null;
  const gutter = (widest.start + widest.end) / 2;
  const left = lines.flatMap((l) =>
    l.segments.filter((s) => s.x1 <= gutter + 3),
  );
  const right = lines.flatMap((l) =>
    l.segments.filter((s) => s.x0 >= gutter - 3),
  );
  if (left.length < 4 || right.length < 4) return null;
  // 본문 단은 단 폭을 채우고(상위 25% 줄이 단 폭의 70% 이상), 표와 달리 양쪽 줄의 기준선이 대부분 어긋난다.
  const leftWidth = gutter - minX;
  const rightWidth = maxX - gutter;
  const p75 = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.75)] ?? 0;
  };
  if (p75(left.map((s) => s.x1 - s.x0)) / leftWidth < 0.7) return null;
  if (p75(right.map((s) => s.x1 - s.x0)) / rightWidth < 0.7) return null;
  const leftLines = lines.filter((l) =>
    l.segments.some((s) => s.x1 <= gutter + 3),
  );
  const rightLines = lines.filter((l) =>
    l.segments.some((s) => s.x0 >= gutter - 3),
  );
  const aligned = leftLines.filter((l) => rightLines.includes(l)).length;
  if (
    aligned / Math.max(1, Math.min(leftLines.length, rightLines.length)) >=
    0.6
  ) {
    // 같은 줄에 묶인 양쪽 칸은 기준선이 같다는 뜻이므로 2단 본문인지 다시 확인한다: 같은 줄 비율이 높으면 표다.
    return null;
  }
  return gutter;
}

/** 2단이면 띠(전체 폭 줄 사이)마다 왼쪽 단 → 오른쪽 단 순서의 줄 목록으로 바꾼다. */
function readingOrder(lines: Line[], gutter: number | null): Line[][] {
  if (gutter === null) return [lines];
  const regions: Line[][] = [];
  let left: Line[] = [];
  let right: Line[] = [];
  const flush = () => {
    if (left.length) regions.push(left);
    if (right.length) regions.push(right);
    left = [];
    right = [];
  };
  for (const line of lines) {
    const crosses = line.segments.some(
      (s) => s.x0 < gutter - 6 && s.x1 > gutter + 6,
    );
    if (crosses) {
      flush();
      regions.push([line]);
      continue;
    }
    const l = line.segments.filter((s) => (s.x0 + s.x1) / 2 < gutter);
    const r = line.segments.filter((s) => (s.x0 + s.x1) / 2 >= gutter);
    // 양쪽 단의 줄이 같은 높이에 있어 한 줄로 묶였으면 단별로 글자 크기를 다시 잰다(제목 판단용).
    if (l.length)
      left.push({ ...line, segments: l, size: median(l.map((s) => s.size)) });
    if (r.length)
      right.push({ ...line, segments: r, size: median(r.map((s) => s.size)) });
  }
  flush();
  return regions;
}

const PARTICLE_END = /[은는을를에와과고서며의도로면다,.:;)]$/;
const LIST_START = /^([-•·※▶◆■□○●]|\d{1,2}[.)]|[가-하][.)]|\(\d+\))\s*/;

function joinLines(
  previous: string,
  next: string,
  previousEndsWithSpace: boolean,
  ocr: boolean,
): string {
  if (ocr || previousEndsWithSpace) return `${previous} ${next}`;
  // 한글 단어 중간 줄바꿈은 붙이고, 조사·어미로 끝난 줄은 띄어 쓴다(텍스트 PDF 는 줄 끝 공백이 없음).
  if (
    /[가-힣]$/.test(previous) &&
    /^[가-힣]/.test(next) &&
    !PARTICLE_END.test(previous)
  )
    return previous + next;
  if (/\d$/.test(previous) && /^[가-힣%]/.test(next)) return previous + next;
  return `${previous} ${next}`;
}

function buildTable(lines: Line[], tolerance: number): string[][] {
  const x0s = lines
    .flatMap((l) => l.segments.map((s) => s.x0))
    .sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const x of x0s) {
    const last = clusters.at(-1);
    if (last && x - last[last.length - 1] <= tolerance) last.push(x);
    else clusters.push([x]);
  }
  const multiLines = lines.filter((l) => l.segments.length >= 2).length;
  const anchors = clusters
    .filter(
      (cluster, index) =>
        index === 0 || cluster.length >= Math.max(2, multiLines * 0.3),
    )
    .map((cluster) => Math.min(...cluster));
  const anchorOf = (x: number) => {
    let index = 0;
    anchors.forEach((anchor, i) => {
      if (anchor <= x + tolerance) index = i;
    });
    return index;
  };
  const rows: string[][] = [];
  for (const line of lines) {
    const cells = new Array(anchors.length).fill('');
    for (const segment of line.segments) {
      const index = anchorOf(segment.x0);
      cells[index] = cells[index]
        ? `${cells[index]} ${segment.text}`
        : segment.text;
    }
    const startsRow = cells[0] !== '' || rows.length === 0;
    if (startsRow) rows.push(cells);
    else {
      const row = rows[rows.length - 1];
      cells.forEach((cell, index) => {
        if (cell) row[index] = row[index] ? `${row[index]} ${cell}` : cell;
      });
    }
  }
  return rows;
}

export function analyzePage(
  items: PositionedText[],
  options: { page: number; pageWidth: number; ocr: boolean; bodySize?: number },
): { blocks: LayoutBlock[]; twoColumn: boolean } {
  const lines = groupLines(items, options.ocr);
  if (lines.length === 0) return { blocks: [], twoColumn: false };
  const gutter = detectGutter(lines, options.pageWidth);
  const body =
    options.bodySize ??
    median(lines.flatMap((l) => l.segments.map((s) => s.size)));
  const blocks: LayoutBlock[] = [];

  for (const region of readingOrder(lines, gutter)) {
    let i = 0;
    let paragraph: { text: string; last: Line } | null = null;
    const flushParagraph = () => {
      if (paragraph)
        blocks.push({
          kind: 'paragraph',
          page: options.page,
          text: paragraph.text,
        });
      paragraph = null;
    };
    while (i < region.length) {
      const line = region[i];
      const lineHeight = line.size * 1.6;
      // 표 후보
      if (line.segments.length >= 2) {
        const collected: Line[] = [line];
        const firstX = line.segments[0].x0;
        let j = i + 1;
        while (j < region.length) {
          const next = region[j];
          const gap = next.top - collected[collected.length - 1].bottom;
          if (gap > lineHeight * 1.4) break;
          const isMulti = next.segments.length >= 2;
          const continuation =
            next.segments.length === 1 &&
            next.segments[0].x0 > firstX + line.size * 1.5 &&
            gap <= lineHeight * 0.9;
          if (!isMulti && !continuation) break;
          collected.push(next);
          j += 1;
        }
        const multiCount = collected.filter(
          (l) => l.segments.length >= 2,
        ).length;
        if (multiCount >= 2) {
          flushParagraph();
          const rows = buildTable(collected, line.size * 1.0);
          if (rows[0]?.length >= 2) {
            blocks.push({
              kind: 'table',
              page: options.page,
              rows,
              rowPages: rows.map(() => options.page),
            });
            i = j;
            continue;
          }
        }
      }
      const text = line.segments.map((s) => s.text).join(' ');
      const isHeading =
        line.segments.length === 1 &&
        line.size >= body * 1.15 &&
        text.length <= 60;
      if (isHeading) {
        flushParagraph();
        blocks.push({
          kind: 'heading',
          page: options.page,
          level: line.size >= body * 1.45 ? 1 : 2,
          text,
        });
        i += 1;
        continue;
      }
      const current: { text: string; last: Line } | null = paragraph;
      // "…시작되었습니" 다음 줄의 "다. 이번…"처럼 단어 중간 줄바꿈 뒤 글자는 목록 기호("다.")가 아니다.
      const startsList =
        LIST_START.test(text) &&
        !(
          current &&
          /[가-힣]$/.test(current.text) &&
          /^[가-힣][.)]/.test(text)
        );
      if (
        current &&
        !startsList &&
        line.top - current.last.bottom <= lineHeight * 0.9 &&
        Math.abs(line.size - current.last.size) <= body * 0.1
      ) {
        current.text = joinLines(
          current.text,
          text,
          current.last.endsWithSpace,
          options.ocr,
        );
        current.last = line;
      } else {
        flushParagraph();
        paragraph = { text, last: line };
      }
      i += 1;
    }
    flushParagraph();
  }
  return { blocks, twoColumn: gutter !== null };
}

const normalizeRow = (row: string[]) =>
  row.map((cell) => cell.replace(/\s+/g, '')).join('|');

/** 앞 페이지 마지막 표와 다음 페이지 첫 표가 같은 표면 합친다(반복 헤더 제거). 합친 횟수를 돌려준다. */
export function mergeAcrossPages(blocks: LayoutBlock[]): {
  blocks: LayoutBlock[];
  merged: number;
} {
  const out: LayoutBlock[] = [];
  let merged = 0;
  for (const block of blocks) {
    const previous = out.at(-1);
    if (
      previous?.kind === 'table' &&
      block.kind === 'table' &&
      block.page === (previous.rowPages?.at(-1) ?? previous.page) + 1 &&
      previous.rows &&
      block.rows &&
      previous.rows[0].length === block.rows[0].length
    ) {
      const repeatedHeader =
        normalizeRow(block.rows[0]) === normalizeRow(previous.rows[0]);
      const rows = repeatedHeader ? block.rows.slice(1) : block.rows;
      previous.rows.push(...rows);
      previous.rowPages = [
        ...(previous.rowPages ?? []),
        ...rows.map(() => block.page),
      ];
      merged += 1;
      continue;
    }
    out.push(block);
  }
  return { blocks: out, merged };
}

const escapeCell = (cell: string) =>
  cell.replace(/\|/g, '｜').replace(/\s+/g, ' ').trim();

/** 블록 → 정규화 Markdown(페이지 표시 포함). */
export function toMarkdown(blocks: LayoutBlock[]): string {
  const out: string[] = [];
  let page = 0;
  const pageMark = (p: number) => {
    if (p !== page) {
      out.push(`<!-- page ${p} -->`);
      page = p;
    }
  };
  for (const block of blocks) {
    if (block.kind === 'table' && block.rows && block.rows.length > 0) {
      pageMark(block.rowPages?.[0] ?? block.page);
      const [header, ...rows] = block.rows;
      out.push(`| ${header.map(escapeCell).join(' | ')} |`);
      out.push(`| ${header.map(() => '---').join(' | ')} |`);
      rows.forEach((row, index) => {
        const rowPage = block.rowPages?.[index + 1] ?? block.page;
        if (rowPage !== page) {
          out.push(`<!-- page ${rowPage} -->`);
          page = rowPage;
        }
        out.push(`| ${row.map(escapeCell).join(' | ')} |`);
      });
      out.push('');
      continue;
    }
    pageMark(block.page);
    if (block.kind === 'heading')
      out.push(`${block.level === 1 ? '#' : '##'} ${block.text}`, '');
    else if (block.text) out.push(block.text, '');
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}
