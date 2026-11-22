import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  fieldsToLines,
  pickItemNumberLines,
  readingOrder,
} from '../question-classification/ocr-page.mjs';
import { imageDimensions } from '../rag-consultation/server/ingest/parsers/image.ts';
import type { OperationsDatabase } from '../academy-operations/database.ts';
import type { ChoiceGrid, ImagePage } from './media.ts';

// CLOVA OCR(General)로 채점 사진의 인쇄 문항 번호와 문항 영역을 찾는다. 결과가 결정적이고
// 좌표가 함께 오므로 문항마다 잘라 HCX-005에 한 문항씩 보낼 수 있다. 학생 답의 전사·풀이는
// 하지 않는다(OCR은 체크 표시와 손글씨 띄어쓰기를 그대로 옮긴다고 보장하지 않는다).
//   CLOVA_OCR_INVOKE_URL: OCR 도메인의 API Gateway 주소(…/general)
//   CLOVA_OCR_SECRET: 도메인 Secret Key

export type Box = [number, number, number, number];
export interface OcrLayout {
  printedPage: number | null;
  numbers: number[];
  /** 문항 번호별 영역. 사진 전체 기준 왼쪽·위·오른쪽·아래의 0~1 좌표다. */
  regions: Map<number, Box>;
  /** 객관식 문항의 보기 배치. 보기 기호를 충분히 찾지 못한 문항은 없다. */
  choices: Map<number, ChoiceGrid>;
}
export interface PageOcr {
  /** null이면 OCR로 문항을 확정하지 못했으므로 호출한 쪽이 기존 판독으로 넘어간다. */
  locate(page: ImagePage): Promise<OcrLayout | null>;
}
interface Line {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  confidence: number;
}

const formats: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};
/**
 * 사진 채점용 문항 배치: 인쇄 문항 번호(교재 사진 분석과 같은 규칙, pickItemNumberLines)와
 * 문항 영역·책 쪽수·보기 배치를 찾는다.
 */
export function layoutFromLines(
  lines: Line[],
  size: { width: number; height: number },
  fields: unknown[] = [],
): OcrLayout | null {
  const layout = pickItemNumberLines(lines);
  if (!layout) return null;
  const {
    picked,
    twoColumns,
    columnOf,
    left,
    right,
    mid,
    top,
    bottom,
    footer,
  } = layout;
  const numbers = picked.map((c) => c.n);
  if (
    !numbers.length ||
    numbers.length > 50 ||
    numbers.some((n) => n < 1 || n > 999) ||
    numbers.some((n, i) => i > 0 && n <= numbers[i - 1])
  )
    return null;
  // 문항 영역: 번호가 있는 단의 폭 전체, 번호 줄부터 같은 단의 다음 번호 줄 바로 위까지.
  // 마지막 문항은 아래 여백(쪽 번호·바닥글) 직전까지다. OCR이 놓친 손글씨도 영역 안에 남긴다.
  const regions = new Map<number, Box>();
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const c of picked) {
    const column = columnOf(c.line);
    const next = picked
      .filter((o) => columnOf(o.line) === column && o.line.y0 > c.line.y0)
      .reduce((m, o) => Math.min(m, o.line.y0), footer);
    const x0 = !twoColumns || column === 0 ? left : mid;
    const x1 = !twoColumns || column === 1 ? right : mid;
    const y0 = c.line.y0 - (c.line.y1 - c.line.y0) * 0.5;
    if (next <= y0) return null;
    regions.set(c.n, [
      clamp(x0 / size.width),
      clamp(y0 / size.height),
      clamp(x1 / size.width),
      clamp((next - 2) / size.height),
    ]);
  }
  // 책 쪽수: 위·아래 여백에 숫자만 있는 줄(문항 번호로 고른 줄 제외). 아래 여백을 먼저 본다.
  const margin = (bottom - top) * 0.05;
  const pageLine = [
    ...lines.filter((l) => l.y0 >= bottom - margin),
    ...lines.filter((l) => l.y1 <= top + margin),
  ].find(
    (l) => !picked.some((c) => c.line === l) && /^\s*\d{1,4}\s*$/.test(l.text),
  );
  const glyphs = choiceGlyphs(fields);
  const choices = new Map<number, ChoiceGrid>();
  for (const [n, [bx0, by0, bx1, by1]] of regions) {
    const inside = glyphs.filter((g) => {
      const cx = (g.x0 + g.x1) / 2 / size.width,
        cy = (g.y0 + g.y1) / 2 / size.height;
      return cx >= bx0 && cx <= bx1 && cy >= by0 && cy <= by1;
    });
    const grid = choiceGrid(inside);
    if (grid) choices.set(n, grid);
  }
  return {
    printedPage: pageLine ? Number(pageLine.text.trim()) || null : null,
    numbers,
    regions,
    choices,
  };
}

