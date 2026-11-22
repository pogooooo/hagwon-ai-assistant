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
