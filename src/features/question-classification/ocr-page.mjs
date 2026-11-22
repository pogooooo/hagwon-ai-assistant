import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { visionChat } from './read-image.mjs';

// CLOVA OCR(General)로 쪽 사진의 글자를 읽고, 위치 정보로 단(왼쪽→오른쪽) 순서를 맞춘 뒤
// 인쇄 번호에서 문항 경계를 나눈다. HCX-005 판독과 달리 결과가 결정적이고 JSON을 모델이
// 만들지 않으므로 형식 오류로 쪽 전체를 잃지 않는다. 수식은 글자로만 읽힌다(분수·지수 구조 손실).
//   CLOVA_OCR_INVOKE_URL: 도메인의 API Gateway 주소(…/general 까지)
//   CLOVA_OCR_SECRET: 도메인에서 발급한 Secret Key

export function ocrConfigured() {
  return !!(
    process.env.CLOVA_OCR_INVOKE_URL?.trim() &&
    process.env.CLOVA_OCR_SECRET?.trim()
  );
}

export async function ocrImage(source) {
  const url = process.env.CLOVA_OCR_INVOKE_URL?.trim();
  const secret = process.env.CLOVA_OCR_SECRET?.trim();
  if (!url || !secret)
    throw Error(
      '.env.local에 CLOVA_OCR_INVOKE_URL과 CLOVA_OCR_SECRET을 설정하세요.',
    );
  const fromFile = typeof source === 'string';
  const bytes = fromFile ? await readFile(source) : source.bytes;
  const ext = fromFile
    ? path.extname(source).slice(1).toLowerCase()
    : source.mime === 'image/png'
      ? 'png'
      : 'jpg';
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', 'X-OCR-SECRET': secret },
    body: JSON.stringify({
      version: 'V2',
      requestId: randomUUID(),
      timestamp: Date.now(),
      lang: 'ko',
      images: [
        {
          format: ext === 'jpeg' ? 'jpg' : ext,
          name: 'page',
          data: bytes.toString('base64'),
        },
      ],
    }),
  });
  if (!response.ok)
    throw Error(
      'CLOVA OCR HTTP ' +
        response.status +
        ': ' +
        (await response.text().catch(() => '')).slice(0, 200),
    );
  const body = await response.json();
  const image = body.images?.[0];
  if (image?.inferResult !== 'SUCCESS')
    throw Error('CLOVA OCR 인식 실패: ' + (image?.message ?? '응답 없음'));
  return image.fields ?? [];
}

// OCR 조각을 줄로 묶는다(lineBreak가 줄 끝). 줄마다 위치와 최저 신뢰도를 남긴다.
export function fieldsToLines(fields) {
  const lines = [];
  let current = [];
  for (const field of fields) {
    current.push(field);
    if (field.lineBreak) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length) lines.push(current);
  return lines.map((parts) => {
    const xs = parts.flatMap(
      (p) => p.boundingPoly?.vertices?.map((v) => v.x ?? 0) ?? [0],
    );
    const ys = parts.flatMap(
      (p) => p.boundingPoly?.vertices?.map((v) => v.y ?? 0) ?? [0],
    );
    return {
      text: parts.map((p) => p.inferText).join(' '),
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
      confidence: Math.min(...parts.map((p) => p.inferConfidence ?? 1)),
    };
  });
}

// 두 단 쪽: 가운데를 가로지르는 줄(제목·머리글)은 위치대로 두고, 나머지는 왼쪽 단 전체 뒤에
// 오른쪽 단을 놓는다. 한 단 쪽은 위에서 아래 순서 그대로다.
export function readingOrder(lines) {
  if (!lines.length) return [];
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const mid = (left + right) / 2;
  const gap = (right - left) * 0.03;
  const isLeft = (l) => l.x1 <= mid + gap;
  const isRight = (l) => l.x0 >= mid - gap;
  const twoColumns =
    lines.filter(isLeft).length >= 3 && lines.filter(isRight).length >= 3;
  const byY = (a, b) => a.y0 - b.y0 || a.x0 - b.x0;
  if (!twoColumns) return [...lines].sort(byY);
  const spanning = lines.filter((l) => !isLeft(l) && !isRight(l));
  const columns = lines.filter((l) => isLeft(l) || isRight(l));
  const top = Math.min(...columns.map((l) => l.y0));
  return [
    ...spanning.filter((l) => l.y0 < top).sort(byY),
    ...columns.filter(isLeft).sort(byY),
    ...columns.filter((l) => !isLeft(l)).sort(byY),
    ...spanning.filter((l) => l.y0 >= top).sort(byY),
  ];
}