interface Glyph {
  choice: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** OCR 신뢰도(0~1). 같은 기호가 두 번 읽히면 높은 쪽을 쓴다. */
  confidence?: number;
}
const circled = '①②③④⑤';
/** OCR 조각 중 보기 기호(①~⑤)로 시작하는 것. "② 4", "②-1"처럼 값이 붙어도 기호 자리만 쓴다. */
function choiceGlyphs(fields: unknown[]): Glyph[] {
  return fields.flatMap((field) => {
    const f = field as {
      inferText?: unknown;
      inferConfidence?: unknown;
      boundingPoly?: { vertices?: { x?: number; y?: number }[] };
    };
    const choice = circled.indexOf(String(f.inferText ?? '').trim()[0]) + 1;
    const v = f.boundingPoly?.vertices ?? [];
    if (!choice || v.length < 3) return [];
    const xs = v.map((p) => p.x ?? 0),
      ys = v.map((p) => p.y ?? 0);
    const x0 = Math.min(...xs),
      y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    // 기호는 정사각형에 가깝다. 값이 붙은 조각도 기호 한 글자 폭만 남긴다.
    const confidence =
      typeof f.inferConfidence === 'number' ? f.inferConfidence : 1;
    return [{ choice, x0, y0, x1: x0 + (y1 - y0), y1, confidence }];
  });
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
/**
 * 보기는 한 줄에 k개(5·3·2·1)씩 왼쪽→오른쪽, 위→아래로 놓인다. 찾은 기호와 모순 없는 k가
 * 하나뿐일 때만 배치를 정하고, 못 찾은 기호 위치는 같은 행·열 간격으로 채운다.
 */
export function choiceGrid(glyphs: Glyph[]): ChoiceGrid | null {
  const seen = new Map<number, Glyph>();
  for (const g of glyphs) {
    // 펜에 덮인 기호가 다른 기호로 잘못 읽히면 같은 기호가 두 번 나온다("②7"). 신뢰도가 높은
    // 쪽만 남긴다. 신뢰도가 같으면 어느 쪽이 맞는지 알 수 없으므로 배치를 정하지 않는다.
    const other = seen.get(g.choice);
    if (other) {
      const [a, b] = [other.confidence ?? 1, g.confidence ?? 1];
      if (a === b) return null;
      if (b < a) continue;
    }
    seen.set(g.choice, g);
  }
  const found = [...seen.values()];
  if (found.length < 2) return null;
  const width = median(found.map((g) => g.x1 - g.x0));
  const height = median(found.map((g) => g.y1 - g.y0));
  const fits = [5, 3, 2, 1].filter((k) => {
    const row = (g: Glyph) => Math.floor((g.choice - 1) / k),
      col = (g: Glyph) => (g.choice - 1) % k;
    return found.every((a) =>
      found.every((b) => {
        if (a === b) return true;
        const sameRow = row(a) === row(b),
          sameCol = col(a) === col(b);
        if (sameRow ? Math.abs(a.y0 - b.y0) > height * 0.6 : false)
          return false;
        if (!sameRow && row(a) < row(b) !== a.y0 < b.y0 - height * 0.6)
          return false;
        if (sameCol ? Math.abs(a.x0 - b.x0) > width * 0.8 : false) return false;
        if (!sameCol && col(a) < col(b) !== a.x0 < b.x0 - width) return false;
        return true;
      }),
    );
  });
  if (fits.length !== 1) return null;
  const k = fits[0];
  // 행(또는 열) 번호별로 찾은 좌표를 모아, 빈 칸은 등간격으로 채운다.
  const spread = (pairs: [number, number][], count: number) => {
    const known = new Map<number, number[]>();
    for (const [i, v] of pairs) known.set(i, [...(known.get(i) ?? []), v]);
    const points = [...known]
      .map(([i, vs]) => [i, median(vs)] as const)
      .sort((a, b) => a[0] - b[0]);
    if (count > 1 && points.length < 2) return null;
    const [first, last] = [points[0], points.at(-1)!];
    const step =
      points.length >= 2 ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
    return Array.from({ length: count }, (_, i) =>
      known.has(i) ? median(known.get(i)!) : first[1] + (i - first[0]) * step,
    );
  };
  const xs = spread(
    found.map((g) => [(g.choice - 1) % k, g.x0]),
    k,
  );
  const ys = spread(
    found.map((g) => [Math.floor((g.choice - 1) / k), g.y0]),
    Math.ceil(5 / k),
  );
  if (!xs || !ys) return null;
  return {
    width,
    height,
    positions: [1, 2, 3, 4, 5].map((choice) => ({
      choice,
      x: xs[(choice - 1) % k],
      y: ys[Math.floor((choice - 1) / k)],
    })),
    unread: [1, 2, 3, 4, 5].filter((choice) => !seen.has(choice)),
  };
}

export function createPageOcr(
  env: Record<string, string | undefined>,
  db?: OperationsDatabase,
  fetchImpl: typeof fetch = fetch,
): PageOcr | undefined {
  const url = env.CLOVA_OCR_INVOKE_URL?.trim();
  const secret = env.CLOVA_OCR_SECRET?.trim();
  if (!url || !secret) return undefined;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  // 학생 사진과 Secret은 NAVER Cloud API Gateway로만 보낸다.
  if (
    target.protocol !== 'https:' ||
    !target.hostname.endsWith('.apigw.ntruss.com')
  )
    return undefined;
  const limit = Number(env.RAG_GENERATION_DAILY_CALL_LIMIT ?? '100');
  function withinBudget() {
    if (!Number.isSafeInteger(limit) || limit <= 0) return false;
    if (!db) return true;
    db.exec(
      'CREATE TABLE IF NOT EXISTS op_external_usage(day TEXT NOT NULL,kind TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(day,kind))',
    );
    return !!db
      .prepare(
        'INSERT INTO op_external_usage(day,kind,calls) VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET calls=calls+1 WHERE calls<?',
      )
      .run(new Date().toISOString().slice(0, 10), 'clova-ocr-grading', limit)
      .changes;
  }
  return {
    async locate(page) {
      const format = formats[page.mime];
      const size = imageDimensions(page.bytes);
      if (!format || !size || !withinBudget()) return null;
      let fields: unknown[];
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          // Workers는 manual/follow만 받는다. 다른 곳으로 넘기는 응답은 따라가지 않는다.
          redirect: 'manual',
          signal: AbortSignal.timeout(60000),
          headers: {
            'Content-Type': 'application/json',
            'X-OCR-SECRET': secret,
          },
          body: JSON.stringify({
            version: 'V2',
            requestId: randomUUID(),
            timestamp: Date.now(),
            lang: 'ko',
            images: [
              {
                format,
                name: 'page',
                data: Buffer.from(page.bytes).toString('base64'),
              },
            ],
          }),
        });
        if (!response.ok) {
          console.warn('[homework-grading] CLOVA OCR HTTP', response.status);
          return null;
        }
        const body = (await response.json()) as {
          images?: { inferResult?: string; fields?: unknown }[];
        };
        const image = body.images?.[0];
        if (image?.inferResult !== 'SUCCESS' || !Array.isArray(image.fields))
          return null;
        fields = image.fields;
      } catch {
        return null;
      }
      return layoutFromLines(
        readingOrder(fieldsToLines(fields)) as Line[],
        size,
        fields,
      );
    },
  };
}
