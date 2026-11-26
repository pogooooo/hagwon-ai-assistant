import {
  imageDimensions,
  imageMime,
} from '../rag-consultation/server/ingest/parsers/image.ts';
import { renderGradingPdf } from '../rag-consultation/server/ingest/parsers/pdf.ts';
import { GradingError, type Reading } from './contracts.ts';

export interface ImagePage {
  bytes: Uint8Array;
  mime: string;
  page_no: number;
}
type Size = { width: number; height: number };
type Crop = Size & { x: number; y: number };

export interface GradingMediaRuntime {
  maxPages: number;
  maxInputBytes: number;
  maxImagePixels: number;
  decodePhoto(bytes: Uint8Array): Promise<Uint8Array>;
  renderPdf(bytes: Uint8Array, remainingPages: number): Promise<Uint8Array[]>;
  crop(bytes: Uint8Array, region: Crop): Promise<Uint8Array>;
  mask(bytes: Uint8Array, regions: Crop[]): Promise<Uint8Array>;
  /** 영역마다 어두운 픽셀(펜·인쇄 자국) 수. 없는 런타임에서는 체크 표시 감지를 건너뛴다. */
  darkPixels?(bytes: Uint8Array, regions: Crop[]): Promise<number[]>;
}
let media: GradingMediaRuntime = {
  maxPages: 10,
  maxInputBytes: Infinity,
  maxImagePixels: 20_000_000,
  async decodePhoto(bytes) {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const scale = Math.min(1, 2200 / Math.max(image.width, image.height));
    const canvas = createCanvas(
      Math.round(image.width * scale),
      Math.round(image.height * scale),
    );
    try {
      canvas
        .getContext('2d')
        .drawImage(image, 0, 0, canvas.width, canvas.height);
      return new Uint8Array(canvas.toBuffer('image/png'));
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  },
  renderPdf: renderGradingPdf,
  async mask(bytes, regions) {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const canvas = createCanvas(image.width, image.height);
    try {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      ctx.fillStyle = '#fff';
      for (const r of regions) ctx.fillRect(r.x, r.y, r.width, r.height);
      return new Uint8Array(canvas.toBuffer('image/png'));
    } finally {
      canvas.width = canvas.height = 1;
    }
  },
  async darkPixels(bytes, regions) {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const canvas = createCanvas(image.width, image.height);
    try {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      return regions.map((r) => {
        const x = Math.max(0, Math.floor(r.x)),
          y = Math.max(0, Math.floor(r.y));
        const width = Math.min(image.width, Math.ceil(r.x + r.width)) - x,
          height = Math.min(image.height, Math.ceil(r.y + r.height)) - y;
        if (width <= 0 || height <= 0) return 0;
        const data = ctx.getImageData(x, y, width, height).data;
        let dark = 0;
        for (let o = 0; o < data.length; o += 4)
          if (0.3 * data[o] + 0.59 * data[o + 1] + 0.11 * data[o + 2] < 140)
            dark++;
        data.fill(0);
        return dark;
      });
    } finally {
      canvas.width = canvas.height = 1;
    }
  },
  async crop(bytes, { x, y, width, height }) {
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(bytes));
    const canvas = createCanvas(width, height);
    try {
      canvas
        .getContext('2d')
        .drawImage(image, x, y, width, height, 0, 0, width, height);
      return new Uint8Array(canvas.toBuffer('image/png'));
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  },
};
export function configureGradingMedia(runtime: GradingMediaRuntime) {
  media = runtime;
}
export function gradingMediaLimits(requestBytes = 20 * 1024 * 1024) {
  return {
    pages: media.maxPages,
    bytes: Math.min(requestBytes, media.maxInputBytes),
    pixels: media.maxImagePixels,
  };
}
export async function decodeUploads(
  files: { bytes: Uint8Array; mime: string }[],
  maxBytes = 20 * 1024 * 1024,
): Promise<ImagePage[]> {
  if (
    !files.length ||
    files.length > media.maxPages ||
    files.reduce((n, f) => n + f.bytes.length, 0) >
      Math.min(maxBytes, media.maxInputBytes)
  ) {
    throw new GradingError('UPLOAD_LIMIT', 413);
  }
  const result: ImagePage[] = [];
  try {
    for (const file of files) {
      const remainingPages = media.maxPages - result.length;
      if (remainingPages < 1) throw new GradingError('PAGE_LIMIT');
      if (new TextDecoder().decode(file.bytes.subarray(0, 5)) === '%PDF-') {
        if (file.mime !== 'application/pdf')
          throw new GradingError('MEDIA_MISMATCH');
        for (const bytes of await media.renderPdf(file.bytes, remainingPages))
          result.push({ bytes, mime: 'image/png', page_no: result.length + 1 });
      } else {
        const size = imageDimensions(file.bytes),
          mime = imageMime(file.bytes);
        if (
          !size ||
          !mime ||
          mime !== file.mime ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(mime)
        )
          throw new GradingError('UNSUPPORTED_MEDIA', 415);
        if (
          size.width < 32 ||
          size.height < 32 ||
          size.width * size.height > media.maxImagePixels ||
          Math.max(size.width / size.height, size.height / size.width) > 5
        )
          throw new GradingError('INPUT_UNREADABLE');
        result.push({
          bytes: await media.decodePhoto(file.bytes),
          mime: 'image/png',
          page_no: result.length + 1,
        });
      }
    }
  } catch (error) {
    for (const page of result) page.bytes.fill(0);
    if (error instanceof GradingError) throw error;
    throw new GradingError('INPUT_UNREADABLE');
  }
  return result;
}
export async function maskStudentAnswers(
  page: ImagePage,
  readings: Reading[],
): Promise<ImagePage | null> {
  const size = imageDimensions(page.bytes);
  if (!size) return null;
  const boxes = readings
    .flatMap((r) => r.regions.filter((b) => b.page_no === page.page_no))
    .flatMap(({ bbox }) => {
      if (
        !bbox.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
        bbox[2] <= bbox[0] ||
        bbox[3] <= bbox[1]
      )
        return [];
      const x = Math.max(0, Math.floor((bbox[0] - 0.012) * size.width)),
        y = Math.max(0, Math.floor((bbox[1] - 0.012) * size.height));
      return [
        {
          x,
          y,
          width:
            Math.min(size.width, Math.ceil((bbox[2] + 0.012) * size.width)) - x,
          height:
            Math.min(size.height, Math.ceil((bbox[3] + 0.012) * size.height)) -
            y,
        },
      ];
    });
  return boxes.length
    ? { ...page, bytes: await media.mask(page.bytes, boxes) }
    : null;
}
export async function verificationTiles(page: ImagePage): Promise<ImagePage[]> {
  const size = imageDimensions(page.bytes);
  if (!size || size.height < 450) return [page];
  const height = Math.ceil(size.height * 0.62);
  const tiles: ImagePage[] = [];
  try {
    for (const y of [0, size.height - height]) {
      tiles.push({
        ...page,
        bytes: await media.crop(page.bytes, {
          x: 0,
          y,
          width: size.width,
          height,
        }),
        mime: 'image/png',
      });
    }
    return tiles;
  } catch (error) {
    for (const tile of tiles) tile.bytes.fill(0);
    throw error;
  }
}

export async function cropAnswer(
  page: ImagePage,
  reading: Reading,
): Promise<ImagePage | null> {
  const region = reading.regions.find((r) => r.page_no === page.page_no);
  if (!region) return null;
  const size = imageDimensions(page.bytes);
  if (!size) throw new GradingError('INPUT_UNREADABLE');
  const [a, b, c, d] = region.bbox;
  const x = Math.floor(a * size.width),
    y = Math.floor(b * size.height);
  const width = Math.min(size.width - x, Math.ceil((c - a) * size.width));
  const height = Math.min(size.height - y, Math.ceil((d - b) * size.height));
  if (width < 8 || height < 8 || Math.max(width / height, height / width) > 5)
    return null;
  return {
    bytes: await media.crop(page.bytes, { x, y, width, height }),
    mime: 'image/png',
    page_no: page.page_no,
  };
}

export interface ChoiceGrid {
  /** 보기 기호 한 글자의 크기(픽셀). */
  width: number;
  height: number;
  /** ①~⑤ 기호의 왼쪽 위 위치(픽셀). OCR이 못 읽은 기호는 배치에서 추정한 위치다. */
  positions: { choice: number; x: number; y: number }[];
  /** OCR이 기호를 읽지 못한 보기. 펜 표시가 기호를 덮으면 읽히지 않는다. */
  unread: number[];
}
/**
 * 보기마다 어두운 픽셀이 중앙값보다 얼마나 많은지(초과량)를 본다. 인쇄된 보기 값의 잉크는 모든
 * 보기에 비슷하게 있으므로 중앙값으로 덜어 낸다. 초과량이 한 보기에만 뚜렷하면(10픽셀 이상,
 * 둘째의 3배 이상) 그 보기를 표시로 본다. 펜이 기호를 덮으면 OCR이 기호를 못 읽는데, OCR이
 * 그 기호를 읽었다면 두 신호가 어긋나므로 더 엄격하게(4배 이상) 본다. 아니면 null(교사 확인).
 */
export function pickMarkedChoice(
  scores: number[],
  unread: number[],
): number | null {
  if (scores.length < 3) return null;
  const middle = [...scores].sort((a, b) => a - b)[
    Math.floor(scores.length / 2)
  ];
  const order = scores
    .map((score, i) => ({ excess: score - middle, choice: i + 1 }))
    .sort((a, b) => b.excess - a.excess);
  const [top, second] = order;
  if (top.excess < 10) return null;
  const ratio = unread.includes(top.choice) ? 3 : 4;
  return top.excess >= ratio * Math.max(second.excess, 1) ? top.choice : null;
}
const circledChoices = ['①', '②', '③', '④', '⑤'];
/** 객관식 문항에서 학생이 펜으로 표시한 보기를 찾는다. 확정하지 못하면 null. */
export async function detectMarkedChoice(
  page: ImagePage,
  grid: ChoiceGrid,
): Promise<Reading | null> {
  if (!media.darkPixels) return null;
  const size = imageDimensions(page.bytes);
  if (!size) return null;
  // 체크 표시는 기호를 덮고 위쪽으로 삐친다. 기호 옆 인쇄 값은 일부만 들어오게 폭을 제한한다.
  const windows = grid.positions.map((p) => ({
    x: p.x - 0.4 * grid.width,
    y: p.y - 0.9 * grid.height,
    width: 1.8 * grid.width,
    height: 2.1 * grid.height,
  }));
  let scores: number[];
  try {
    scores = await media.darkPixels(page.bytes, windows);
  } catch {
    return null;
  }
  const choice = pickMarkedChoice(scores, grid.unread);
  if (choice === null) return null;
  const w = windows[choice - 1];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    item_ref: 'pending',
    answer_observed: circledChoices[choice - 1],
    unit_observed: '',
    answer_status: 'readable',
    association_status: 'matched',
    regions: [
      {
        page_no: page.page_no,
        bbox: [
          clamp(w.x / size.width),
          clamp(w.y / size.height),
          clamp((w.x + w.width) / size.width),
          clamp((w.y + w.height) / size.height),
        ],
      },
    ],
    ambiguity_codes: [],
  };
}