// 쪽 위·아래 가장자리에 숫자만 있는 줄을 쪽 번호로 본다("2", "2 20", "- 24 -").
export function findPrintedPage(lines) {
  if (!lines.length) return undefined;
  const top = Math.min(...lines.map((l) => l.y0));
  const bottom = Math.max(...lines.map((l) => l.y1));
  const band = (bottom - top) * 0.08;
  for (const l of [...lines].sort((a, b) => a.y0 - b.y0)) {
    const edge = l.y0 <= top + band || l.y1 >= bottom - band;
    const m = l.text
      .trim()
      .match(/^[-–\s]*(\d{1,4})(?:\s*[/\s]\s*\d{1,4})?[-–\s]*$/);
    if (edge && m) return Number(m[1]);
  }
  return undefined;
}

// 인쇄 문항 번호 찾기(교재 사진 분석과 사진 채점이 함께 쓴다). 번호는 각 단의 같은 왼쪽 위치에
// 세로로 늘어서고 위에서 아래로 커진다. 보기 값("① 3"의 3)과 손글씨 숫자도 번호처럼 읽히므로,
// 단마다 왼쪽 위치가 같은 숫자 줄 묶음 중 번호가 커지는 가장 긴 묶음만 문항 번호로 받는다.
// "01", "7", "3.", "12)", "5번", "0012": 번호만 있는 줄이거나, 구두점 뒤에 발문이 이어지는 줄.
const aloneNumber = /^\s*(\d{1,4})\s*(?:[.)．]|번)?\s*$/u;
const leadingNumber = /^\s*(\d{1,4})\s*(?:[.)．]|번)\s*\S/u;
// 앞에 0을 붙인 번호는 OCR이 발문과 한 줄로 읽어도("04 lim …") 번호로 본다. 같은 위치에 늘어선
// 번호인지는 아래에서 따로 확인하므로 본문 중간의 숫자는 받지 않는다.
const paddedLeading = /^\s*(0\d{1,3})\s+\S/u;
export function pickItemNumberLines(lines) {
  if (!lines.length) return null;
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const mid = (left + right) / 2;
  const twoColumns =
    lines.filter((l) => l.x1 <= mid).length >= 3 &&
    lines.filter((l) => l.x0 >= mid).length >= 3;
  const tolerance = Math.max(4, (right - left) * 0.012);
  const top = Math.min(...lines.map((l) => l.y0));
  const bottom = Math.max(...lines.map((l) => l.y1));
  const footer = bottom - (bottom - top) * 0.04;
  const columnOf = (l) => (!twoColumns ? 0 : (l.x0 + l.x1) / 2 < mid ? 0 : 1);
  const candidates = lines.flatMap((line) => {
    // OCR이 번호 앞의 0을 영문 O로 읽는 경우("O4")를 바로잡는다.
    const text = line.text.replace(
      /^(\s*)[Oo](?=\d)/u,
      (_, space) => space + '0',
    );
    const alone = aloneNumber.exec(text);
    const match = alone ?? leadingNumber.exec(text) ?? paddedLeading.exec(text);
    // 맨 아래 쪽 번호 줄은 문항이 아니다.
    if (!match || line.y0 >= footer) return [];
    // 같은 줄 높이에서 더 왼쪽에 다른 글자가 있으면("① 3"의 3) 문항 번호가 아니다.
    const crowded = lines.some(
      (other) =>
        other !== line &&
        columnOf(other) === columnOf(line) &&
        other.x1 <= line.x0 + 2 &&
        other.x0 < line.x0 - tolerance &&
        other.y0 < line.y1 &&
        line.y0 < other.y1,
    );
    if (crowded) return [];
    return [
      {
        line,
        n: Number(match[1]),
        display: match[1],
        // 번호 뒤에 이어지는 발문의 시작 위치(번호만 있는 줄이면 줄 끝).
        prefix: alone ? text.length : match[0].length - 1,
        padded: /^0\d/.test(match[1]),
      },
    ];
  });
  // 앞에 0을 붙인 번호("01")가 섞여 있으면 그 문제지는 번호를 그렇게 인쇄한 것이다. 같은 자리에
  // 숫자 하나로 읽힌 것("4")은 펜에 덮인 보기 기호일 수 있어 뺀다.
  const score = (group) =>
    group.length + group.filter((c) => c.padded).length * 0.5;
  // 위에서 아래 순서로 번호가 커지는(한 번에 10 이내) 묶음 중 점수가 가장 높은 것.
  const longestIncreasing = (all) => {
    const group = all.some((c) => c.padded) ? all.filter((c) => c.padded) : all;
    const chain = group.map((c) => [c]);
    for (let i = 0; i < group.length; i++)
      for (let j = 0; j < i; j++) {
        const step = group[i].n - group[j].n;
        if (
          step > 0 &&
          step <= 10 &&
          score([...chain[j], group[i]]) > score(chain[i])
        )
          chain[i] = [...chain[j], group[i]];
      }
    return chain.reduce((best, c) => (score(c) > score(best) ? c : best), []);
  };
  const picked = [];
  for (const column of twoColumns ? [0, 1] : [0]) {
    const inColumn = candidates
      .filter((c) => columnOf(c.line) === column)
      .sort((a, b) => a.line.y0 - b.line.y0);
    let best = [];
    for (const anchor of inColumn) {
      const aligned = longestIncreasing(
        inColumn.filter(
          (c) => Math.abs(c.line.x0 - anchor.line.x0) <= tolerance,
        ),
      );
      if (score(aligned) > score(best)) best = aligned;
    }
    picked.push(...best);
  }
  return {
    picked,
    twoColumns,
    columnOf,
    left,
    right,
    mid,
    top,
    bottom,
    footer,
  };
}

// 줄 맨 앞의 인쇄 번호("5.", "0012", "12)")와 공유 지문 머리말("[41~42]")에서 문항을 나눈다.
// 번호는 앞 번호보다 크고 10 이내로 늘어날 때만 받아 본문 속 숫자를 문항 번호로 오인하지 않는다.
// 교재에 따라 OCR이 "0001"을 발문과 다른 줄로 읽으므로 번호만 있는 줄도 받는다(네 자리 번호만 채택).
const itemMark = /^\s*(\d{1,4})\s*(?:[.)．]\s*|\s+(?=\S)|$)/;
const passageMark = /^\s*\[\s*(\d{1,4})\s*[~∼～\-–]\s*(\d{1,4})\s*\]/;
function segmentByMarks(lines) {
  const items = [];
  const passages = [];
  let current = null;
  let last = null;
  for (const line of lines) {
    const passage = line.text.match(passageMark);
    const item = line.text.match(itemMark);
    const n = item ? Number(item[1]) : NaN;
    const padded = item && item[1].length === 4;
    const accepted =
      item &&
      (item[0].includes('.') || item[0].includes(')') || padded) &&
      (last === null || (n > last && n - last <= 10));
    if (passage) {
      current = { from: +passage[1], to: +passage[2], lines: [line.text] };
      passages.push(current);
    } else if (accepted) {
      last = n;
      current = {
        displayNumber: item[1],
        lines: [line.text.slice(item[0].length)],
        confidence: line.confidence,
        start: { x0: line.x0, x1: line.x1, y0: line.y0, y1: line.y1 },
      };
      items.push(current);
    } else if (current) {
      current.lines.push(line.text);
      if (current.confidence !== undefined)
        current.confidence = Math.min(current.confidence, line.confidence);
    }
  }
  return items.map((i) => {
    const n = Number(i.displayNumber);
    const shared = passages
      .filter((p) => p.from <= n && n <= p.to)
      .map((p) => p.lines.join('\n'));
    return {
      displayNumber: i.displayNumber,
      text: [...shared, i.lines.join('\n')].join('\n').trim(),
      confidence: i.confidence,
      start: i.start,
    };
  });
}

// 문항 나누기. 같은 위치에 세로로 늘어선 번호(pickItemNumberLines)와 줄 맨 앞 표시 규칙
// (segmentByMarks)을 모두 써 보고 문항을 더 많이 찾은 쪽을 쓴다. 같으면 기존 규칙을 쓴다.
// "01"처럼 점 없이 인쇄한 번호는 기존 규칙으로는 찾지 못한다.
export function segmentItems(lines) {
  const byMarks = segmentByMarks(lines);
  const layout = pickItemNumberLines(lines);
  const picked = layout?.picked ?? [];
  if (picked.length <= byMarks.length) return byMarks;
  // 같은 단에서 번호 줄 높이의 1.5배 위부터 다음 번호 직전까지를 그 문항의 줄로 본다. 발문 첫 줄이
  // 번호보다 조금 위에 놓이는 경우(분수·극한 기호)가 있어 읽기 순서만으로 나누지 않는다.
  const top = (c) => c.line.y0 - (c.line.y1 - c.line.y0) * 1.5;
  const items = picked.map((c) => ({
    pick: c,
    displayNumber: c.display,
    lines: [],
    confidence: c.line.confidence,
    start: { x0: c.line.x0, x1: c.line.x1, y0: c.line.y0, y1: c.line.y1 },
  }));
  const passages = [];
  for (const line of lines) {
    const column = layout.columnOf(line);
    const owner = items
      .filter(
        (i) =>
          layout.columnOf(i.pick.line) === column && top(i.pick) <= line.y0,
      )
      .reduce(
        (best, i) => (!best || top(i.pick) > top(best.pick) ? i : best),
        null,
      );
    const passage = line.text.match(passageMark);
    if (passage) {
      passages.push({ from: +passage[1], to: +passage[2], line });
      continue;
    }
    if (!owner) continue;
    owner.lines.push(
      line === owner.pick.line ? line.text.slice(owner.pick.prefix) : line.text,
    );
    if (owner.confidence !== undefined)
      owner.confidence = Math.min(owner.confidence, line.confidence);
  }
  return items.map((i) => {
    const n = Number(i.displayNumber);
    const shared = passages
      .filter((p) => p.from <= n && n <= p.to)
      .map((p) => p.line.text);
    return {
      displayNumber: i.displayNumber,
      text: [...shared, i.lines.join('\n')].join('\n').trim(),
      confidence: i.confidence,
      start: i.start,
    };
  });
}

// 문항 영역: 번호 줄이 있는 단(두 단이면 왼쪽·오른쪽 절반)의 폭 전체이고, 세로로는 번호 줄부터
// 같은 단의 다음 문항 번호 줄 바로 위(없으면 그 단의 마지막 줄)까지다. 읽기 순서로 모은 줄들의
// 상자를 합치면 단 순서가 어긋난 줄 하나 때문에 이웃 문항까지 잘려 들어가므로 쓰지 않는다.
export function itemRegions(items, lines) {
  const regions = new Map();
  if (!lines.length) return regions;
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const top = Math.min(...lines.map((l) => l.y0));
  const bottom = Math.max(...lines.map((l) => l.y1));
  const mid = (left + right) / 2;
  const footer = bottom - (bottom - top) * 0.04;
  const twoColumns =
    lines.filter((l) => l.x1 <= mid).length >= 3 &&
    lines.filter((l) => l.x0 >= mid).length >= 3;
  const columnOf = (b) => (!twoColumns ? 0 : (b.x0 + b.x1) / 2 < mid ? 0 : 1);
  for (const item of items) {
    if (!item.start) continue;
    const col = columnOf(item.start);
    const next = items
      .filter(
        (o) =>
          o !== item &&
          o.start &&
          columnOf(o.start) === col &&
          o.start.y0 > item.start.y0,
      )
      .reduce((m, o) => Math.min(m, o.start.y0), Infinity);
    const below = lines.filter(
      (l) =>
        columnOf(l) === col &&
        l.y0 >= item.start.y0 - 2 &&
        l.y0 < next &&
        l.y1 < footer,
    );
    regions.set(item, {
      x0: !twoColumns || col === 0 ? left : mid,
      x1: !twoColumns || col === 1 ? right : mid,
      y0: item.start.y0,
      y1: Math.min(next, Math.max(item.start.y1, ...below.map((l) => l.y1))),
    });
  }
  return regions;
}

// 잘라 낸 문항 이미지. HCX-005는 너무 길쭉하거나 큰 이미지를 거절하므로(HTTP 400) 흰 여백으로
// 가로세로 비율을 4:1 안에 맞추고 긴 변을 2000px 이하로 둔다.
async function cropRegion(bytes, region, { pad = 20, scale = 1.5 } = {}) {
  const img = await loadImage(bytes);
  const x0 = Math.max(0, region.x0 - pad);
  const y0 = Math.max(0, region.y0 - pad);
  const w = Math.min(img.width, region.x1 + pad) - x0;
  const h = Math.min(img.height, region.y1 + pad) - y0;
  const s = Math.min(scale, 2000 / Math.max(w, h));
  const sw = Math.round(w * s);
  const sh = Math.round(h * s);
  const cw = Math.max(sw, Math.ceil(sh / 4), 64);
  const ch = Math.max(sh, Math.ceil(sw / 4), 64);
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, x0, y0, w, h, (cw - sw) / 2, (ch - sh) / 2, sw, sh);
  return { bytes: canvas.toBuffer('image/png'), mime: 'image/png' };
}

const ITEM_PROMPT =
  '이미지는 수학 문항 하나입니다. 문항 번호와 선택지(①~⑤)를 빼고 발문과 조건, <보기>를 그대로 옮기세요. 수식은 $...$ 안에 LaTeX로 쓰세요(분수 \\frac{}{}, 지수 ^{}, 아래첨자 _{}, 근호 \\sqrt{}). 풀이·설명은 쓰지 마세요.';
// 판독 결과의 형식 군더더기(<box> 태그, 코드 울타리, 앞에 되풀이된 문항 번호)를 걷어 낸다.
export function tidyItemReading(text, displayNumber) {
  const n = '0*' + Number(displayNumber);
  return (text ?? '')
    .replace(/^```[a-z]*\s*|\s*```$/g, '')
    .replace(/<\/?box[^>]*>/g, '\n')
    .trim()
    .replace(new RegExp('^\\$\\s*' + n + '\\s*\\.\\s*\\$\\s*'), '') // $6.$
    .replace(new RegExp('^\\$\\s*' + n + '\\s*\\$\\s*\\.\\s*'), '') // $19$.
    .replace(new RegExp('^\\$\\s*' + n + '\\s*\\.\\s*(?:\\\\[:,; ])?\\s*'), '$') // $1.\:\sqrt…
    .replace(new RegExp('^' + n + '\\s*[.)]\\s*'), '') // 7.
    .replace(
      /^\d{4}$/.test(displayNumber)
        ? new RegExp('^' + displayNumber + '\\s+')
        : /$^/,
      '',
    ) // 0012 다항식(교재의 네 자리 번호)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
async function readItemImage(image) {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await visionChat(image, ITEM_PROMPT, { maxTokens: 1500 })).text;
    } catch (error) {
      if (attempt >= 2 || !String(error.message).includes('429')) throw error;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// 숙제 등록용 판독(CLOVA OCR 설정 시). OCR로 쪽수·문항 번호·문항 영역을 찾고, 영어는 OCR 글을 그대로
// 쓴다. 수학은 OCR이 수식 구조를 잃으므로(√2×∛4 → V2×4) 문항 영역을 잘라 HCX-005로 다시 읽는다.
// 다시 읽기에 실패한 수학 문항은 보류하고 OCR 글을 교사 확인용 후보로 남긴다.
// 반환 모양은 readSheet과 같다({ detected, readingPasses, reads }).
// 문항 번호 줄("10")이 쪽 위 여백에 걸려 쪽 번호로 잡히지 않게 번호 줄을 빼고 쪽 번호를 찾는다.
function withoutItemNumbers(lines) {
  const numbered = new Set(
    (pickItemNumberLines(lines)?.picked ?? []).map((c) => c.line),
  );
  return lines.filter((l) => !numbered.has(l));
}

export async function readSheetService(source, subject) {
  const bytes =
    typeof source === 'string' ? await readFile(source) : source.bytes;
  const mime =
    typeof source === 'string'
      ? path.extname(source).toLowerCase() === '.png'
        ? 'image/png'
        : 'image/jpeg'
      : source.mime;
  const fields = await ocrImage({ bytes, mime });
  const lines = readingOrder(fieldsToLines(fields));
  const printedPage = findPrintedPage(withoutItemNumbers(lines));
  const items = segmentItems(lines);
  const regions = itemRegions(items, lines);
  const pageOf = printedPage ? { printedPage } : {};
  const detected = [];
  const reads = [
    {
      model: 'CLOVA OCR',
      text: lines.map((l) => l.text).join('\n'),
      usage: null,
    },
  ];
  for (const item of items) {
    const base = { displayNumber: item.displayNumber, ...pageOf };
    const region = regions.get(item);
    if (subject !== 'M') {
      detected.push({ ...base, text: item.text });
      continue;
    }
    try {
      if (!region) throw Error('문항 영역을 찾지 못함');
      const text = tidyItemReading(
        await readItemImage(await cropRegion(bytes, region)),
        item.displayNumber,
      );
      if (!text) throw Error('빈 판독');
      reads.push({ model: 'HCX-005', text, usage: null });
      detected.push({ ...base, text });
    } catch (error) {
      detected.push({
        ...base,
        text: '',
        holdReason:
          '문항 수식 판독 실패: ' + String(error.message).slice(0, 80),
      });
    }
  }
  return {
    detected,
    // 교사 확인용 후보에는 수학도 OCR 글을 함께 남긴다.
    readingPasses: [
      detected.map((d, k) => ({ ...d, text: d.text || items[k].text })),
    ],
    reads,
  };
}

// readSheet과 같은 모양({ detected, readingPasses, reads })을 돌려준다. OCR은 한 번 읽으므로
// readingPasses는 하나다. 수학 원문에서 선택지를 빼 보았지만(10월 수학) 분류 근거가 줄어
// 정확도가 떨어졌으므로 원문은 OCR이 읽은 그대로 둔다.
export async function readSheetOcr(source) {
  const fields = await ocrImage(source);
  const lines = readingOrder(fieldsToLines(fields));
  const printedPage = findPrintedPage(withoutItemNumbers(lines));
  const detected = segmentItems(lines).map(({ displayNumber, text }) => ({
    displayNumber,
    text,
  }));
  const withPage = detected.map((i) => ({
    ...i,
    ...(printedPage ? { printedPage } : {}),
  }));
  return {
    detected,
    readingPasses: [withPage],
    reads: [
      {
        model: 'CLOVA OCR',
        text: lines.map((l) => l.text).join('\n'),
        usage: null,
      },
    ],
  };
}

// 다른 판독기(예: PaddleOCR 문서 분석)가 만든 글·마크다운을 같은 방식으로 문항으로 나눈다.
// 위치 정보가 없으므로 판독기가 이미 단 순서를 맞춘 글을 받는다고 본다.
export function readSheetFromText(text) {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/<[^>]+>/g, ' ')
        .replace(/^\s*#+\s*/, '')
        .replace(/^\s*[-*]\s+(?=\d)/, '')
        .trimEnd(),
    )
    .filter((line) => line.trim())
    .map((line) => ({ text: line, x0: 0, x1: 0, y0: 0, y1: 0, confidence: 1 }));
  const detected = segmentItems(lines).map(({ displayNumber, text: body }) => ({
    displayNumber,
    text: body,
  }));
  return {
    detected,
    readingPasses: [detected],
    reads: [{ model: 'external', text, usage: null }],
  };
}
